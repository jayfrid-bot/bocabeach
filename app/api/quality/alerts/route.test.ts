// POST /api/quality/alerts — the cam reader's held-jump disagreement. Real SQLite for the
// quality tables. The route only RECORDS the alert and queues its push slot; the owner push
// itself is sent by the drain step (app/api/quality/drain), so APNs is never touched here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { fakeBucket, type FakeBucket } from "@/lib/camFrames/testFixtures";
import { MAX_ALERT_BODY_BYTES } from "@/lib/quality/frameUpload";

const ctl = vi.hoisted(() => ({
  db: null as unknown,
  bucket: null as unknown,
  apnsCalls: 0,
}));
vi.mock("@/lib/db/d1Store", () => ({ getD1: async () => ctl.db }));
vi.mock("@/lib/camFrames/r2", () => ({ getCamFramesBucket: async () => ctl.bucket }));
// If anything in this route reached for APNs, this would count it.
vi.mock("@/lib/push/apns", () => ({
  getApns: () => {
    ctl.apnsCalls += 1;
    return null;
  },
  openApnsSession: () => {
    ctl.apnsCalls += 1;
    throw new Error("the alert route must not talk to APNs");
  },
  isDeadToken: () => false,
}));

import { POST } from "@/app/api/quality/alerts/route";

const TOKEN = "test-quality-token";
const NOW = Date.parse("2026-10-13T17:30:00.000Z"); // 1:30 PM EDT
const SHA = "ab".repeat(32);

/** A body as the reader sends it. The claim's identity follows `frame` and `observedAt` unless a test sets `claimTarget`. */
const alertBody = (over: Record<string, unknown> = {}) => {
  const b: Record<string, unknown> = {
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
  };
  if (!("claimTarget" in over)) {
    const observed = Date.parse(b.observedAt as string);
    b.claimTarget = {
      frameSha: (b.frame as { sha256?: string }).sha256?.slice(0, 20) ?? null,
      frameAt: b.observedAt,
      claimedAt: Number.isFinite(observed) ? new Date(observed + 60_000).toISOString().replace(/\.\d+Z$/, "Z") : null,
    };
  }
  return b;
};

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
  process.env.QUALITY_INGEST_TOKEN = TOKEN;
  process.env.INGEST_TOKEN = "the-archive-token";
  h = makeCamDb({ allMigrations: true }) as CamDb;
  ctl.db = h?.db ?? null;
  ctl.apnsCalls = 0;
  bucket = fakeBucket();
  ctl.bucket = bucket;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.QUALITY_INGEST_TOKEN;
  delete process.env.INGEST_TOKEN;
  h?.close();
});

describe("auth and input", () => {
  it("503 without QUALITY_INGEST_TOKEN, 401 without the right bearer token", async () => {
    expect((await post(alertBody(), {})).status).toBe(401);
    expect((await post(alertBody(), { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post(alertBody(), { authorization: TOKEN })).status).toBe(401);
    delete process.env.QUALITY_INGEST_TOKEN;
    expect((await post(alertBody())).status).toBe(503);
  });

  it("the archive's INGEST_TOKEN does not open it: the credentials are split", async () => {
    expect((await post(alertBody(), { authorization: "Bearer the-archive-token" })).status).toBe(401);
    delete process.env.QUALITY_INGEST_TOKEN;
    expect((await post(alertBody(), { authorization: "Bearer the-archive-token" })).status).toBe(503);
  });

  it("400 for a body that is not an object, and for each rejected field", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post([1])).status).toBe(400);
    const cases: [Record<string, unknown>, string][] = [
      [{ slug: "atlantis" }, "unknown-beach"],
      [{ camId: "Bad Cam" }, "bad-cam"],
      [{ observedAt: "never" }, "bad-time"],
      [{ claim: { level: "low" } }, "bad-claim"],
      [{ claimTarget: { frameSha: SHA.slice(0, 20), frameAt: "2026-10-13T17:20:00Z" } }, "bad-claim-time"],
      [{ claimTarget: { frameSha: null, frameAt: null, claimedAt: "2026-10-13T17:21:00Z" } }, "unbound-claim"],
      [{ claimTarget: { frameSha: "ef".repeat(10), frameAt: "2026-10-13T17:20:00Z", claimedAt: "2026-10-13T17:21:00Z" } }, "claim-frame-mismatch"],
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

describe.skipIf(!HAS_SQLITE)("recording and queueing", () => {
  const slots = () => h.all("SELECT alert_id, state FROM quality_push_slots");

  it("503 with no database", async () => {
    ctl.db = null;
    expect((await post(alertBody())).status).toBe(503);
  });

  it("stores the alert with its exact claim identity and queues its push; it sends nothing itself", async () => {
    const res = await post(alertBody());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const out = (await res.json()) as { id: number };
    expect(out).toMatchObject({ ok: true, created: true, queued: true, reason: "queued" });
    expect(slots()).toEqual([{ alert_id: out.id, state: "queued" }]);
    expect(ctl.apnsCalls).toBe(0);
    const row = h.all("SELECT slug, signal, kind, status, pushed, dedupe_key, created_at FROM quality_alerts")[0];
    expect(row).toEqual({
      slug: "boca-raton", signal: "seaweed", kind: "seaweed-held-disagreed", status: "open", pushed: 0,
      dedupe_key: `seaweed:boca-raton:boca-inlet-surf:${SHA.slice(0, 16)}`, created_at: "2026-10-13T17:30:00.000Z",
    });
    const payload = JSON.parse(h.all("SELECT payload_json FROM quality_alerts")[0].payload_json as string);
    expect(payload.others.map((o: { id: string }) => o.id)).toEqual(["boca-south", "boca-south-surf"]);
    expect(payload.secondOpinion.level).toBe("none");
    expect(payload.claimTarget).toEqual({ frameSha: SHA.slice(0, 20), frameAt: "2026-10-13T17:20:00Z", claimedAt: "2026-10-13T17:21:00Z" });
    expect(payload.localDate).toBe("2026-10-13");
  });

  it("a retry of the same frame stores and queues nothing more", async () => {
    await post(alertBody());
    const again = await post(alertBody());
    expect(await again.json()).toMatchObject({ ok: true, created: false, queued: false, reason: "exists" });
    expect(slots()).toHaveLength(1);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(1);
  });

  it("a second frame from the same cam inside 3 hours is stored but takes no push slot", async () => {
    await post(alertBody());
    const res = await post(alertBody({ frame: { sha256: "cd".repeat(32), archivedThisTick: true }, observedAt: "2026-10-13T17:29:00Z" }));
    expect(await res.json()).toMatchObject({ created: true, queued: false, reason: "duplicate" });
    expect(slots()).toHaveLength(1);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(2);
  });

  it("at night it is stored and waits in the list, with no slot", async () => {
    vi.setSystemTime(Date.parse("2026-10-14T03:00:00.000Z")); // 11 PM EDT
    const res = await post(alertBody({ observedAt: "2026-10-14T02:55:00Z" }));
    expect(await res.json()).toMatchObject({ created: true, queued: false, reason: "quiet-hours" });
    expect(slots()).toEqual([]);
  });

  it("429 once a beach has made 20 alerts in an hour, and nothing more is written", async () => {
    for (let i = 0; i < 20; i++) {
      const sha = i.toString(16).padStart(2, "0").repeat(32);
      expect((await post(alertBody({ frame: { sha256: sha, archivedThisTick: false }, observedAt: `2026-10-13T17:${String(i).padStart(2, "0")}:00Z` }))).status).toBe(200);
    }
    const over = await post(alertBody({ frame: { sha256: "ff".repeat(32), archivedThisTick: false }, observedAt: "2026-10-13T17:25:00Z" }));
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("3600");
    expect(await over.json()).toEqual({ ok: false, error: "rate-limited" });
    expect(h.all("SELECT COUNT(*) AS n FROM quality_alerts")[0].n).toBe(20);
    // a retry of one that is already stored is still a harmless duplicate, not a 429
    const dup = await post(alertBody({ frame: { sha256: "00".repeat(32), archivedThisTick: false }, observedAt: "2026-10-13T17:00:00Z" }));
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ created: false, reason: "exists" });
    // another beach is not limited
    expect((await post(alertBody({ slug: "deerfield-beach", camId: "deerfield-beach-cam" }))).status).toBe(200);
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

  it("no bucket, or a failing one, still stores the alert and queues it, with no key", async () => {
    ctl.bucket = null;
    expect(await (await post(withFrame())).json()).toMatchObject({ ok: true, created: true, queued: true });
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
