// The owner-only quality routes: enroll, check, list, answer, report, push-token. Real SQLite for the
// quality tables and owner sessions; the owner check runs for real. A device id is never a credential.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { getStore } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import { resetMemoryRateLimit } from "@/lib/plus/rateLimit";
import { OWNER_HEADERS } from "@/lib/quality/ownerHeaders";
import { insertAlert } from "@/lib/quality/store";
import { insertFrame, insertHourly, seedOwnerSession } from "@/lib/quality/testHelpers";

const ctl = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db/d1Store", () => ({ getD1: async () => ctl.db }));

import { POST as enroll } from "@/app/api/quality/owner/enroll/route";
import { POST as check } from "@/app/api/quality/owner/check/route";
import { POST as list } from "@/app/api/quality/owner/list/route";
import { POST as answer } from "@/app/api/quality/owner/answer/route";
import { POST as report } from "@/app/api/quality/owner/report/route";
import { POST as pushToken } from "@/app/api/quality/owner/push-token/route";

const CODE = "enrol-code-0123456789abcdef";
const SHA = "ab".repeat(32);
const NOW = Date.parse("2026-10-13T17:45:00.000Z");

type Route = (req: Request) => Promise<Response>;
function call(route: Route, body: Record<string, unknown> | null, headers: Record<string, string> = {}): Promise<Response> {
  return route(
    new Request("http://localhost/api/quality/owner/x", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === null ? null : JSON.stringify(body),
    }),
  );
}

let h: CamDb;
let token = "";
const asOwner = (route: Route, body: Record<string, unknown> | null = {}) => call(route, body, { authorization: `Bearer ${token}` });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.OWNER_ENROLL_CODE = CODE;
  process.env.CAM_FRAME_URL_KEY = "test-signing-key";
  resetMemoryStore();
  resetMemoryRateLimit();
  h = makeCamDb({ allMigrations: true }) as CamDb;
  ctl.db = h?.db ?? null;
  if (h) token = (await seedOwnerSession(h.db, { nowMs: NOW })).token;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.OWNER_ENROLL_CODE;
  delete process.env.CAM_FRAME_URL_KEY;
  h?.close();
});

describe("every owner route is closed to everyone else", () => {
  const routes: [string, Route, Record<string, unknown>][] = [
    ["check", check, {}],
    ["list", list, {}],
    ["answer", answer, { alertId: 1, verdict: "right" }],
    ["report", report, { slug: "boca-raton", seaweed: "low" }],
    ["push-token", pushToken, { token: "ab".repeat(32), platform: "ios" }],
  ];

  for (const [name, route, extra] of routes) {
    it.skipIf(!HAS_SQLITE)(`${name}: refuses no token, a wrong token, a device id in place of one, and a revoked session`, async () => {
      expect((await call(route, extra)).status).toBe(401);
      expect((await call(route, extra, { authorization: "Bearer nope" })).status).toBe(401);
      expect((await call(route, extra, { authorization: `Bearer ${"a".repeat(43)}` })).status).toBe(401);
      // the old proof: a device id with an install token
      const old = await call(route, { deviceId: "11111111-2222-4333-8444-555555555555", ...extra }, { "x-install-token": "anything" });
      expect(old.status).toBe(401);
      h.exec("UPDATE owner_sessions SET revoked = 1");
      expect((await asOwner(route, extra)).status).toBe(401);
    });

    it.skipIf(!HAS_SQLITE)(`${name}: every answer, refusal or not, carries the no-framing headers`, async () => {
      for (const res of [await call(route, extra), await asOwner(route, extra)]) {
        for (const [k, v] of Object.entries(OWNER_HEADERS)) expect(res.headers.get(k), `${name} ${k}`).toBe(v);
        expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
        expect(res.headers.get("x-frame-options")).toBe("DENY");
      }
    });
  }

  it.skipIf(!HAS_SQLITE)("a refused request writes nothing", async () => {
    await call(report, { slug: "boca-raton", seaweed: "low" }, { authorization: "Bearer nope" });
    expect(h.all("SELECT COUNT(*) AS n FROM quality_labels")[0].n).toBe(0);
  });

  it.skipIf(!HAS_SQLITE)("a stranger's body is never read: the check comes first", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(1024));
        if (pulled > 50) c.close();
      },
    });
    const req = new Request("http://x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect((await list(req)).status).toBe(401);
    expect(pulled).toBeLessThan(5);
  });

  it.skipIf(!HAS_SQLITE)("an enrolled owner's oversized body is cut off at the cap while it streams (413), with no Content-Length to trust", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(1024).fill(0x20));
        if (pulled > 300) c.close();
      },
    });
    const req = new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: stream, duplex: "half" } as RequestInit);
    const res = await report(req);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: "too-large" });
    expect(pulled).toBeLessThan(20);
  });

  it.skipIf(!HAS_SQLITE)("a body that is not a JSON object is a 400", async () => {
    const res = await route400();
    expect(res.status).toBe(400);
  });
  const route400 = () =>
    answer(new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "[1,2]" }));

  it("503 with no database", async () => {
    ctl.db = null;
    for (const [, route, extra] of routes) expect((await asOwner(route, extra)).status).toBe(503);
  });
});

describe.skipIf(!HAS_SQLITE)("enroll", () => {
  it("trades the right code for a token that then opens the owner area; the token is shown once", async () => {
    const res = await call(enroll, { code: CODE, deviceId: "dev-1" });
    expect(res.status).toBe(200);
    for (const [k, v] of Object.entries(OWNER_HEADERS)) expect(res.headers.get(k)).toBe(v);
    const out = (await res.json()) as { ok: boolean; token: string };
    expect(out).toEqual({ ok: true, token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect((await call(check, {}, { authorization: `Bearer ${out.token}` })).status).toBe(200);
    expect(JSON.stringify(h.all("SELECT * FROM owner_sessions"))).not.toContain(out.token);
  });

  it("refuses a wrong code, and a code in the URL is not a code", async () => {
    const bad = await call(enroll, { code: "wrong-code-0123456789abcdef" });
    expect(bad.status).toBe(403);
    expect(await bad.json()).toEqual({ ok: false, error: "bad-code" });
    const viaUrl = await enroll(new Request(`http://localhost/api/quality/owner/enroll?code=${CODE}`, { method: "POST" }));
    expect(viaUrl.status).toBe(403);
    expect(h.all("SELECT COUNT(*) AS n FROM owner_sessions")[0].n).toBe(1); // only the seeded one
  });

  it("is rate limited and closed without the secret", async () => {
    for (let i = 0; i < 5; i++) await call(enroll, { code: `guess-${i}-0123456789abcdef` });
    expect((await call(enroll, { code: CODE })).status).toBe(429);
    resetMemoryRateLimit();
    delete process.env.OWNER_ENROLL_CODE;
    expect((await call(enroll, { code: CODE })).status).toBe(503);
  });

  it("rotating the secret stops the old code from enrolling anyone new, and leaves a session already made alone", async () => {
    process.env.OWNER_ENROLL_CODE = "a-brand-new-code-0123456789";
    expect((await call(enroll, { code: CODE })).status).toBe(403);
    expect((await asOwner(check, {})).status).toBe(200);
  });
});

describe.skipIf(!HAS_SQLITE)("check", () => {
  it("tells an enrolled phone it is the owner", async () => {
    const res = await asOwner(check);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, owner: true });
  });
});

describe.skipIf(!HAS_SQLITE)("push-token: owner pushes go only to the phone that enrolled", () => {
  const T = "ab".repeat(32);

  it("stores the APNs token on the owner's session, lower-cased, and replaces it on the next call", async () => {
    expect(await (await asOwner(pushToken, { token: T.toUpperCase(), platform: "ios" })).json()).toEqual({ ok: true });
    expect(h.all("SELECT push_token FROM owner_sessions")[0].push_token).toBe(T);
    await asOwner(pushToken, { token: "cd".repeat(32), platform: "ios" });
    expect(h.all("SELECT push_token FROM owner_sessions")[0].push_token).toBe("cd".repeat(32));
  });

  it("refuses a bad token, a wrong platform, and a missing field, and keeps the old token", async () => {
    await asOwner(pushToken, { token: T, platform: "ios" });
    for (const bad of [{ token: "short", platform: "ios" }, { token: T, platform: "android" }, { token: T }, { platform: "ios" }, { token: 5, platform: "ios" }, { token: `${T}zz`, platform: "ios" }]) {
      expect((await asOwner(pushToken, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(h.all("SELECT push_token FROM owner_sessions")[0].push_token).toBe(T);
  });

  it("only touches the caller's own session", async () => {
    const other = await seedOwnerSession(h.db, { pushToken: "ee".repeat(32), nowMs: NOW });
    await asOwner(pushToken, { token: T, platform: "ios" });
    expect(h.all("SELECT push_token FROM owner_sessions WHERE id = ?", other.id)[0].push_token).toBe("ee".repeat(32));
  });

  it("a request whose session is revoked while its body is read changes nothing and says 401", async () => {
    // The replacement session (same device re-enrolled) holds the token.
    const replacement = await seedOwnerSession(h.db, { pushToken: T, nowMs: NOW });
    const enc = new TextEncoder().encode(JSON.stringify({ token: T, platform: "ios" }));
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        h.exec(`UPDATE owner_sessions SET revoked = 1 WHERE id != ${replacement.id}`); // the old session is revoked mid-request
        c.enqueue(enc);
        c.close();
      },
    });
    const res = await pushToken(
      new Request("http://localhost/api/quality/owner/push-token", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body,
        // @ts-expect-error Node's fetch needs this for a streamed request body
        duplex: "half",
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    expect(h.all("SELECT id, push_token FROM owner_sessions WHERE revoked = 0")).toEqual([{ id: replacement.id, push_token: T }]);
  });

  it("a stranger cannot replace it, and the general push registration is never the owner's destination", async () => {
    await asOwner(pushToken, { token: T, platform: "ios" });
    expect((await call(pushToken, { token: "ff".repeat(32), platform: "ios" })).status).toBe(401);
    // someone registers an iPhone through the general route, even under a device id: nothing about the session changes
    await (await getStore()).upsertDevice("11111111-2222-4333-8444-555555555555", { platform: "ios", pushToken: "dd".repeat(32) });
    expect(h.all("SELECT push_token FROM owner_sessions")[0].push_token).toBe(T);
  });
});

describe.skipIf(!HAS_SQLITE)("list", () => {
  it("returns open alerts with a signed picture link, and nothing a visitor could use", async () => {
    await insertFrame(h.db, { sha256: SHA, at: "2026-10-13T17:21:00.000Z" });
    await insertAlert(h.db, {
      slug: "boca-raton", signal: "seaweed", kind: "seaweed-held-disagreed", createdAt: "2026-10-13T17:30:00.000Z", dedupeKey: "a",
      payload: {
        camId: "boca-inlet-surf", camName: "Boca Inlet Cam", observedAt: "2026-10-13T17:20:00.000Z", published: { level: "none", pct: 0 },
        claim: { level: "moderate", coveragePct: 35, note: null, provider: "gemini", model: null },
        secondOpinion: { provider: "clef", model: null, level: "none", coveragePct: 0, note: null },
        others: [{ id: "b", name: "Boca South", level: "none", coveragePct: 0, carried: false }],
        claimTarget: { frameSha: SHA.slice(0, 20), frameAt: null, claimedAt: "2026-10-13T17:21:00Z" }, localDate: "2026-10-13",
        frame: { sha256: SHA, archivedThisTick: true },
      },
    });
    const res = await asOwner(list);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { now: string; open: { statement: string; frames: { url: string; exact: boolean }[] }[]; recent: unknown[] };
    expect(out.now).toBe("2026-10-13T17:45:00.000Z");
    expect(out.open[0].statement).toBe("Boca Inlet cam says moderate seaweed (35%)");
    expect(out.open[0].frames[0].exact).toBe(true);
    expect(out.open[0].frames[0].url).toMatch(/^\/api\/cam-frames\/img\?k=boca-raton%2Fboca-inlet-surf/);
    expect(JSON.stringify(out)).not.toContain(token);
    expect(out.recent).toEqual([]);
  });

  it("is empty, not an error, when there are no alerts", async () => {
    expect(await (await asOwner(list)).json()).toMatchObject({ ok: true, open: [], recent: [] });
  });
});

describe.skipIf(!HAS_SQLITE)("answer", () => {
  async function seed(over: Record<string, unknown> = {}): Promise<number> {
    return (
      await insertAlert(h.db, {
        slug: "boca-raton", signal: "seaweed", kind: "seaweed-held-disagreed", createdAt: "2026-10-13T17:30:00.000Z", dedupeKey: `a${Math.random()}`,
        payload: {
          camId: "boca-inlet-surf", camName: "Boca Inlet Cam", observedAt: "2026-10-13T17:20:00.000Z", published: null,
          claim: { level: "moderate", coveragePct: 35, note: null, provider: "gemini", model: null },
          secondOpinion: { provider: "clef", model: null, level: "none", coveragePct: 0, note: null },
          others: [], claimTarget: { frameSha: SHA.slice(0, 20), frameAt: null, claimedAt: "2026-10-13T17:21:00Z" }, localDate: "2026-10-13",
          frame: { sha256: null, archivedThisTick: false }, ...over,
        },
      })
    ).id;
  }

  it("Wrong with none: a reject bound to that exact claim, in one step with the label and the closed alert", async () => {
    const id = await seed();
    const res = await asOwner(answer, { alertId: id, verdict: "wrong", correct: { level: "none" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, overrideAdded: true });
    expect(h.all("SELECT verdict, correct_value FROM quality_labels")).toEqual([{ verdict: "wrong", correct_value: '{"level":"none"}' }]);
    expect(h.all("SELECT cam_id, action, frame_sha, local_date FROM quality_overrides")).toEqual([
      { cam_id: "boca-inlet-surf", action: "reject", frame_sha: SHA.slice(0, 20), local_date: "2026-10-13" },
    ]);
    expect(h.all("SELECT status FROM quality_alerts")).toEqual([{ status: "answered" }]);
  });

  it("Right: a publish override that carries the claim", async () => {
    const id = await seed();
    expect(await (await asOwner(answer, { alertId: id, verdict: "right" })).json()).toMatchObject({ ok: true, overrideAdded: true });
    expect(h.all("SELECT action, level, coverage_pct FROM quality_overrides")).toEqual([{ action: "publish", level: "moderate", coverage_pct: 35 }]);
  });

  it("an answer to an alert from an earlier day says it was recorded only", async () => {
    const id = await seed({
      localDate: "2026-10-12",
      claimTarget: { frameSha: SHA.slice(0, 20), frameAt: null, claimedAt: "2026-10-12T17:21:00Z" },
    });
    const out = await (await asOwner(answer, { alertId: id, verdict: "wrong" })).json();
    expect(out).toMatchObject({ ok: true, overrideAdded: false, why: "earlier-day" });
    expect(h.all("SELECT COUNT(*) AS n FROM quality_overrides")[0].n).toBe(0);
  });

  it("a second tap is allowed and supersedes the first (200, not 409)", async () => {
    const id = await seed();
    expect((await asOwner(answer, { alertId: id, verdict: "right" })).status).toBe(200);
    expect((await asOwner(answer, { alertId: id, verdict: "wrong" })).status).toBe(200);
    expect(h.all("SELECT COUNT(*) AS n FROM quality_labels WHERE superseded = 0")[0].n).toBe(1);
  });

  it("404 on an unknown alert, 400 on a bad request or value", async () => {
    expect((await asOwner(answer, { alertId: 4040, verdict: "right" })).status).toBe(404);
    const id = await seed();
    expect((await asOwner(answer, { alertId: id, verdict: "wrong", correct: { level: "huge" } })).status).toBe(400);
    for (const bad of [{ alertId: "1", verdict: "right" }, { alertId: 1.5, verdict: "right" }, { alertId: 0, verdict: "right" }, { alertId: 1, verdict: "maybe" }, { alertId: 1 }]) {
      expect((await asOwner(answer, bad)).status).toBe(400);
    }
    expect(h.all("SELECT COUNT(*) AS n FROM quality_labels")[0].n).toBe(0);
  });
});

describe.skipIf(!HAS_SQLITE)("report", () => {
  it("saves the owner's report with the nearest frames", async () => {
    await insertHourly(h.db, { hour_utc: "2026-10-13T17:00:00.000Z", seaweed_level: "none" });
    await insertFrame(h.db, { at: "2026-10-13T17:40:00.000Z" });
    const res = await asOwner(report, { slug: "boca-raton", seaweed: "moderate", clarity: "slightly_murky", surfFt: 3, sandF: 98, note: "weed line at the jetty" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, saved: 4, frames: 1 });
    expect(h.all("SELECT signal, source, verdict FROM quality_labels ORDER BY id").map((r) => r.signal)).toEqual(["seaweed", "clarity", "surf", "sand"]);
  });

  it("400 for an empty report, an unknown beach, or a bad value, and nothing is saved", async () => {
    for (const bad of [{ slug: "boca-raton" }, { slug: "atlantis", seaweed: "low" }, { slug: "boca-raton", seaweed: "lots" }, { slug: "boca-raton", surfFt: 500 }]) {
      expect((await asOwner(report, bad)).status).toBe(400);
    }
    expect(h.all("SELECT COUNT(*) AS n FROM quality_labels")[0].n).toBe(0);
  });

  it("answers 500, not a stack trace, when the database fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.exec("DROP TABLE quality_labels");
    const res = await asOwner(report, { slug: "boca-raton", seaweed: "low" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "store-unavailable" });
  });
});
