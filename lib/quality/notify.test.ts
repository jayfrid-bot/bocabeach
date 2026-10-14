import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: { token: string; payload: Record<string, unknown> }[] = [];
const apnsCtl = vi.hoisted(() => ({ configured: true, ok: true }));
vi.mock("@/lib/push/apns", () => ({
  getApns: () => (apnsCtl.configured ? { keyId: "k", teamId: "t", bundleId: "b", privateKey: "p", production: false } : null),
  openApnsSession: () => ({
    send: async (token: string, payload: Record<string, unknown>) => {
      sent.push({ token, payload });
      return apnsCtl.ok ? { ok: true, status: 200 } : { ok: false, status: 400, reason: "BadDeviceToken" };
    },
    sendLiveActivityUpdate: async () => ({ ok: true, status: 200 }),
    close: () => {},
  }),
}));

import { getStore } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import { reviewUrl, sendOwnerPush } from "@/lib/quality/notify";

const OWNER = "11111111-2222-4333-8444-555555555555";
const OWNER2 = "66666666-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const MSG = { title: "Boca Raton", body: "Check: x", url: reviewUrl(5), tag: "quality-5" };

beforeEach(async () => {
  resetMemoryStore();
  sent.length = 0;
  apnsCtl.configured = true;
  apnsCtl.ok = true;
  process.env.OWNER_DEVICE_IDS = `${OWNER},${OWNER2}`;
  const store = await getStore();
  await store.upsertDevice(OWNER, { platform: "ios", pushToken: "tok-owner" });
  await store.upsertDevice(OTHER, { platform: "ios", pushToken: "tok-other" });
});
afterEach(() => {
  delete process.env.OWNER_DEVICE_IDS;
});

describe("reviewUrl", () => {
  it("opens the review screen on the alert", () => {
    expect(reviewUrl(12)).toBe("https://app.isitbeachday.com/admin/review?alert=12");
  });
});

describe("sendOwnerPush", () => {
  it("sends to the owner's iPhone only, with the alert's link and collapse tag", async () => {
    const r = await sendOwnerPush(MSG);
    expect(r).toEqual({ ok: true, sent: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0].token).toBe("tok-owner");
    expect(sent[0].payload).toMatchObject({ title: "Boca Raton", body: "Check: x", url: reviewUrl(5), tag: "quality-5" });
    expect(Number(sent[0].payload.expiration)).toBeGreaterThan(Date.now() / 1000);
  });

  it("sends to every owner phone that has a token", async () => {
    await (await getStore()).upsertDevice(OWNER2, { platform: "ios", pushToken: "tok-owner-2" });
    const r = await sendOwnerPush(MSG);
    expect(r.sent).toBe(2);
    expect(sent.map((s) => s.token).sort()).toEqual(["tok-owner", "tok-owner-2"]);
  });

  it("skips an owner device on another platform", async () => {
    await (await getStore()).upsertDevice(OWNER, { platform: "android", pushToken: "fcm-owner" });
    expect(await sendOwnerPush(MSG)).toEqual({ ok: false, sent: 0, failed: 0, reason: "no-owner-token" });
    expect(sent).toEqual([]);
  });

  it("says why nothing was sent", async () => {
    delete process.env.OWNER_DEVICE_IDS;
    expect(await sendOwnerPush(MSG)).toMatchObject({ ok: false, reason: "no-owner" });
    process.env.OWNER_DEVICE_IDS = OWNER2; // an owner with no token on file
    expect(await sendOwnerPush(MSG)).toMatchObject({ ok: false, reason: "no-owner-token" });
    process.env.OWNER_DEVICE_IDS = OWNER;
    apnsCtl.configured = false;
    expect(await sendOwnerPush(MSG)).toMatchObject({ ok: false, reason: "apns-not-configured" });
    expect(sent).toEqual([]);
  });

  it("counts a refusal from Apple as failed, not ok", async () => {
    apnsCtl.ok = false;
    expect(await sendOwnerPush(MSG)).toEqual({ ok: false, sent: 0, failed: 1 });
  });
});
