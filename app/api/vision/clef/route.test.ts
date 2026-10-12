// POST /api/vision/clef. The Workers AI binding and KV are fakes; the answers
// are real cached backtest replies, so the route is checked end to end against
// the numbers the backtest produced.

import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ctl = vi.hoisted(() => ({ env: {} as Record<string, unknown>, db: null as unknown }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: async () => ({ env: ctl.env }) }));
vi.mock("@/lib/db/d1Store", () => ({ getD1: async () => ctl.db }));

import { POST } from "@/app/api/vision/clef/route";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import type { D1Like } from "@/lib/db/d1Store";
import { CLEF_MODEL } from "@/lib/vision/clef";
import { resetFirstSuccessLog } from "@/lib/vision/firstSuccessLog";

const TOKEN = "test-ingest-token";
const CACHE = path.join(process.cwd(), "docs", "benchmarks", "clef-vision-2026-10-12", "cache");
const cached = (prefix: string) => {
  const f = fs.readdirSync(CACHE).find((x) => x.startsWith("clef_" + prefix) && !x.endsWith(".err.json"));
  if (!f) throw new Error("no cache for " + prefix);
  return JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8")) as { answers: Record<string, unknown>; tokens: number };
};
const BEACH = cached("boca-inlet-jetty_2026-10-11_1059Z");
const SPINNER = cached("deerfield-spinner-uw_2026-10-11_1007Z");

// base64 starting with the JPEG signature, long enough to pass the length check
const IMAGE = "/9j/" + "A".repeat(2000);

function fakeAi(result: unknown | (() => unknown)) {
  return {
    run: vi.fn(async (_model: string, _input: unknown) => {
      const r = typeof result === "function" ? (result as () => unknown)() : result;
      if (r instanceof Error) throw r;
      return r;
    }),
  };
}

function req(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): Request {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/api/vision/clef", { method: "POST", headers, body: text });
}

const good = { kind: "surface", image: IMAGE };

let h: CamDb | null = null;
const callsToday = () => (h?.all("SELECT count FROM vision_daily_calls")[0]?.count ?? 0) as number;

beforeEach(() => {
  h = HAS_SQLITE ? makeCamDb({ files: ["0018_vision_daily_cap.sql"] }) : null;
  ctl.db = h?.db ?? null;
  resetFirstSuccessLog();
  process.env.INGEST_TOKEN = TOKEN;
  ctl.env = { AI: fakeAi({ answers: BEACH.answers, usage: { input_tokens: BEACH.tokens } }) };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("auth and bindings", () => {
  it("503 when INGEST_TOKEN is unset", async () => {
    delete process.env.INGEST_TOKEN;
    expect((await POST(req(good))).status).toBe(503);
  });
  it("401 with no, wrong, or malformed bearer", async () => {
    expect((await POST(req(good, {}))).status).toBe(401);
    expect((await POST(req(good, { authorization: "Bearer nope" }))).status).toBe(401);
    expect((await POST(req(good, { authorization: TOKEN }))).status).toBe(401);
  });
  it("never calls the model when unauthorized", async () => {
    await POST(req(good, { authorization: "Bearer nope" }));
    expect((ctl.env.AI as ReturnType<typeof fakeAi>).run).not.toHaveBeenCalled();
  });
  it("503 when the AI binding is absent", async () => {
    ctl.env = {};
    const res = await POST(req(good));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("request checks", () => {
  it("413 on a declared body over 400 KB", async () => {
    const r = new Request("http://localhost/api/vision/clef", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-length": String(400 * 1024 + 1) },
      body: "{}",
    });
    expect((await POST(r)).status).toBe(413);
  });
  it("413 on a streamed body over 400 KB", async () => {
    const big = JSON.stringify({ kind: "surface", image: "/9j/" + "A".repeat(401 * 1024) });
    expect((await POST(req(big))).status).toBe(413);
    expect((ctl.env.AI as ReturnType<typeof fakeAi>).run).not.toHaveBeenCalled();
  });
  it("400 on an empty body, bad JSON, bad kind, missing or non-base64 image, non-JPEG", async () => {
    expect((await POST(req(""))).status).toBe(400);
    expect((await POST(req("{nope"))).status).toBe(400);
    expect((await POST(req({ kind: "other", image: IMAGE }))).status).toBe(400);
    expect((await POST(req({ kind: "surface" }))).status).toBe(400);
    expect((await POST(req({ kind: "surface", image: "not base64 !!" + "A".repeat(200) }))).status).toBe(400);
    const png = await POST(req({ kind: "surface", image: "iVBORw0KGgo" + "A".repeat(2000) }));
    expect(png.status).toBe(400);
    expect(((await png.json()) as { error: string }).error).toBe("not-a-jpeg");
    expect((ctl.env.AI as ReturnType<typeof fakeAi>).run).not.toHaveBeenCalled();
  });
});

describe("a surface read", () => {
  it("returns the assess() shape plus provider, model, usage and latency", async () => {
    const res = await POST(req(good));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const j = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual(
      [
        "ok", "kind", "level", "coveragePct", "note", "crowd", "crowdPct", "people", "crowdNote",
        "water", "waterPct", "waterNote", "unreadable", "unreadableP", "provider", "model", "usage", "latencyMs",
      ].sort(),
    );
    expect(j).toMatchObject({
      ok: true,
      kind: "surface",
      level: "low", // boca-inlet-jetty 2026-10-11 1059Z in the backtest cache
      crowd: "empty",
      water: null, // Clef said "unknown"
      provider: "clef",
      model: "@cf/cloudflare/clef",
      usage: { inputTokens: BEACH.tokens },
    });
    expect(typeof j.latencyMs).toBe("number");
    expect(j.unreadable).toBe(false); // noul 0.4982
  });

  it("sends the model the backtest request for a surface frame", async () => {
    await POST(req(good));
    const run = (ctl.env.AI as ReturnType<typeof fakeAi>).run;
    expect(run).toHaveBeenCalledTimes(1);
    const [model, input] = run.mock.calls[0] as [string, { images: string[]; questions: Record<string, unknown>; state: { task: string } }];
    expect(model).toBe(CLEF_MODEL);
    expect(input.images).toEqual(["data:image/jpeg;base64," + IMAGE]);
    expect(Object.keys(input.questions)).toEqual(["seaweed", "seaweed_pct", "crowd", "crowd_pct", "people", "water", "water_pct", "unreadable"]);
    expect(input.state.task).toContain("beach webcam");
  });

  it("accepts the REST-wrapped result shape too", async () => {
    ctl.env = { AI: fakeAi({ result: { answers: BEACH.answers, usage: { input_tokens: 5 } }, success: true }) };
    const j = (await (await POST(req(good))).json()) as { usage: { inputTokens: number } };
    expect(j.usage.inputTokens).toBe(5);
  });
});

describe("an underwater read", () => {
  it("returns level/pct/note and the unreadable flag", async () => {
    ctl.env = { AI: fakeAi({ answers: SPINNER.answers, usage: { input_tokens: SPINNER.tokens } }) };
    const res = await POST(req({ kind: "underwater", image: IMAGE }));
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual(
      ["ok", "kind", "level", "pct", "note", "unreadable", "unreadableP", "provider", "model", "usage", "latencyMs"].sort(),
    );
    expect(j).toMatchObject({ kind: "underwater", level: "murky", unreadable: true, provider: "clef" });
    const run = (ctl.env.AI as ReturnType<typeof fakeAi>).run;
    const input = run.mock.calls[0][1] as { questions: Record<string, unknown> };
    expect(Object.keys(input.questions)).toEqual(["uw_clarity", "uw_pct", "unreadable"]);
  });
});

describe("failures never invent a value", () => {
  it("502 when the model throws", async () => {
    ctl.env = { AI: fakeAi(new Error("AiError: 5006")) };
    const res = await POST(req(good));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("model-error");
  });
  it("502 when the answers are missing a field", async () => {
    const { people: _p, ...rest } = BEACH.answers;
    ctl.env = { AI: fakeAi({ answers: rest }) };
    const res = await POST(req(good));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("unparseable-answer");
  });
  it("502 on malformed probabilities, an out-of-range noul, an out-of-band key, or success:false", async () => {
    const mutate = (f: (a: Record<string, any>) => void) => {
      const a = structuredClone(BEACH.answers) as Record<string, any>;
      f(a);
      return a;
    };
    const bad: unknown[] = [
      { answers: mutate((a) => { a.unreadable.noul = 1.5; }) },
      { answers: mutate((a) => { a.unreadable.noul = Number.NaN; }) },
      { answers: mutate((a) => { a.crowd.probabilities.empty = 3; }) },
      { answers: mutate((a) => { a.people.probabilities["9"] = 0.1; }) },
      { answers: mutate((a) => { a.people.score = 99; }) },
      { success: false, result: { answers: BEACH.answers } },
    ];
    for (const result of bad) {
      ctl.env = { AI: fakeAi(result) };
      const res = await POST(req(good));
      expect(res.status, JSON.stringify(result).slice(0, 60)).toBe(502);
      expect(((await res.json()) as { error: string }).error).toBe("unparseable-answer");
    }
  });
  it("502 when the result has no answers at all", async () => {
    ctl.env = { AI: fakeAi({}) };
    expect((await POST(req(good))).status).toBe(502);
    ctl.env = { AI: fakeAi(null) };
    expect((await POST(req(good))).status).toBe(502);
  });
  it("502 on an underwater reply with a bad word", async () => {
    ctl.env = { AI: fakeAi({ answers: { ...SPINNER.answers, uw_clarity: { type: "choice", choice: "foggy" } } }) };
    expect((await POST(req({ kind: "underwater", image: IMAGE }))).status).toBe(502);
  });
});

describe.skipIf(!HAS_SQLITE)("daily budget guard (real SQLite)", () => {
  it("429 {reason:'daily-cap'} once 600 calls are used, with Retry-After, and the model is not called", async () => {
    h!.exec(`INSERT INTO vision_daily_calls (day, model, count) VALUES ('${new Date().toISOString().slice(0, 10)}', '${CLEF_MODEL}', 600)`);
    const ai = fakeAi({ answers: BEACH.answers });
    ctl.env = { AI: ai };
    const res = await POST(req(good));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ ok: false, reason: "daily-cap" });
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(ai.run).not.toHaveBeenCalled();
    expect(callsToday()).toBe(600);
  });
  it("counts each call that reaches the model", async () => {
    await POST(req(good));
    await POST(req(good));
    expect(callsToday()).toBe(2);
  });
  it("a rejected (malformed) request does not use the allowance", async () => {
    await POST(req({ kind: "nope", image: IMAGE }));
    expect(callsToday()).toBe(0);
    await POST(req(good));
    expect(callsToday()).toBe(1);
  });
  it("a failed model call still counts (it can still be billed)", async () => {
    ctl.env = { AI: fakeAi(new Error("boom")) };
    await POST(req(good));
    expect(callsToday()).toBe(1);
  });
  it("503 when the DB throws (fail closed), model not called", async () => {
    const ai = fakeAi({ answers: BEACH.answers });
    ctl.env = { AI: ai };
    ctl.db = { prepare: () => { throw new Error("down"); } } as D1Like;
    const res = await POST(req(good));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "cap-unavailable" });
    expect(ai.run).not.toHaveBeenCalled();
  });
});

describe("daily budget guard fails closed without a DB", () => {
  it("503 and the model is not called when the DB binding is missing (production must not run unguarded)", async () => {
    const ai = fakeAi({ answers: BEACH.answers });
    ctl.env = { AI: ai };
    ctl.db = null;
    const res = await POST(req(good));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, reason: "cap-unavailable" });
    expect(ai.run).not.toHaveBeenCalled();
  });
});

describe("first-success log", () => {
  it("writes one JSON line per UTC day with only model, kind, latency and tokens", async () => {
    if (!HAS_SQLITE) return;
    const log = vi.mocked(console.log);
    log.mockClear();
    await POST(req(good));
    await POST(req(good));
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("clef-first-success"));
    expect(lines).toHaveLength(1); // two reads, one line
    for (const l of lines) {
      const j = JSON.parse(l) as Record<string, unknown>;
      expect(Object.keys(j).sort()).toEqual(["day", "event", "inputTokens", "kind", "latencyMs", "model"]);
      expect(l).not.toContain(IMAGE);
      expect(l).not.toContain(TOKEN);
    }
  });
});
