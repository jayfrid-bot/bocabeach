// history-cron: the every-minute tick still archives; the daily tick purges.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const ARCHIVE = "https://app.isitbeachday.com/api/history/archive";
const PURGE = "https://app.isitbeachday.com/api/cam-frames/purge";
const env = { CRON_SECRET: "cron-secret-test" };

type Call = { url: string; method: string | undefined; secret: string | null };
let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, secret: new Headers(init?.headers).get("x-cron-secret") });
      // An archive pass that did work, so the tick would loop if PASSES_PER_TICK > 1.
      return new Response(JSON.stringify({ archived: 1, claimed: 1 }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const at = (iso: string) => Date.parse(iso);
const tick = (scheduledTime: number, e: Record<string, string> = env) =>
  worker.scheduled({ cron: "* * * * *", scheduledTime } as ScheduledController, e as never);

const T_0816 = at("2026-10-12T08:16:00Z");
const T_0817 = at("2026-10-12T08:17:00Z");
const T_0818 = at("2026-10-12T08:18:00Z");

describe("scheduled", () => {
  it("an ordinary minute POSTs only the archive route, once, with the secret", async () => {
    await tick(at("2026-10-12T14:05:00Z"));
    expect(calls).toEqual([{ url: ARCHIVE, method: "POST", secret: env.CRON_SECRET }]);
  });

  it("the minutes either side of 08:17 UTC run only the archive", async () => {
    await tick(T_0816);
    await tick(T_0818);
    expect(calls.map((c) => c.url)).toEqual([ARCHIVE, ARCHIVE]);
  });

  it("08:17 on a different hour or 08:xx on a different minute does not purge", async () => {
    await tick(at("2026-10-12T20:17:00Z"));
    await tick(at("2026-10-12T07:17:00Z"));
    await tick(at("2026-10-12T08:47:00Z"));
    expect(calls.map((c) => c.url)).toEqual([ARCHIVE, ARCHIVE, ARCHIVE]);
  });

  it("the 08:17 UTC tick runs both: purge first, then archive, each with the secret", async () => {
    await tick(T_0817);
    expect(calls).toEqual([
      { url: PURGE, method: "POST", secret: env.CRON_SECRET },
      { url: ARCHIVE, method: "POST", secret: env.CRON_SECRET },
    ]);
  });

  it("08:17 UTC counts in UTC whatever the seconds are", async () => {
    await tick(at("2026-10-12T08:17:59Z"));
    expect(calls.map((c) => c.url)).toEqual([PURGE, ARCHIVE]);
  });

  it("a purge that fails (HTTP 500 or a thrown fetch) still runs the archive call", async () => {
    const f = fetch as unknown as ReturnType<typeof vi.fn>;
    f.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, secret: new Headers(init?.headers).get("x-cron-secret") });
      return url === PURGE ? new Response("boom", { status: 500 }) : new Response(JSON.stringify({ archived: 0, claimed: 0 }), { status: 200 });
    });
    await tick(T_0817);
    expect(calls.map((c) => c.url)).toEqual([PURGE, ARCHIVE]);

    calls = [];
    f.mockImplementation(async (url: string) => {
      calls.push({ url, method: "POST", secret: null });
      if (url === PURGE) throw new Error("network down");
      return new Response(JSON.stringify({ archived: 0, claimed: 0 }), { status: 200 });
    });
    await expect(tick(T_0817)).resolves.toBeUndefined();
    expect(calls.map((c) => c.url)).toEqual([PURGE, ARCHIVE]);
  });

  it("the purge runs once per tick even with PASSES_PER_TICK above 1", async () => {
    await tick(T_0817, { ...env, PASSES_PER_TICK: "3" });
    expect(calls.filter((c) => c.url === PURGE)).toHaveLength(1);
    expect(calls.filter((c) => c.url === ARCHIVE)).toHaveLength(3);
  });

  it("the archive path still honors PASSES_PER_TICK and the idle stop", async () => {
    await tick(T_0816, { ...env, PASSES_PER_TICK: "3" });
    expect(calls.map((c) => c.url)).toEqual([ARCHIVE, ARCHIVE, ARCHIVE]);
    calls = [];
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      calls.push({ url, method: "POST", secret: null });
      return new Response(JSON.stringify({ archived: 0, claimed: 0 }), { status: 200 });
    });
    await tick(T_0816, { ...env, PASSES_PER_TICK: "3" });
    expect(calls).toHaveLength(1);
  });

  it("without a secret nothing is called and nothing throws", async () => {
    await expect(tick(T_0817, {})).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("fetch (on-demand)", () => {
  const get = (path: string, secret = env.CRON_SECRET) =>
    worker.fetch(new Request(`https://x.test/${path}`, { headers: { "x-cron-secret": secret } }), env as never);

  it("401s without the secret", async () => {
    expect((await get("", "wrong")).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("runs the archive pass by default and the purge with ?task=purge", async () => {
    await get("");
    expect(calls.map((c) => c.url)).toEqual([ARCHIVE]);
    calls = [];
    await get("?task=purge");
    expect(calls.map((c) => c.url)).toEqual([PURGE]);
  });
});

describe("wrangler.jsonc", () => {
  it("keeps a single cron expression (Workers Free allows 5 per account)", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    expect(text).toContain('"crons": ["* * * * *"]');
  });
});
