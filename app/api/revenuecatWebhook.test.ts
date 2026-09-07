// The RevenueCat webhook no longer trusts the event's own meaning (#7) — it
// asks RevenueCat's subscriber record what's true right now and writes that.
// `decideReconcile` (lib/plus/revenuecat.ts) only decides whether an event is
// worth that round-trip. These call the route handler directly (no network);
// RevenueCat's REST answer is stubbed with vi.stubGlobal("fetch", …), same as
// app/api/devicesPurchase.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "@/app/api/revenuecat/webhook/route";
import { decideReconcile } from "@/lib/plus/revenuecat";
import { getStore } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";

const DEV = "11111111-2222-4333-8444-555555555555";
const WEBHOOK_SECRET = "rc-webhook-secret-xyz";
const RC_SECRET = "sk_test";
const DAY = 24 * 3600 * 1000;

beforeEach(() => {
  resetMemoryStore();
  process.env.REVENUECAT_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.REVENUECAT_SECRET_KEY = RC_SECRET;
});
afterEach(() => {
  delete process.env.REVENUECAT_WEBHOOK_SECRET;
  delete process.env.REVENUECAT_SECRET_KEY;
  vi.unstubAllGlobals();
});

function hook(event: Record<string, unknown>, auth: string = WEBHOOK_SECRET): Request {
  return new Request("https://x/api/revenuecat/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ event, api_version: "1.0" }),
  });
}
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

/** Stub RevenueCat's GET /v1/subscribers/{id} the way the webhook calls it. */
function rcAnswers(entitlements: Record<string, { expires_date?: string | null }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ subscriber: { entitlements } }), { status: 200 })),
  );
}
function rcUnreachable() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network down");
    }),
  );
}

describe("decideReconcile (pure: mappable vs ignore)", () => {
  it("a mappable event reconciles", () => {
    for (const type of ["INITIAL_PURCHASE", "RENEWAL", "EXPIRATION", "SUBSCRIPTION_PAUSED", "CANCELLATION", "BILLING_ISSUE"]) {
      expect(decideReconcile({ event: { type, app_user_id: DEV } })).toEqual({
        kind: "reconcile",
        deviceId: DEV,
      });
    }
  });
  it("ignores TEST events and anonymous app_user_ids", () => {
    expect(decideReconcile({ event: { type: "TEST" } }).kind).toBe("ignore");
    expect(
      decideReconcile({ event: { type: "INITIAL_PURCHASE", app_user_id: "$RCAnonymousID:abc" } }).kind,
    ).toBe("ignore");
  });
  it("ignores an event scoped to some other entitlement", () => {
    expect(
      decideReconcile({ event: { type: "RENEWAL", app_user_id: DEV, entitlement_ids: ["some_other_product"] } }),
    ).toEqual({ kind: "ignore", reason: "other-entitlement" });
  });
  it("reconciles when entitlement_ids includes plus, or is absent/empty", () => {
    expect(decideReconcile({ event: { type: "RENEWAL", app_user_id: DEV, entitlement_ids: ["plus"] } }).kind).toBe(
      "reconcile",
    );
    expect(decideReconcile({ event: { type: "RENEWAL", app_user_id: DEV, entitlement_ids: [] } }).kind).toBe(
      "reconcile",
    );
  });
});

describe("POST /api/revenuecat/webhook", () => {
  it("503 when no webhook secret is configured", async () => {
    delete process.env.REVENUECAT_WEBHOOK_SECRET;
    const res = await POST(hook({ type: "TEST" }));
    expect(res.status).toBe(503);
  });

  it("401 on a wrong Authorization header", async () => {
    const res = await POST(hook({ type: "INITIAL_PURCHASE", app_user_id: DEV }, "nope"));
    expect(res.status).toBe(401);
  });

  it("400 on unparseable JSON", async () => {
    const res = await POST(
      new Request("https://x/api/revenuecat/webhook", {
        method: "POST",
        headers: { Authorization: WEBHOOK_SECRET },
        body: "{oops",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("an ignored event never even reaches the secret-key check", async () => {
    delete process.env.REVENUECAT_SECRET_KEY;
    const res = await POST(hook({ type: "TEST" }));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ applied: false, reason: "test" });
  });

  it("a mappable event 503s until REVENUECAT_SECRET_KEY is configured", async () => {
    delete process.env.REVENUECAT_SECRET_KEY;
    const store = await getStore();
    await store.upsertDevice(DEV, { platform: "ios" });
    const res = await POST(hook({ type: "INITIAL_PURCHASE", app_user_id: DEV }));
    expect(res.status).toBe(503);
  });

  it("reconciles a known device to whatever RevenueCat currently says", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { platform: "ios" });
    const until = Date.now() + 30 * DAY;
    rcAnswers({ plus: { expires_date: new Date(until).toISOString() } });
    const res = await POST(hook({ type: "INITIAL_PURCHASE", app_user_id: DEV }));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, applied: true, plan: "plus" });
    const dev = await store.getDevice(DEV);
    expect(dev?.plan).toBe("plus");
    expect(dev?.entitlementUntil).toBe(until);
    expect(dev?.grants.storeUntil).toBe(until);
  });

  it("an inactive subscriber flips it back to free", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { storeUntil: Date.now() + DAY });
    rcAnswers({}); // RevenueCat now says nothing active
    const res = await POST(hook({ type: "EXPIRATION", app_user_id: DEV }));
    expect(res.status).toBe(200);
    expect((await store.getDevice(DEV))?.plan).toBe("free");
  });

  it("clears only the store grant — an independent code grant survives (#4)", async () => {
    const store = await getStore();
    const codeUntil = Date.now() + 365 * DAY;
    await store.upsertDevice(DEV, { codeUntil, storeUntil: Date.now() + DAY });
    rcAnswers({}); // the store subscription lapsed
    await POST(hook({ type: "EXPIRATION", app_user_id: DEV }));
    const dev = await store.getDevice(DEV);
    expect(dev?.plan).toBe("plus"); // still entitled — through the code
    expect(dev?.entitlementUntil).toBe(codeUntil);
    expect(dev?.grants.storeUntil).toBeNull();
  });

  it("does not conjure a row for an unknown device, and never calls RevenueCat for it", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await POST(hook({ type: "INITIAL_PURCHASE", app_user_id: DEV }));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ applied: false, reason: "unknown-device" });
    expect(fetchSpy).not.toHaveBeenCalled();
    const store = await getStore();
    expect(await store.getDevice(DEV)).toBeNull();
  });

  it("ignores an event scoped to another entitlement, without touching the row or calling RevenueCat", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { codeUntil: 123 + Date.now() });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await POST(hook({ type: "RENEWAL", app_user_id: DEV, entitlement_ids: ["some_other_product"] }));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ applied: false, reason: "other-entitlement" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("RevenueCat being unreachable is 500 so it retries, and writes nothing", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { storeUntil: Date.now() + 30 * DAY });
    rcUnreachable();
    const res = await POST(hook({ type: "RENEWAL", app_user_id: DEV }));
    expect(res.status).toBe(500);
    // Unreachable means "unknown," never "inactive" — the prior grant stands.
    expect((await store.getDevice(DEV))?.plan).toBe("plus");
  });

  // --- #7 acceptance tests: delivery order can't drive the outcome ---------
  it("a renewal followed by a stale, out-of-order expiration keeps access", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { platform: "ios" });
    const renewedUntil = Date.now() + 30 * DAY;

    // The RENEWAL lands; RevenueCat's live record already reflects it.
    rcAnswers({ plus: { expires_date: new Date(renewedUntil).toISOString() } });
    await POST(hook({ type: "RENEWAL", app_user_id: DEV }));
    expect((await store.getDevice(DEV))?.entitlementUntil).toBe(renewedUntil);

    // A retried EXPIRATION from BEFORE the renewal arrives late. It still
    // triggers a reconcile — but RevenueCat's subscriber record hasn't
    // changed, so the answer is the same, and the renewal is not undone.
    await POST(hook({ type: "EXPIRATION", app_user_id: DEV }));
    const dev = await store.getDevice(DEV);
    expect(dev?.plan).toBe("plus");
    expect(dev?.entitlementUntil).toBe(renewedUntil);
  });

  it("repeated deliveries of the same event are idempotent", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { platform: "ios" });
    const until = Date.now() + 30 * DAY;
    rcAnswers({ plus: { expires_date: new Date(until).toISOString() } });

    const event = { type: "RENEWAL", app_user_id: DEV };
    await POST(hook(event));
    await POST(hook(event));
    await POST(hook(event));

    const dev = await store.getDevice(DEV);
    expect(dev?.plan).toBe("plus");
    expect(dev?.entitlementUntil).toBe(until);
  });
});
