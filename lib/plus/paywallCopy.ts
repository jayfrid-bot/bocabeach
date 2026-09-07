// Pure derivation of the billing-on paywall's plan picker and call-to-action
// text. No React, no network — every state the paywall can be in is a plain
// value here, so the eligible/ineligible/unknown x monthly/yearly matrix (and
// the no-offer, loading and failed cases) is testable without mounting
// anything. See components/plus/Paywall.tsx for how this is wired in, and
// GitHub issues #15 (never promise a trial that is not confirmed) and #17's
// "unavailable/partial offerings" finding (show only what the store returned,
// with an honest loading/failed state) for why this exists.

import type { Eligibility, PlanChoice } from "@/lib/plus/billing";

export type OffersStatus = "loading" | "loaded" | "failed";

/** Localized per-unit label for the price line, "mo" or "yr". */
export const PER: Record<PlanChoice, string> = { monthly: "mo", yearly: "yr" };

/**
 * Which plan should start selected, given the plans the store actually
 * returned: yearly when it exists (the better deal), monthly when it is the
 * only one offered. An empty list (still loading, or the store answered with
 * nothing) has nothing to select.
 */
export function defaultPlan(plans: PlanChoice[]): PlanChoice | null {
  if (plans.includes("yearly")) return "yearly";
  if (plans.includes("monthly")) return "monthly";
  return null;
}

export interface PaywallCopyInput {
  status: OffersStatus;
  /** The selected plan, or null when there is nothing to select yet. */
  plan: PlanChoice | null;
  /** The selected plan's store price, e.g. "$19.99". Undefined until it is known. */
  price: string | undefined;
  /** That plan's trial eligibility. Ignored while offers are loading or failed. */
  eligibility: Eligibility;
}

export interface PaywallCopy {
  ctaLabel: string;
  /** The line under the button. Null when there is nothing to add. */
  finePrint: string | null;
  ctaDisabled: boolean;
}

/**
 * The button label and fine print for the billing-on paywall.
 *
 * A trial is promised ONLY when eligibility for the selected plan came back
 * "eligible". "ineligible" and "unknown" both read as a plain subscribe —
 * an unconfirmed eligibility is not a confirmed trial (issue #15). While
 * offers are loading the button says so and is disabled; if they failed to
 * load, it invites another attempt instead of guessing at a price.
 */
export function paywallCopy(input: PaywallCopyInput): PaywallCopy {
  const { status, plan, price, eligibility } = input;

  if (status === "loading") {
    return { ctaLabel: "Loading prices…", finePrint: null, ctaDisabled: true };
  }
  if (status === "failed" || !plan || !price) {
    return { ctaLabel: "Try again", finePrint: null, ctaDisabled: false };
  }

  const per = PER[plan];
  if (eligibility === "eligible") {
    return {
      ctaLabel: "Start 3-day free trial",
      finePrint: `3 days free, then ${price}/${per}. Renews until you cancel in Settings.`,
      ctaDisabled: false,
    };
  }
  return {
    ctaLabel: `Subscribe · ${price}/${per}`,
    finePrint: "Renews until you cancel in Settings. Cancel anytime.",
    ctaDisabled: false,
  };
}
