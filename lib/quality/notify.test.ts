import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";

const sent: { token: string; payload: Record<string, unknown> }[] = [];
const apnsCtl = vi.hoisted(() => ({ configured: true, status: 200, reason: "", sessionOpts: null as unknown }));
vi.mock("@/lib/push/apns", () => ({
  getApns: () => (apnsCtl.configured ? { keyId: "k", teamId: "t", bundleId: "b", privateKey: "p", production: false } : null),
  isDeadToken: (r: { status?: number; reason?: string }) => r.status === 410 || (r.status === 400 && r.reason === "BadDeviceToken"),
  openApnsSession: (_cfg: unknown, _now: number, opts: unknown) => {
    apnsCtl.sessionOpts = opts;
    return {
      send: async (token: string, payload: Record<string, unknown>) => {
        sent.push({ token, payload });
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
