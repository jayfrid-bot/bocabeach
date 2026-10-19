import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PurchasesPackage } from "@revenuecat/purchases-capacitor";

// Capacitor's plugin proxy answers EVERY property as a native call, `then` included, and a
// native method that does not exist never calls back. If lib/plus/billing.ts ever lets the
// proxy reach promise resolution (returns it from an async function, or awaits it), every
// billing call hangs for ever in the app: the paywall never loads, a purchase never ends,
// holdReload() is never released. lib/plus/billing.test.ts mocks the plugin with a plain
// object, which has no `then`, so it cannot see this. These mocks behave like the real proxy.

const calls: string[] = [];

/** A Capacitor-style proxy: known methods resolve; any other property (then!) never settles. */
function capacitorProxy(impl: Record<string, (...a: unknown[]) => Promise<unknown>>) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === "string" && prop in impl) return impl[prop];
        return (..._args: unknown[]) => {
          calls.push(String(prop));
          return new Promise(() => {}); // the native side never answers
        };
      },
      has: () => true,
    },
  );
}

const pkg = (id: string, price: string) =>
  ({ identifier: id, product: { identifier: id, priceString: price, introPrice: { priceString: "Free" } } }) as unknown as PurchasesPackage;

const impl = {
  configure: async () => undefined,
  getOfferings: async () => ({ current: { monthly: pkg("m", "$2.99"), annual: pkg("y", "$19.99") } }),
  checkTrialOrIntroductoryPriceEligibility: async () => ({ m: { status: 2 }, y: { status: 1 } }),
  purchasePackage: async () => ({}),
  restorePurchases: async () => ({ customerInfo: { entitlements: { active: { plus: {} } } } }),
};

const bundled = vi.hoisted(() => ({ proxy: null as unknown }));

vi.mock("@revenuecat/purchases-capacitor", () => ({
  get Purchases() {
    return bundled.proxy;
  },
  INTRO_ELIGIBILITY_STATUS: {
    INTRO_ELIGIBILITY_STATUS_UNKNOWN: 0,
    INTRO_ELIGIBILITY_STATUS_INELIGIBLE: 1,
    INTRO_ELIGIBILITY_STATUS_ELIGIBLE: 2,
    INTRO_ELIGIBILITY_STATUS_NO_INTRO_OFFER_EXISTS: 3,
  },
}));
vi.mock("@/lib/push/native", () => ({ isNativePlatform: () => true, nativePlatform: () => "ios" }));

const DEVICE = "11111111-2222-4333-8444-555555555555";
const HANG = Symbol("hang");

/** Resolve with the call's result, or HANG if it has not settled within 500 ms. */
function settles<T>(p: Promise<T>): Promise<T | typeof HANG> {
  return Promise.race([p, new Promise<typeof HANG>((r) => setTimeout(() => r(HANG), 500))]);
}

async function runAll() {
  const billing = await import("@/lib/plus/billing");
  const { reloadHeld } = await import("@/lib/reloadGuard");
  const configured = await settles(billing.configureBilling(DEVICE));
  const offers = await settles(billing.loadOffers(DEVICE));
  const list = offers === HANG ? [] : offers;
  const eligibility = await settles(billing.trialEligibility(DEVICE, list));
  const purchase = await settles(billing.purchasePlan(DEVICE, list[0] ?? { plan: "monthly", price: "", pkg: pkg("m", "") }));
  const restore = await settles(billing.restoreBilling(DEVICE));
  return { configured, offers, eligibility, purchase, restore, held: reloadHeld() };
}

beforeEach(() => {
  vi.resetModules();
  calls.length = 0;
  process.env.NEXT_PUBLIC_REVENUECAT_IOS_KEY = "appl_test_key";
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_REVENUECAT_IOS_KEY;
  delete (globalThis as { window?: unknown }).window;
  bundled.proxy = null;
});

describe("billing with a real-shaped Capacitor proxy (answers every property, then included)", () => {
  it("bridge path (window.Capacitor.Plugins.Purchases): every call settles and the reload hold is released", async () => {
    (globalThis as { window?: unknown }).window = { Capacitor: { Plugins: { Purchases: capacitorProxy(impl) } } };
    const r = await runAll();
    expect(r.configured).toBe(true);
    expect(r.offers).not.toBe(HANG);
    expect((r.offers as { price: string }[]).map((o) => o.price)).toEqual(["$2.99", "$19.99"]);
    expect(r.eligibility).toEqual({ monthly: "eligible", yearly: "ineligible" });
    expect(r.purchase).toBe("purchased");
    expect(r.restore).toBe("active");
    expect(r.held).toBe(false);
    expect(calls).not.toContain("then"); // the proxy never reached promise resolution
  });

  it("bundled path (on-demand import): every call settles too", async () => {
    bundled.proxy = capacitorProxy(impl);
    const r = await runAll();
    expect(r.configured).toBe(true);
    expect(r.offers).not.toBe(HANG);
    expect(r.eligibility).not.toBe(HANG);
    expect(r.purchase).toBe("purchased");
    expect(r.restore).toBe("active");
    expect(r.held).toBe(false);
    expect(calls).not.toContain("then");
  });

  it("the harness catches the bug: an async function returning the bare proxy hangs", async () => {
    const proxy = capacitorProxy(impl);
    const bad = async () => proxy;
    expect(await settles(bad())).toBe(HANG);
    expect(calls).toContain("then");
  });
});
