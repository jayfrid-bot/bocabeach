// The RevenueCat webhook turns a purchase event into entitlement on the device
// row. Auth is a shared header; the event→entitlement mapping is in
// lib/plus/revenuecat.ts. These call the handler directly (no network); the
// in-memory store backs it under vitest.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POST } from "@/app/api/revenuecat/webhook/route";
import { decideEntitlement } from "@/lib/plus/revenuecat";
import { getStore } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";

const DEV = "11111111-2222-4333-8444-555555555555";
const SECRET = "rc-webhook-secret-xyz";
const DAY = 24 * 3600 * 1000;

beforeEach(() => {
  resetMemoryStore();
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.REVENUECAT_WEBHOOK_SECRET;
});

function hook(event: Record<string, unknown>, auth: string = SECRET): Request {
  return new Request("https://x/api/revenuecat/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ event, api_version: "1.0" }),
  });
}
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("decideEntitlement (pure mapping)", () => {
  const until = Date.now() + 30 * DAY;
  it("purchase and renewal grant Plus until the expiry", () => {
    for (const type of ["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE"]) {
      expect(decideEntitlement({ event: { type, app_user_id: DEV, expiration_at_ms: until } })).toEqual({
        kind: "apply",
        deviceId: DEV,
        plan: "plus",
        entitlementUntil: until,
      });
    }
  });
  it("expiration and pause revoke Plus", () => {
    for (const type of ["EXPIRATION", "SUBSCRIPTION_PAUSED"]) {
      expect(decideEntitlement({ event: { type, app_user_id: DEV } })).toMatchObject({
        kind: "apply",
        plan: "free",
        entitlementUntil: null,
      });
    }
  });
  it("cancellation and billing issues are no-ops (access holds until it expires)", () => {
    for (const type of ["CANCELLATION", "BILLING_ISSUE"]) {
      expect(decideEntitlement({ event: { type, app_user_id: DEV } }).kind).toBe("ignore");
    }
  });
  it("ignores TEST events and anonymous app_user_ids", () => {
    expect(decideEntitlement({ event: { type: "TEST" } }).kind).toBe("ignore");
    expect(
      decideEntitlement({ event: { type: "INITIAL_PURCHASE", app_user_id: "$RCAnonymousID:abc" } }).kind,
    ).toBe("ignore");
  });
});

describe("POST /api/revenuecat/webhook", () => {
  it("503 when no secret is configured", async () => {
    delete process.env.REVENUECAT_WEBHOOK_SECRET;
    const res = await POST(hook({ type: "TEST" }));
    expect(res.status).toBe(503);
  });

  it("401 on a wrong Authorization header", async () => {
    const res = await POST(hook({ type: "INITIAL_PURCHASE", app_user_id: DEV }, "nope"));
    expect(res.status).toBe(401);
  });

  it("a purchase flips a known device to Plus", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { platform: "ios" });
    const until = Date.now() + 30 * DAY;
    const res = await POST(hook({ type: "INITIAL_PURCHASE", app_user_id: DEV, expiration_at_ms: until }));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, applied: true, plan: "plus" });
    const dev = await store.getDevice(DEV);
    expect(dev?.plan).toBe("plus");
    expect(dev?.entitlementUntil).toBe(until);
  });

  it("expiration flips it back to free", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { plan: "plus", entitlementUntil: Date.now() + DAY });
    const res = await POST(hook({ type: "EXPIRATION", app_user_id: DEV }));
    expect(res.status).toBe(200);
    expect((await store.getDevice(DEV))?.plan).toBe("free");
  });

  it("does not conjure a row for an unknown device", async () => {
    const res = await POST(hook({ type: "INITIAL_PURCHASE", app_user_id: DEV, expiration_at_ms: Date.now() + DAY }));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ applied: false, reason: "unknown-device" });
    const store = await getStore();
    expect(await store.getDevice(DEV)).toBeNull();
  });

  it("acknowledges a no-op event without touching the row", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { plan: "plus", entitlementUntil: 123 });
    const res = await POST(hook({ type: "CANCELLATION", app_user_id: DEV }));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ applied: false });
    expect((await store.getDevice(DEV))?.plan).toBe("plus"); // cancel ≠ expire
  });

  it("400 on unparseable JSON", async () => {
    const res = await POST(
      new Request("https://x/api/revenuecat/webhook", {
        method: "POST",
        headers: { Authorization: SECRET },
        body: "{oops",
      }),
    );
    expect(res.status).toBe(400);
  });
});
