// Client-side App Store billing through RevenueCat, for the Capacitor shell.
// Inert in a browser and inert until NEXT_PUBLIC_REVENUECAT_IOS_KEY is set —
// the paywall falls back to the server trial and the code until then, so
// nothing here can break a build that has no billing yet.
//
// RevenueCat's appUserID is OUR deviceId. That one decision is what lets the
// server (webhook + /api/devices/purchase) map a store purchase straight onto
// the D1 device row with no account, no login, no email.
//
// The plugin is resolved the same way as push (lib/push/native.ts): prefer the
// bridge the WebView injects, fall back to the bundled import. Same rule too:
// the plugin proxy is never awaited itself, only its method calls.

import { INTRO_ELIGIBILITY_STATUS, Purchases, type PurchasesPackage } from "@revenuecat/purchases-capacitor";
import { isNativePlatform } from "@/lib/push/native";

/** Public SDK key (appl_…). Public by design; baked in at build time. */
export const BILLING_KEY = process.env.NEXT_PUBLIC_REVENUECAT_IOS_KEY ?? "";
export const ENTITLEMENT = "plus";

export type PlanChoice = "monthly" | "yearly";

export interface PlanOffer {
  plan: PlanChoice;
  /** Localized, from the store: "$2.99", "$19.99". */
  price: string;
  pkg: PurchasesPackage;
}

export type PurchaseOutcome = "purchased" | "cancelled" | "failed";

/**
 * Whether the App Store account behind this device still owes a plan its
 * trial (or intro price). "unknown" means the store could not say — RevenueCat
 * needs subscription-group data it does not always have yet — and the paywall
 * must treat that exactly like "ineligible": never promise a trial it cannot
 * back up.
 */
export type Eligibility = "eligible" | "ineligible" | "unknown";

/** True only inside the app AND with a key to talk to RevenueCat. */
export function billingAvailable(): boolean {
  return isNativePlatform() && BILLING_KEY.length > 0;
}

function getPlugin(): typeof Purchases {
  if (typeof window !== "undefined") {
    const cap = (window as unknown as { Capacitor?: { Plugins?: { Purchases?: typeof Purchases } } })
      .Capacitor;
    if (cap?.Plugins?.Purchases) return cap.Plugins.Purchases;
  }
  return Purchases;
}

let configuredFor: string | null = null;

/**
 * Configure once per device id. Resolves false when billing is not available
 * OR when the native `configure` call itself fails (missing plugin, a stale
 * bridge, whatever) — configuration is the very first thing every other
 * billing call does, so it has to be inside the guarded region rather than
 * left to reject in each caller's own try/catch.
 */
export async function configureBilling(deviceId: string): Promise<boolean> {
  if (!billingAvailable() || !deviceId) return false;
  if (configuredFor === deviceId) return true;
  try {
    const P = getPlugin();
    await P.configure({ apiKey: BILLING_KEY, appUserID: deviceId });
    configuredFor = deviceId;
    return true;
  } catch {
    return false;
  }
}

/** The two plans, priced by the store. Empty when billing is off or unreachable. */
export async function loadOffers(deviceId: string): Promise<PlanOffer[]> {
  if (!(await configureBilling(deviceId))) return [];
  try {
    const P = getPlugin();
    const { current } = await P.getOfferings();
    const out: PlanOffer[] = [];
    if (current?.monthly) out.push({ plan: "monthly", price: current.monthly.product.priceString, pkg: current.monthly });
    if (current?.annual) out.push({ plan: "yearly", price: current.annual.product.priceString, pkg: current.annual });
    return out;
  } catch {
    return [];
  }
}

/**
 * Which of the given plans this Apple account can still get a trial (or intro
 * price) for. Checked against the App Store account, not this device, so a
 * reinstall or a new phone on the same Apple ID gets the right answer instead
 * of a fresh, wrong "eligible".
 *
 * Never throws: any failure — billing off, configure failed, the eligibility
 * call itself rejected — leaves every plan "unknown", and the caller must
 * treat "unknown" the same as "ineligible" (no promised trial).
 */
export async function trialEligibility(
  deviceId: string,
  offers: PlanOffer[],
): Promise<Record<PlanChoice, Eligibility>> {
  const out: Record<PlanChoice, Eligibility> = { monthly: "unknown", yearly: "unknown" };
  if (!(await configureBilling(deviceId))) return out;
  // A package whose product carries no introductory offer at all can never
  // grant a trial, whatever the eligibility call says (or fails to say).
  const withOffer = offers.filter((o) => o.pkg.product.introPrice != null);
  for (const o of offers) {
    if (!withOffer.includes(o)) out[o.plan] = "ineligible";
  }
  if (withOffer.length === 0) return out;
  try {
    const P = getPlugin();
    const ids = withOffer.map((o) => o.pkg.product.identifier);
    const result = await P.checkTrialOrIntroductoryPriceEligibility({ productIdentifiers: ids });
    for (const o of withOffer) {
      const status = result[o.pkg.product.identifier]?.status;
      if (status === INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE) {
        out[o.plan] = "eligible";
      } else if (
        status === INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_INELIGIBLE ||
        status === INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_NO_INTRO_OFFER_EXISTS
      ) {
        out[o.plan] = "ineligible";
      }
      // Any other status (including UNKNOWN) leaves the "unknown" default.
    }
  } catch {
    // The withOffer plans stay "unknown" — set above, untouched here.
  }
  return out;
}

/** Run the store's purchase sheet for one plan. Never throws. */
export async function purchasePlan(deviceId: string, offer: PlanOffer): Promise<PurchaseOutcome> {
  if (!(await configureBilling(deviceId))) return "failed";
  const P = getPlugin();
  try {
    await P.purchasePackage({ aPackage: offer.pkg });
    return "purchased";
  } catch (e) {
    const err = e as { userCancelled?: boolean | null; readableErrorCode?: string };
    if (err?.userCancelled || err?.readableErrorCode === "PURCHASE_CANCELLED") return "cancelled";
    return "failed";
  }
}

/** Ask the store for anything this Apple ID already bought. True if Plus is among it. */
export async function restoreBilling(deviceId: string): Promise<boolean> {
  if (!(await configureBilling(deviceId))) return false;
  const P = getPlugin();
  try {
    const { customerInfo } = await P.restorePurchases();
    return customerInfo.entitlements.active[ENTITLEMENT] != null;
  } catch {
    return false;
  }
}
