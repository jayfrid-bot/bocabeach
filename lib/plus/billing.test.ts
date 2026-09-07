import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PurchasesPackage } from "@revenuecat/purchases-capacitor";

// Every call in lib/plus/billing.ts has a never-rejects contract (issue #16):
// a rejected native call must resolve as "not available" rather than escape
// as an unhandled rejection, because every UI handler awaits these directly.
// The plugin is mocked at the module boundary so no real Capacitor bridge is
// needed, and the module itself is re-imported fresh per test (via dynamic
// import after vi.resetModules) so BILLING_KEY — read once, at module load,
// from process.env — can be set differently per test.

const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  getOfferings: vi.fn(),
  purchasePackage: vi.fn(),
  restorePurchases: vi.fn(),
  checkTrialOrIntroductoryPriceEligibility: vi.fn(),
}));

vi.mock("@revenuecat/purchases-capacitor", () => ({
  Purchases: mocks,
  INTRO_ELIGIBILITY_STATUS: {
    INTRO_ELIGIBILITY_STATUS_UNKNOWN: 0,
    INTRO_ELIGIBILITY_STATUS_INELIGIBLE: 1,
    INTRO_ELIGIBILITY_STATUS_ELIGIBLE: 2,
    INTRO_ELIGIBILITY_STATUS_NO_INTRO_OFFER_EXISTS: 3,
  },
}));

vi.mock("@/lib/push/native", () => ({
  // Every test here wants billingAvailable() true; the "billing off" cases
  // (no key, or a browser) are exercised in the paywall's own tests instead.
  isNativePlatform: () => true,
}));

const DEVICE_ID = "11111111-2222-4333-8444-555555555555";

function fakePackage(productId: string, priceString: string, hasIntroOffer = true): PurchasesPackage {
  return {
    identifier: productId,
    product: {
      identifier: productId,
      priceString,
      introPrice: hasIntroOffer ? { priceString: "Free", cycles: 1, period: "P3D" } : null,
    },
  } as unknown as PurchasesPackage;
}

let billing: typeof import("@/lib/plus/billing");

beforeEach(async () => {
  vi.resetModules();
  for (const fn of Object.values(mocks)) fn.mockReset();
  process.env.NEXT_PUBLIC_REVENUECAT_IOS_KEY = "appl_test_key";
  billing = await import("@/lib/plus/billing");
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_REVENUECAT_IOS_KEY;
});

describe("configureBilling", () => {
  it("resolves true and configures once per device id", async () => {
    mocks.configure.mockResolvedValue(undefined);
    expect(await billing.configureBilling(DEVICE_ID)).toBe(true);
    expect(await billing.configureBilling(DEVICE_ID)).toBe(true);
    // The second call for the same device id is a no-op — already configured.
    expect(mocks.configure).toHaveBeenCalledTimes(1);
  });

  it("resolves false, never rejects, when native configure() rejects", async () => {
    mocks.configure.mockRejectedValue(new Error("bridge not attached"));
    await expect(billing.configureBilling(DEVICE_ID)).resolves.toBe(false);
  });

  it("resolves false without calling the native plugin when there is no key", async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_REVENUECAT_IOS_KEY;
    const off = await import("@/lib/plus/billing");
    expect(await off.configureBilling(DEVICE_ID)).toBe(false);
    expect(mocks.configure).not.toHaveBeenCalled();
  });
});

describe("loadOffers", () => {
  it("returns the monthly and yearly packages priced by the store", async () => {
    mocks.configure.mockResolvedValue(undefined);
    mocks.getOfferings.mockResolvedValue({
      current: {
        monthly: fakePackage("monthly_id", "$2.99"),
        annual: fakePackage("annual_id", "$19.99"),
      },
    });
    const offers = await billing.loadOffers(DEVICE_ID);
    expect(offers).toEqual([
      { plan: "monthly", price: "$2.99", pkg: expect.anything() },
      { plan: "yearly", price: "$19.99", pkg: expect.anything() },
    ]);
  });

  it("resolves [] rather than rejecting when configure fails", async () => {
    mocks.configure.mockRejectedValue(new Error("no bridge"));
    await expect(billing.loadOffers(DEVICE_ID)).resolves.toEqual([]);
    expect(mocks.getOfferings).not.toHaveBeenCalled();
  });

  it("resolves [] rather than rejecting when getOfferings() itself rejects", async () => {
    mocks.configure.mockResolvedValue(undefined);
    mocks.getOfferings.mockRejectedValue(new Error("offline"));
    await expect(billing.loadOffers(DEVICE_ID)).resolves.toEqual([]);
  });
});

describe("purchasePlan", () => {
  const offer = { plan: "yearly" as const, price: "$19.99", pkg: fakePackage("annual_id", "$19.99") };

  it('resolves "purchased" on a successful native purchase', async () => {
    mocks.configure.mockResolvedValue(undefined);
    mocks.purchasePackage.mockResolvedValue({});
    expect(await billing.purchasePlan(DEVICE_ID, offer)).toBe("purchased");
    expect(mocks.purchasePackage).toHaveBeenCalledWith({ aPackage: offer.pkg });
  });

  it('resolves "cancelled" when the store reports userCancelled', async () => {
    mocks.configure.mockResolvedValue(undefined);
    mocks.purchasePackage.mockRejectedValue({ userCancelled: true });
    expect(await billing.purchasePlan(DEVICE_ID, offer)).toBe("cancelled");
  });

  it('resolves "cancelled" for the readableErrorCode form of cancellation', async () => {
    mocks.configure.mockResolvedValue(undefined);
    mocks.purchasePackage.mockRejectedValue({ readableErrorCode: "PURCHASE_CANCELLED" });
    expect(await billing.purchasePlan(DEVICE_ID, offer)).toBe("cancelled");
  });

  it('resolves "failed", never rejects, on any other purchase error', async () => {
    mocks.configure.mockResolvedValue(undefined);
    mocks.purchasePackage.mockRejectedValue(new Error("declined"));
    await expect(billing.purchasePlan(DEVICE_ID, offer)).resolves.toBe("failed");
  });

  it('resolves "failed" when configuration itself failed', async () => {
    mocks.configure.mockRejectedValue(new Error("no bridge"));
    await expect(billing.purchasePlan(DEVICE_ID, offer)).resolves.toBe("failed");
    expect(mocks.purchasePackage).not.toHaveBeenCalled();
  });
});

describe("restoreBilling", () => {
  it("resolves true when Plus is among the restored entitlements", async () => {
    mocks.configure.mockResolvedValue(undefined);
    mocks.restorePurchases.mockResolvedValue({
      customerInfo: { entitlements: { active: { plus: { productIdentifier: "annual_id" } } } },
    });
    expect(await billing.restoreBilling(DEVICE_ID)).toBe(true);
  });

  it("resolves false when nothing active matches the entitlement", async () => {
    mocks.configure.mockResolvedValue(undefined);
    mocks.restorePurchases.mockResolvedValue({ customerInfo: { entitlements: { active: {} } } });
    expect(await billing.restoreBilling(DEVICE_ID)).toBe(false);
  });

  it("resolves false, never rejects, when restorePurchases() rejects", async () => {
    mocks.configure.mockResolvedValue(undefined);
    mocks.restorePurchases.mockRejectedValue(new Error("network"));
    await expect(billing.restoreBilling(DEVICE_ID)).resolves.toBe(false);
  });

  it("resolves false when configuration itself failed", async () => {
    mocks.configure.mockRejectedValue(new Error("no bridge"));
    await expect(billing.restoreBilling(DEVICE_ID)).resolves.toBe(false);
    expect(mocks.restorePurchases).not.toHaveBeenCalled();
  });
});

describe("trialEligibility", () => {
  const monthly = { plan: "monthly" as const, price: "$2.99", pkg: fakePackage("monthly_id", "$2.99") };
  const yearly = { plan: "yearly" as const, price: "$19.99", pkg: fakePackage("annual_id", "$19.99") };

  it("marks a plan eligible when the store confirms it", async () => {
    mocks.configure.mockResolvedValue(undefined);
    mocks.checkTrialOrIntroductoryPriceEligibility.mockResolvedValue({
      monthly_id: { status: 2 }, // INTRO_ELIGIBILITY_STATUS_ELIGIBLE
      annual_id: { status: 1 }, // INTRO_ELIGIBILITY_STATUS_INELIGIBLE
    });
    const result = await billing.trialEligibility(DEVICE_ID, [monthly, yearly]);
    expect(result).toEqual({ monthly: "eligible", yearly: "ineligible" });
  });

  it("reads UNKNOWN status as unknown, never as a promised trial", async () => {
    mocks.configure.mockResolvedValue(undefined);
    mocks.checkTrialOrIntroductoryPriceEligibility.mockResolvedValue({
      monthly_id: { status: 0 }, // INTRO_ELIGIBILITY_STATUS_UNKNOWN
    });
    const result = await billing.trialEligibility(DEVICE_ID, [monthly]);
    expect(result.monthly).toBe("unknown");
  });

  it("marks a package with no introductory offer ineligible without asking the store", async () => {
    mocks.configure.mockResolvedValue(undefined);
    const noIntro = { plan: "monthly" as const, price: "$2.99", pkg: fakePackage("plain_id", "$2.99", false) };
    const result = await billing.trialEligibility(DEVICE_ID, [noIntro]);
    expect(result.monthly).toBe("ineligible");
    expect(mocks.checkTrialOrIntroductoryPriceEligibility).not.toHaveBeenCalled();
  });

  it("resolves every plan unknown, never rejects, when the eligibility call itself fails", async () => {
    mocks.configure.mockResolvedValue(undefined);
    mocks.checkTrialOrIntroductoryPriceEligibility.mockRejectedValue(new Error("offline"));
    await expect(billing.trialEligibility(DEVICE_ID, [monthly, yearly])).resolves.toEqual({
      monthly: "unknown",
      yearly: "unknown",
    });
  });

  it("resolves every plan unknown when configuration itself failed", async () => {
    mocks.configure.mockRejectedValue(new Error("no bridge"));
    await expect(billing.trialEligibility(DEVICE_ID, [monthly, yearly])).resolves.toEqual({
      monthly: "unknown",
      yearly: "unknown",
    });
    expect(mocks.checkTrialOrIntroductoryPriceEligibility).not.toHaveBeenCalled();
  });

  it("resolves {} sensibly (both unknown) when there are no offers to check", async () => {
    mocks.configure.mockResolvedValue(undefined);
    await expect(billing.trialEligibility(DEVICE_ID, [])).resolves.toEqual({
      monthly: "unknown",
      yearly: "unknown",
    });
    expect(mocks.checkTrialOrIntroductoryPriceEligibility).not.toHaveBeenCalled();
  });
});
