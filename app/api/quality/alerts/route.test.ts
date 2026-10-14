// POST /api/quality/alerts — the cam reader's held-jump disagreement. Real SQLite
// for the three quality tables; the owner push is a recording fake.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import type { OwnerPush, OwnerPushResult } from "@/lib/quality/notify";
import { fakeBucket, type FakeBucket } from "@/lib/camFrames/testFixtures";
import { MAX_ALERT_BODY_BYTES } from "@/lib/quality/frameUpload";

const ctl = vi.hoisted(() => ({
  db: null as unknown,
  bucket: null as unknown,
  sent: [] as unknown[],
  result: { ok: true, sent: 1, failed: 0 } as unknown,
}));
vi.mock("@/lib/db/d1Store", () => ({ getD1: async () => ctl.db }));
vi.mock("@/lib/camFrames/r2", () => ({ getCamFramesBucket: async () => ctl.bucket }));
vi.mock("@/lib/quality/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/quality/notify")>()),
  sendOwnerPush: async (msg: OwnerPush): Promise<OwnerPushResult> => {
    ctl.sent.push(msg);
    return ctl.result as OwnerPushResult;
  },
}));

import { POST } from "@/app/api/quality/alerts/route";

const TOKEN = "test-ingest-token";
const NOW = Date.parse("2026-10-13T17:30:00.000Z"); // 1:30 PM EDT
const SHA = "ab".repeat(32);

const alertBody = (over: Record<string, unknown> = {}) => ({
  slug: "boca-raton",
  camId: "boca-inlet-surf",
  camName: "Boca Inlet Cam",
  observedAt: "2026-10-13T17:20:00Z",
  published: { level: "none", pct: 0 },
  claim: { level: "moderate", coveragePct: 35, note: "rock shelf", provider: "gemini", model: "gemini-2.5-flash" },
  secondOpinion: { provider: "clef", model: "m", level: "none", coveragePct: 0, note: null },
  others: [
    { id: "boca-south", name: "Boca South", level: "none", coveragePct: 0, carried: false },
    { id: "boca-south-surf", name: "South Surf", level: "none", coveragePct: 0, carried: false },
  ],
  frame: { sha256: SHA, archivedThisTick: true },
  ...over,
});

function post(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): Promise<Response> {
  return POST(
    new Request("http://localhost/api/quality/alerts", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

let h: CamDb;
let bucket: FakeBucket;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.INGEST_TOKEN = TOKEN;
  h = makeCamDb({ allMigrations: true }) as CamDb;
  ctl.db = h?.db ?? null;
  ctl.sent = [];
  ctl.result = { ok: true, sent: 1, failed: 0 };
  bucket = fakeBucket();
  ctl.bucket = bucket;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.INGEST_TOKEN;
  h?.close();
});

describe("auth and input", () => {
  it("503 without INGEST_TOKEN, 401 without the right bearer token", async () => {
    expect((await post(alertBody(), {})).status).toBe(401);
    expect((await post(alertBody(), { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post(alertBody(), { authorization: TOKEN })).status).toBe(401);
    delete process.env.INGEST_TOKEN;
    expect((await post(alertBody())).status).toBe(503);
    expect(ctl.sent).toEqual([]);
  });

  it("400 for a body that is not an object, and for each rejected field", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post([1])).status).toBe(400);
    const cases: [Record<string, unknown>, string][] = [
      [{ slug: "atlantis" }, "unknown-beach"],
      [{ camId: "Bad Cam" }, "bad-cam"],
      [{ observedAt: "never" }, "bad-time"],
      [{ claim: { level: "low" } }, "bad-claim"],
      [{ secondOpinion: { provider: "clef", level: "moderate" } }, "not-a-disagreement"],
      [{ secondOpinion: null }, "bad-second-opinion"],
    ];
    for (const [over, error] of cases) {
      const res = await post(alertBody(over));
      expect(res.status, error).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error });
    }
  });
});

describe.skipIf(!HAS_SQLITE)("storing and pushing", () => {
  it("503 with no database", async () => {
    ctl.db = null;
    expect((await post(alertBody())).status).toBe(503);
  });

  it("stores the alert and pushes the owner a plain line that opens the review screen", async () => {
    const res = await post(alertBody());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const out = (await res.json()) as { id: number };
    expect(out).toMatchObject({ ok: true, created: true, pushed: true, reason: "ok" });
    expect(ctl.sent).toEqual([
      {
        title: "Boca Raton",
        body: "Check: Boca Inlet cam says moderate seaweed (35%). Other cams: none.",
        url: `https://app.isitbeachday.com/admin/review?alert=${out.id}`,
        tag: `quality-${out.id}`,
      },
    ]);
    const row = h.all("SELECT slug, signal, kind, status, pushed, dedupe_key, created_at FROM quality_alerts")[0];
    expect(row).toEqual({
      slug: "boca-raton", signal: "seaweed", kind: "seaweed-held-disagreed", status: "open", pushed: 1,
      dedupe_key: `seaweed:boca-raton:boca-inlet-surf:${SHA.slice(0, 16)}`, created_at: "2026-10-13T17:30:00.000Z",
    });
    const payload = JSON.parse(h.all("SELECT payload_json FROM quality_alerts")[0].payload_json as string);
    expect(payload.others.map((o: { id: string }) => o.id)).toEqual(["boca-south", "boca-south-surf"]);
    expect(payload.secondOpinion.level).toBe("none");
  });

  it("a retry of the same frame stores and pushes nothing more", async () => {
    await post(alertBody());
    const again = await post(alertBody());
    expect(await again.json()).toMatchObject({ ok: true, created: false, pushed: false, reason: "exists" });
    expect(ctl.sent).toHaveLength(1);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(1);
  });

  it("a second frame from the same cam inside 3 hours is stored but not pushed", async () => {
    await post(alertBody());
    const res = await post(alertBody({ frame: { sha256: "cd".repeat(32), archivedThisTick: true }, observedAt: "2026-10-13T17:29:00Z" }));
    expect(await res.json()).toMatchObject({ created: true, pushed: false, reason: "duplicate" });
    expect(ctl.sent).toHaveLength(1);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(2);
  });

  it("at night it is stored and waits in the list", async () => {
    vi.setSystemTime(Date.parse("2026-10-14T03:00:00.000Z")); // 11 PM EDT
    const res = await post(alertBody({ observedAt: "2026-10-14T02:55:00Z" }));
    expect(await res.json()).toMatchObject({ created: true, pushed: false, reason: "quiet-hours" });
    expect(ctl.sent).toEqual([]);
  });

  it("when the phone cannot be reached the alert is still kept, as unpushed", async () => {
    ctl.result = { ok: false, sent: 0, failed: 0, reason: "no-owner" };
    const res = await post(alertBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: true, pushed: false, reason: "send-failed" });
    expect(h.all("SELECT pushed FROM quality_alerts")[0].pushed).toBe(0);
  });

  it("answers 500, not a stack trace, when the database fails", async () => {
    h.exec("DROP TABLE quality_alerts");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post(alertBody());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "store-unavailable" });
  });
});

describe.skipIf(!HAS_SQLITE)("the exact frame that was judged", () => {
  const jpegB64 = (n = 4000) => {
    const b = new Uint8Array(n).fill(9);
    b.set([0xff, 0xd8, 0xff]);
    let text = "";
    for (let i = 0; i < b.length; i += 8192) text += String.fromCharCode(...b.subarray(i, i + 8192));
    return btoa(text);
  };
  const withFrame = (b64: unknown = jpegB64()) => alertBody({ frame: { sha256: SHA, archivedThisTick: true, jpegB64: b64 } });
  const storedPayload = () => JSON.parse(h.all("SELECT payload_json FROM quality_alerts")[0].payload_json as string);

  it("keeps the shrunk image in R2 under quality/ and records its key in the alert", async () => {
    const res = await post(withFrame());
    expect(res.status).toBe(200);
    const keys = [...bucket.objects.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^quality\/boca-raton\/boca-inlet-surf\/2026-10-13\/172000Z-[0-9a-f]{8}\.jpg$/);
    expect(storedPayload().frame).toEqual({ sha256: SHA, archivedThisTick: true, r2Key: keys[0] });
    expect(JSON.stringify(storedPayload())).not.toContain("jpegB64"); // the picture is in R2, not in D1
    expect(bucket.objects.get(keys[0])!.bytes.length).toBe(4000);
  });

  it("with no image the alert is the same as before, with no key", async () => {
    await post(alertBody());
    expect(bucket.objects.size).toBe(0);
    expect(storedPayload().frame.r2Key).toBeNull();
  });

  it("a bad image is ignored and the alert still stands", async () => {
    for (const bad of ["not base64!!", btoa("tiny"), jpegB64(160 * 1024)]) {
      h.exec("DELETE FROM quality_alerts");
      const res = await post(withFrame(bad));
      expect(res.status).toBe(200);
      expect(storedPayload().frame.r2Key).toBeNull();
    }
    expect(bucket.objects.size).toBe(0);
  });

  it("no bucket, or a failing one, still stores the alert and pushes it, with no key", async () => {
    ctl.bucket = null;
    expect(await (await post(withFrame())).json()).toMatchObject({ ok: true, created: true, pushed: true });
    expect(storedPayload().frame.r2Key).toBeNull();
    h.exec("DELETE FROM quality_alerts");
    vi.spyOn(console, "error").mockImplementation(() => {});
    bucket.failPut = true;
    ctl.bucket = bucket;
    expect((await post(withFrame())).status).toBe(200);
    expect(storedPayload().frame.r2Key).toBeNull();
  });

  it("a retry of the same alert writes the same key again and no second alert", async () => {
    await post(withFrame());
    await post(withFrame());
    expect(bucket.objects.size).toBe(1);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(1);
  });

  it("413 for a body over the cap, before anything is stored", async () => {
    const res = await post(JSON.stringify({ ...alertBody(), pad: "x".repeat(MAX_ALERT_BODY_BYTES) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: "too-large" });
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(0);
  });

  it("a full-size frame fits inside the body cap", async () => {
    expect((await post(withFrame(jpegB64(150 * 1024)))).status).toBe(200);
    expect(bucket.objects.size).toBe(1);
  });
});
