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

import { Purchases, type PurchasesPackage } from "@revenuecat/purchases-capacitor";
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

/** Configure once per device id. Resolves false when billing is not available. */
export async function configureBilling(deviceId: string): Promise<boolean> {
  if (!billingAvailable() || !deviceId) return false;
  if (configuredFor === deviceId) return true;
  const P = getPlugin();
  await P.configure({ apiKey: BILLING_KEY, appUserID: deviceId });
  configuredFor = deviceId;
  return true;
}

/** The two plans, priced by the store. Empty when billing is off or unreachable. */
export async function loadOffers(deviceId: string): Promise<PlanOffer[]> {
  if (!(await configureBilling(deviceId))) return [];
  const P = getPlugin();
  const { current } = await P.getOfferings();
  const out: PlanOffer[] = [];
  if (current?.monthly) out.push({ plan: "monthly", price: current.monthly.product.priceString, pkg: current.monthly });
  if (current?.annual) out.push({ plan: "yearly", price: current.annual.product.priceString, pkg: current.annual });
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
