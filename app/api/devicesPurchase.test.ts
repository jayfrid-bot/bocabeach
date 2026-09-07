// /api/devices/purchase asks RevenueCat (stubbed here) and mirrors the answer
// onto the device row — up only, never down.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "@/app/api/devices/purchase/route";
import { entitlementFromSubscriber } from "@/lib/plus/revenuecatVerify";
import { getStore } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";

const DEV = "11111111-2222-4333-8444-555555555555";
const APP_UA = "Mozilla/5.0 (iPhone) IsItBeachDayApp/ios";
const DAY = 24 * 3600 * 1000;

function post(body: unknown, ua = APP_UA): Request {
  return new Request("https://x/api/devices/purchase", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": ua },
    body: JSON.stringify(body),
  });
}
function rcAnswers(status: number, subscriber: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ subscriber }), { status })),
  );
}
const json = async (r: Response) => (await r.json()) as Record<string, unknown> & { device?: { plan: string; entitlementUntil: number | null } };

beforeEach(() => {
  resetMemoryStore();
  process.env.REVENUECAT_SECRET_KEY = "sk_test";
});
afterEach(() => {
  delete process.env.REVENUECAT_SECRET_KEY;
  vi.unstubAllGlobals();
});

describe("entitlementFromSubscriber", () => {
  it("reads an active plus entitlement with its expiry", () => {
    const exp = new Date(Date.now() + 30 * DAY).toISOString();
    expect(
      entitlementFromSubscriber(
        { subscriber: { entitlements: { plus: { expires_date: exp, product_identifier: "com.isitbeachday.app.plus.yearly" } } } },
        Date.now(),
      ),
    ).toEqual({ active: true, expiresAt: Date.parse(exp), productId: "com.isitbeachday.app.plus.yearly" });
  });
  it("an expired one is inactive; a missing one is inactive; no end date is active", () => {
    const past = new Date(Date.now() - DAY).toISOString();
    expect(entitlementFromSubscriber({ subscriber: { entitlements: { plus: { expires_date: past } } } }, Date.now()).active).toBe(false);
    expect(entitlementFromSubscriber({ subscriber: { entitlements: {} } }, Date.now()).active).toBe(false);
    expect(entitlementFromSubscriber({ subscriber: { entitlements: { plus: { expires_date: null } } } }, Date.now()).active).toBe(true);
  });
});

describe("POST /api/devices/purchase", () => {
  it("is app-only", async () => {
    expect((await POST(post({ deviceId: DEV }, "Mozilla/5.0 Chrome"))).status).toBe(403);
  });

  it("503 until the secret key is configured", async () => {
    delete process.env.REVENUECAT_SECRET_KEY;
    expect((await POST(post({ deviceId: DEV }))).status).toBe(503);
  });

  it("an active store entitlement turns Plus on with the store's expiry", async () => {
    const exp = new Date(Date.now() + 365 * DAY).toISOString();
    rcAnswers(200, { entitlements: { plus: { expires_date: exp, product_identifier: "com.isitbeachday.app.plus.yearly" } } });
    const res = await POST(post({ deviceId: DEV }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.device?.plan).toBe("plus");
    expect(body.device?.entitlementUntil).toBe(Date.parse(exp));
  });

  it("never takes Plus away: a trial device with no store purchase keeps its trial", async () => {
    const store = await getStore();
    const until = Date.now() + 2 * DAY;
    await store.upsertDevice(DEV, { plan: "plus", entitlementUntil: until, trialUsed: true });
    rcAnswers(201, { entitlements: {} }); // RevenueCat just created an empty subscriber
    const res = await POST(post({ deviceId: DEV }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.device?.plan).toBe("plus");
    expect(body.device?.entitlementUntil).toBe(until);
  });

  it("no purchase and no row is not-found, not an error", async () => {
    rcAnswers(201, { entitlements: {} });
    const res = await POST(post({ deviceId: DEV }));
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe("not-found");
  });

  it("RevenueCat being down is 502, distinct from not entitled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const res = await POST(post({ deviceId: DEV }));
    expect(res.status).toBe(502);
    expect((await json(res)).error).toBe("billing-unavailable");
  });
});
