import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The headless browser is not available in a test; every tick that reaches it fails the same way.
vi.mock("@cloudflare/puppeteer", () => ({
  default: { launch: vi.fn().mockRejectedValue(new Error("no browser in tests")) },
}));

import worker, { type Env } from "../src/index";

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fakeKv(): KVNamespace & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => void map.set(k, v),
    delete: async (k: string) => void map.delete(k),
  } as unknown as KVNamespace & { map: Map<string, string> };
}

const TOKEN = "test-token";
let kv: ReturnType<typeof fakeKv>;
let env: Env;

beforeEach(() => {
  kv = fakeKv();
  env = { UW_FRAME: kv, BROWSER: {} as Fetcher, INGEST_TOKEN: TOKEN };
});

function ingest(cam: string, body: Uint8Array, grabbedAt = "2026-10-18T00:30:00Z"): Promise<Response> {
  return worker.fetch(
    new Request(`https://uw.test/ingest?cam=${cam}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "image/jpeg", "X-Grabbed-At": grabbedAt },
      body: body as unknown as BodyInit,
    }),
    env
  );
}

const metaOf = (cam: string) => JSON.parse(kv.map.get(`meta:${cam}`) ?? "null");
const attemptOf = (cam: string) => JSON.parse(kv.map.get(`attempt:${cam}`) ?? "null");

describe("POST /ingest: the frame guard", () => {
  it("stores a real daylight frame", async () => {
    const res = await ingest("pensacola-sria-west-cam", fixture("daylight-pensacola.jpg"));
    expect(res.status).toBe(200);
    expect(metaOf("pensacola-sria-west-cam")).toMatchObject({ ok: true, source: "courier" });
    expect(kv.map.has("frame:pensacola-sria-west-cam")).toBe(true);
  });

  it("stores a real night frame with lights in it, and a real frame that is nearly black", async () => {
    expect((await ingest("deerfield-pier-cam", fixture("night-pier-lights.jpg"))).status).toBe(200);
    expect((await ingest("deerfield-spinner-uw", fixture("night-underwater-dark.jpg"))).status).toBe(200);
  });

  it("refuses YouTube's 12,815-byte black slate with a clear 422 and stores nothing", async () => {
    const res = await ingest("deerfield-surf-cam", fixture("black-slate-12815.jpg"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, id: "deerfield-surf-cam", error: "blank frame", reason: "blank", bytes: 12815 });
    expect(String(body.message)).toMatch(/black slate/);
    expect(kv.map.has("frame:deerfield-surf-cam")).toBe(false);
    expect(kv.map.has("meta:deerfield-surf-cam")).toBe(false);
    expect(attemptOf("deerfield-surf-cam")).toMatchObject({ ok: false, source: "courier" });
  });

  it("refuses a loading-spinner frame", async () => {
    const res = await ingest("pensacola-sria-west-cam", fixture("spinner-pensacola.jpg"));
    expect(res.status).toBe(422);
  });

  it("refuses a 20 KB black noise frame (it passed the old 20,000-byte floor)", async () => {
    const res = await ingest("deerfield-surf-cam", fixture("black-noise-20696.jpg"));
    expect(res.status).toBe(422);
  });

  it("a refused blank frame leaves the stored good frame and its meta exactly as they were", async () => {
    await ingest("pensacola-sria-west-cam", fixture("daylight-pensacola.jpg"), "2026-10-18T00:00:00Z");
    const frameBefore = kv.map.get("frame:pensacola-sria-west-cam");
    const metaBefore = kv.map.get("meta:pensacola-sria-west-cam");
    const res = await ingest("pensacola-sria-west-cam", fixture("spinner-pensacola.jpg"), "2026-10-18T01:00:00Z");
    expect(res.status).toBe(422);
    expect(kv.map.get("frame:pensacola-sria-west-cam")).toBe(frameBefore);
    expect(kv.map.get("meta:pensacola-sria-west-cam")).toBe(metaBefore);
    const cams = (await (await worker.fetch(new Request("https://uw.test/cams"), env)).json()) as {
      cams: { id: string; lastAttempt: { error: string; source: string } | null }[];
    };
    const row = cams.cams.find((c) => c.id === "pensacola-sria-west-cam")!;
    expect(row.lastAttempt?.source).toBe("courier");
    expect(row.lastAttempt?.error).toMatch(/blank frame/);
  });

  it("answers 400 with the reason for a body that is not a JPEG, and for a stub", async () => {
    const notJpeg = await ingest("deerfield-surf-cam", new Uint8Array(30_000).fill(9));
    expect(notJpeg.status).toBe(400);
    expect(await notJpeg.json()).toMatchObject({ ok: false, error: "bad body", reason: "not-jpeg", bytes: 30000 });
    const stub = new Uint8Array(3_000);
    stub[0] = 0xff;
    stub[1] = 0xd8;
    const res = await ingest("deerfield-surf-cam", stub);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "too-small" });
  });

  it("still answers 401 for a wrong token and 404 for an unknown cam", async () => {
    const bad = await worker.fetch(
      new Request("https://uw.test/ingest?cam=deerfield-surf-cam", { method: "POST", headers: { Authorization: "Bearer nope" }, body: fixture("daylight-pensacola.jpg") as unknown as BodyInit }),
      env
    );
    expect(bad.status).toBe(401);
    expect((await ingest("no-such-cam", fixture("daylight-pensacola.jpg"))).status).toBe(404);
  });
});

describe("the per-tick sweep of stored frames", () => {
  function seed(cam: string, frame: Uint8Array, source = "browser"): void {
    kv.map.set(`frame:${cam}`, b64(frame));
    kv.map.set(`meta:${cam}`, JSON.stringify({ id: cam, videoId: "x", grabbedAtUtc: "2026-10-17T22:02:14Z", ms: 11851, ok: true, source }));
  }

  it("clears a stored spinner frame (the 2026-10-17 state) and marks the cam not ok, and keeps a real frame", async () => {
    seed("pensacola-sria-west-cam", fixture("spinner-pensacola.jpg"));
    seed("deerfield-surf-cam", fixture("spinner-deerfield-surf.jpg"));
    seed("deerfield-pier-cam", fixture("night-pier-lights.jpg"), "courier");
    const res = await worker.fetch(new Request("https://uw.test/grab"), env); // the tick; the browser then fails
    const summary = (await res.json()) as { cleared: { id: string }[] };
    expect(summary.cleared.map((c) => c.id).sort()).toEqual(["deerfield-surf-cam", "pensacola-sria-west-cam"]);

    for (const cam of ["pensacola-sria-west-cam", "deerfield-surf-cam"]) {
      expect(kv.map.has(`frame:${cam}`)).toBe(false);
      expect(metaOf(cam)).toMatchObject({ ok: false });
      expect(metaOf(cam).error).toMatch(/cleared: blank frame/);
      expect((await worker.fetch(new Request(`https://uw.test/frame?cam=${cam}`), env)).status).toBe(404);
    }
    expect(metaOf("deerfield-pier-cam")).toMatchObject({ ok: true, source: "courier" });
    expect(kv.map.has("frame:deerfield-pier-cam")).toBe(true);
  });

  it("clears the legacy Spinner-cam keys with the cam", async () => {
    seed("deerfield-spinner-uw", fixture("black-underwater-night.jpg"));
    kv.map.set("frame:latest", kv.map.get("frame:deerfield-spinner-uw")!);
    kv.map.set("frame:meta", JSON.stringify({ grabbedAtUtc: "2026-10-18T00:00:39Z", bytes: 26910, width: 1280, height: 720 }));
    await worker.fetch(new Request("https://uw.test/grab"), env);
    expect(kv.map.has("frame:latest")).toBe(false);
    expect(kv.map.has("frame:meta")).toBe(false);
  });

  it("keeps a real night frame: dark is not blank", async () => {
    seed("deerfield-spinner-uw", fixture("night-underwater-dark.jpg"));
    kv.map.set("frame:latest", kv.map.get("frame:deerfield-spinner-uw")!);
    const res = await worker.fetch(new Request("https://uw.test/grab"), env);
    expect(((await res.json()) as { cleared: unknown[] }).cleared).toEqual([]);
    expect(metaOf("deerfield-spinner-uw")).toMatchObject({ ok: true });
    expect(kv.map.has("frame:latest")).toBe(true);
  });

  it("does not touch a cam whose meta is already not ok, or a frame it cannot check", async () => {
    kv.map.set("frame:fort-myers-beach-cam", b64(fixture("daylight-640-progressive.jpg")));
    kv.map.set(
      "meta:fort-myers-beach-cam",
      JSON.stringify({ id: "fort-myers-beach-cam", videoId: "x", grabbedAtUtc: "2026-10-17T22:02:14Z", ms: 0, ok: true, source: "courier" })
    );
    await worker.fetch(new Request("https://uw.test/grab"), env);
    expect(metaOf("fort-myers-beach-cam")).toMatchObject({ ok: true });
    expect(kv.map.has("frame:fort-myers-beach-cam")).toBe(true);
  });
});
