import { describe, expect, it } from "vitest";
import { defaultPlan, paywallCopy } from "@/lib/plus/paywallCopy";

describe("defaultPlan", () => {
  it("picks yearly when both plans are on offer", () => {
    expect(defaultPlan(["monthly", "yearly"])).toBe("yearly");
  });

  it("falls back to monthly when yearly is not on offer", () => {
    expect(defaultPlan(["monthly"])).toBe("monthly");
  });

  it("has nothing to select with no offers at all", () => {
    expect(defaultPlan([])).toBeNull();
  });
});

describe("paywallCopy", () => {
  it("says Loading and disables the button while offers have not arrived", () => {
    const copy = paywallCopy({ status: "loading", plan: null, price: undefined, eligibility: "unknown" });
    expect(copy).toEqual({ ctaLabel: "Loading prices…", finePrint: null, ctaDisabled: true });
  });

  it("invites another attempt when offers failed to load", () => {
    const copy = paywallCopy({ status: "failed", plan: null, price: undefined, eligibility: "unknown" });
    expect(copy.ctaLabel).toBe("Try again");
    expect(copy.finePrint).toBeNull();
    expect(copy.ctaDisabled).toBe(false);
  });

  it("also reads Try again if somehow loaded with no plan or price picked", () => {
    // Defensive: the picker should never let this happen, but the copy must
    // not invent a trial promise off missing data either.
    expect(paywallCopy({ status: "loaded", plan: null, price: undefined, eligibility: "eligible" }).ctaLabel).toBe(
      "Try again",
    );
    expect(
      paywallCopy({ status: "loaded", plan: "yearly", price: undefined, eligibility: "eligible" }).ctaLabel,
    ).toBe("Try again");
  });

  it("promises the trial only when eligibility is confirmed eligible", () => {
    const copy = paywallCopy({ status: "loaded", plan: "yearly", price: "$19.99", eligibility: "eligible" });
    expect(copy.ctaLabel).toBe("Start 3-day free trial");
    expect(copy.finePrint).toBe("3 days free, then $19.99/yr. Renews until you cancel in Settings.");
    expect(copy.ctaDisabled).toBe(false);
  });

  it("never promises a trial when eligibility is ineligible", () => {
    const copy = paywallCopy({ status: "loaded", plan: "monthly", price: "$2.99", eligibility: "ineligible" });
    expect(copy.ctaLabel).toBe("Subscribe · $2.99/mo");
    expect(copy.finePrint).toBe("Renews until you cancel in Settings. Cancel anytime.");
  });

  it("never promises a trial when eligibility is unknown either", () => {
    const copy = paywallCopy({ status: "loaded", plan: "monthly", price: "$2.99", eligibility: "unknown" });
    expect(copy.ctaLabel).toBe("Subscribe · $2.99/mo");
    expect(copy.finePrint).toBe("Renews until you cancel in Settings. Cancel anytime.");
  });

  it("switches between monthly and yearly price and period text", () => {
    const yearly = paywallCopy({ status: "loaded", plan: "yearly", price: "$19.99", eligibility: "eligible" });
    const monthly = paywallCopy({ status: "loaded", plan: "monthly", price: "$2.99", eligibility: "eligible" });
    expect(yearly.finePrint).toContain("$19.99/yr");
    expect(monthly.finePrint).toContain("$2.99/mo");
  });

  it("a no-offer product (no intro price) reads as a plain subscribe", () => {
    // billing.ts marks a package with no intro offer "ineligible" before this
    // ever runs, so the ineligible case above is exactly this scenario.
    const copy = paywallCopy({ status: "loaded", plan: "yearly", price: "$19.99", eligibility: "ineligible" });
    expect(copy.ctaLabel).not.toMatch(/free trial/i);
  });
});
