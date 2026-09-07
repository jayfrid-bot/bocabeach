// Server-side check of what RevenueCat says a device owns. Used right after a
// purchase or a Restore so the app unlocks the moment the App Store confirms,
// instead of waiting for the webhook (which still handles renewals and
// expirations later — see lib/plus/revenuecat.ts).
//
// RevenueCat's appUserID IS our deviceId (the app configures it that way), so
// one GET on /v1/subscribers/{deviceId} with the SECRET key answers "is the
// `plus` entitlement active, and until when". No I/O of our own beyond that
// call; `fetchImpl` is injectable so tests never touch the network.

export interface PlusEntitlement {
  active: boolean;
  /** Epoch ms the entitlement runs out, or null for one with no end. */
  expiresAt: number | null;
  productId: string | null;
}

/** The slice of RevenueCat's subscriber object this needs. */
interface RcSubscriberBody {
  subscriber?: {
    entitlements?: Record<
      string,
      { expires_date?: string | null; product_identifier?: string; purchase_date?: string }
    >;
  };
}

export const RC_ENTITLEMENT = "plus";
const RC_API = "https://api.revenuecat.com/v1/subscribers/";

/**
 * null means RevenueCat could not be asked (network, 5xx, bad key) — callers
 * must treat that as "unknown", never as "not entitled".
 */
export async function fetchPlusEntitlement(
  appUserId: string,
  secretKey: string,
  nowMs: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<PlusEntitlement | null> {
  let res: Response;
  try {
    res = await fetchImpl(RC_API + encodeURIComponent(appUserId), {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        "X-Platform": "ios",
      },
    });
  } catch {
    return null;
  }
  // 200 = known subscriber, 201 = RevenueCat just created an empty one.
  if (res.status !== 200 && res.status !== 201) return null;
  let body: RcSubscriberBody;
  try {
    body = (await res.json()) as RcSubscriberBody;
  } catch {
    return null;
  }
  return entitlementFromSubscriber(body, nowMs);
}

/** Pure: read the `plus` entitlement out of a subscriber body. */
export function entitlementFromSubscriber(body: RcSubscriberBody, nowMs: number): PlusEntitlement {
  const ent = body.subscriber?.entitlements?.[RC_ENTITLEMENT];
  if (!ent) return { active: false, expiresAt: null, productId: null };
  const productId = ent.product_identifier ?? null;
  if (ent.expires_date == null) return { active: true, expiresAt: null, productId };
  const expiresAt = Date.parse(ent.expires_date);
  if (!Number.isFinite(expiresAt)) return { active: false, expiresAt: null, productId };
  return { active: expiresAt > nowMs, expiresAt, productId };
}
