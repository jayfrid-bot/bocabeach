import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";

const sent: { token: string; payload: Record<string, unknown> }[] = [];
const apnsCtl = vi.hoisted(() => ({ configured: true, status: 200, reason: "", sessionOpts: null as unknown, onSend: null as null | (() => Promise<void>), perToken: {} as Record<string, "timeout" | "throw" | number> }));
vi.mock("@/lib/push/apns", () => ({
  getApns: () => (apnsCtl.configured ? { keyId: "k", teamId: "t", bundleId: "b", privateKey: "p", production: false } : null),
  isDeadToken: (r: { status?: number; reason?: string }) => r.status === 410 || (r.status === 400 && r.reason === "BadDeviceToken"),
  openApnsSession: (_cfg: unknown, _now: number, opts: unknown) => {
    apnsCtl.sessionOpts = opts;
    return {
      send: async (token: string, payload: Record<string, unknown>) => {
        sent.push({ token, payload });
        await apnsCtl.onSend?.();
        const special = apnsCtl.perToken[token];
        if (special === "throw") throw new Error("socket exploded");
        if (special === "timeout") return { ok: false, reason: "TimeoutError: The operation was aborted" };
        if (typeof special === "number") return { ok: false, status: special, reason: special === 410 ? "Unregistered" : "x" };
        return apnsCtl.status === 200 ? { ok: true, status: 200 } : { ok: false, status: apnsCtl.status, reason: apnsCtl.reason };
      },
      sendLiveActivityUpdate: async () => ({ ok: true, status: 200 }),
      close: () => {},
    };
  },
}));

import { getStore } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import { APNS_TIMEOUT_MS, MAX_OWNER_PHONES, reviewUrl, sendOwnerPush } from "@/lib/quality/notify";
import { seedOwnerSession } from "@/lib/quality/testHelpers";

const MSG = { title: "Boca Raton", body: "Check: x", url: reviewUrl(5), tag: "quality-5" };
const TOKEN_A = "aa".repeat(32);
const TOKEN_B = "bb".repeat(32);

let h: CamDb;
beforeEach(() => {
  resetMemoryStore();
  sent.length = 0;
  apnsCtl.configured = true;
  apnsCtl.status = 200;
  apnsCtl.reason = "";
  apnsCtl.onSend = null;
  apnsCtl.perToken = {};
  h = makeCamDb({ allMigrations: true }) as CamDb;
});
afterEach(() => {
  vi.restoreAllMocks();
  h?.close();
});

describe("reviewUrl", () => {
  it("opens the review screen on the alert", () => {
    expect(reviewUrl(12)).toBe("https://app.isitbeachday.com/admin/review?alert=12");
  });
});

describe.skipIf(!HAS_SQLITE)("sendOwnerPush", () => {
  it("sends to the push token stored on the owner session, with the alert's link and collapse tag", async () => {
    await seedOwnerSession(h.db, { pushToken: TOKEN_A });
    const r = await sendOwnerPush(h.db, MSG);
    expect(r).toEqual({ ok: true, sent: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0].token).toBe(TOKEN_A);
    expect(sent[0].payload).toMatchObject({ title: "Boca Raton", body: "Check: x", url: reviewUrl(5), tag: "quality-5" });
    expect(Number(sent[0].payload.expiration)).toBeGreaterThan(Date.now() / 1000);
  });

  it("every APNs call is cut off after 5 seconds", async () => {
    await seedOwnerSession(h.db, { pushToken: TOKEN_A });
    await sendOwnerPush(h.db, MSG);
    expect(APNS_TIMEOUT_MS).toBe(5000);
    expect(apnsCtl.sessionOpts).toEqual({ timeoutMs: 5000 });
  });

  it("NEVER reads the general devices table: another person's push registration gets nothing, and cannot redirect the alert", async () => {
    // Someone else registers an iPhone for alerts, even with the owner's own device id.
    const OWNER_DEVICE = "11111111-2222-4333-8444-555555555555";
    const store = await getStore();
    await store.upsertDevice(OWNER_DEVICE, { platform: "ios", pushToken: "cc".repeat(32) });
    await store.upsertDevice("99999999-2222-4333-8444-555555555555", { platform: "ios", pushToken: "dd".repeat(32) });
    // No owner session has a push token: nothing is sent, to anyone.
    await seedOwnerSession(h.db, { deviceId: OWNER_DEVICE });
    expect(await sendOwnerPush(h.db, MSG)).toEqual({ ok: false, sent: 0, failed: 0, reason: "no-owner-token" });
    expect(sent).toEqual([]);
    // With an owner token on the session, that one token is the only destination.
    await seedOwnerSession(h.db, { pushToken: TOKEN_B });
    await sendOwnerPush(h.db, MSG);
    expect(sent.map((s) => s.token)).toEqual([TOKEN_B]);
  });

  it("sends to each enrolled owner phone, up to three", async () => {
    for (let i = 0; i < 5; i++) await seedOwnerSession(h.db, { pushToken: `${i}${i}`.repeat(32), nowMs: Date.now() + i });
    const r = await sendOwnerPush(h.db, MSG);
    expect(MAX_OWNER_PHONES).toBe(3);
    expect(r.sent).toBe(3);
  });

  it("sends to a token once, even when two sessions hold it", async () => {
    // The database keeps tokens unique among active sessions; take the guard away to prove the sender dedupes too.
    await seedOwnerSession(h.db, { pushToken: TOKEN_A });
    await seedOwnerSession(h.db, { pushToken: TOKEN_B });
    h.exec("DROP INDEX owner_sessions_push_token_unique");
    h.exec(`UPDATE owner_sessions SET push_token = '${TOKEN_A}'`);
    const r = await sendOwnerPush(h.db, MSG);
    expect(r).toEqual({ ok: true, sent: 1, failed: 0 });
    expect(sent.map((s) => s.token)).toEqual([TOKEN_A]);
  });

  it("a dead-token answer clears only the exact token it was about", async () => {
    const { id } = await seedOwnerSession(h.db, { pushToken: TOKEN_A });
    apnsCtl.status = 410;
    // While the send is in flight the phone refreshes its token; the late 'dead' answer must not erase it.
    const { setSessionPushToken } = await import("@/lib/quality/ownerSessions");
    apnsCtl.onSend = async () => void (await setSessionPushToken(h.db, id, TOKEN_B, Date.now() + 5000));
    await sendOwnerPush(h.db, MSG);
    expect(h.all("SELECT push_token FROM owner_sessions")[0].push_token).toBe(TOKEN_B);
  });

  it("a revoked session is not pushed to", async () => {
    await seedOwnerSession(h.db, { pushToken: TOKEN_A });
    h.exec("UPDATE owner_sessions SET revoked = 1");
    expect(await sendOwnerPush(h.db, MSG)).toMatchObject({ ok: false, reason: "no-owner-token" });
  });

  it("says why nothing was sent", async () => {
    expect(await sendOwnerPush(h.db, MSG)).toMatchObject({ ok: false, reason: "no-owner-token" });
    await seedOwnerSession(h.db, { pushToken: TOKEN_A });
    apnsCtl.configured = false;
    expect(await sendOwnerPush(h.db, MSG)).toMatchObject({ ok: false, reason: "apns-not-configured" });
    expect(sent).toEqual([]);
  });

  it("counts a refusal from Apple as failed, and forgets a token Apple says is dead", async () => {
    await seedOwnerSession(h.db, { pushToken: TOKEN_A });
    apnsCtl.status = 410;
    expect(await sendOwnerPush(h.db, MSG)).toEqual({ ok: false, sent: 0, failed: 1 });
    expect(h.all("SELECT push_token FROM owner_sessions")[0].push_token).toBeNull();
  });

  it("a reply with no HTTP status (timeout, network error) is AMBIGUOUS: Apple may have accepted it", async () => {
    await seedOwnerSession(h.db, { pushToken: TOKEN_A });
    apnsCtl.perToken[TOKEN_A] = "timeout";
    expect(await sendOwnerPush(h.db, MSG)).toEqual({ ok: false, sent: 0, failed: 1, ambiguous: 1 });
    expect(h.all("SELECT push_token FROM owner_sessions")[0].push_token).toBe(TOKEN_A); // never forgotten for a timeout
    apnsCtl.perToken[TOKEN_A] = "throw";
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendOwnerPush(h.db, MSG)).toEqual({ ok: false, sent: 0, failed: 1, ambiguous: 1 });
  });

  it("an answer WITH a status (a 5xx, a refusal) is definitive, not ambiguous", async () => {
    await seedOwnerSession(h.db, { pushToken: TOKEN_A });
    for (const status of [400, 429, 500, 503]) {
      apnsCtl.perToken[TOKEN_A] = status;
      expect(await sendOwnerPush(h.db, MSG)).toEqual({ ok: false, sent: 0, failed: 1 });
    }
  });

  it("a partial success across phones counts as sent, and keeps the ambiguity of the other", async () => {
    await seedOwnerSession(h.db, { pushToken: TOKEN_A, nowMs: Date.now() + 1 });
    await seedOwnerSession(h.db, { pushToken: TOKEN_B });
    apnsCtl.perToken[TOKEN_B] = "timeout";
    expect(await sendOwnerPush(h.db, MSG)).toEqual({ ok: true, sent: 1, failed: 1, ambiguous: 1 });
  });

  it("trouble clearing a dead token never discards the sends that already went out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await seedOwnerSession(h.db, { pushToken: TOKEN_A, nowMs: Date.now() + 1 }); // newest first: sent first
    await seedOwnerSession(h.db, { pushToken: TOKEN_B });
    apnsCtl.perToken[TOKEN_B] = 410;
    // make the cleanup UPDATE throw
    h.exec("CREATE TRIGGER no_clear BEFORE UPDATE OF push_token ON owner_sessions WHEN NEW.push_token IS NULL BEGIN SELECT RAISE(ABORT, 'nope'); END");
    expect(await sendOwnerPush(h.db, MSG)).toEqual({ ok: true, sent: 1, failed: 1 });
  });

  it("keeps a token after an ordinary failure", async () => {
    await seedOwnerSession(h.db, { pushToken: TOKEN_A });
    apnsCtl.status = 503;
    expect(await sendOwnerPush(h.db, MSG)).toMatchObject({ ok: false, failed: 1 });
    expect(h.all("SELECT push_token FROM owner_sessions")[0].push_token).toBe(TOKEN_A);
  });

  it("never throws: a database failure is a failed result", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.exec("DROP TABLE owner_sessions");
    expect(await sendOwnerPush(h.db, MSG)).toEqual({ ok: false, sent: 0, failed: 1 });
  });
});
