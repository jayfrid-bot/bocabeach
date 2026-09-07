# Beach Day Plus — turning on real billing

Status as of 2026-09-07. The goal: a real, chargeable subscription behind the
paywall, using **RevenueCat** as the billing layer. Confirmed decisions:
$2.99/mo · $19.99/yr · 3-day free trial.

## What's already true (don't redo)

- **The Paid Applications agreement is ACTIVE.** Proven: the Landfall app on the
  same account has two live, approved auto-renewable subscriptions with a
  purchase on record. Agreements are per-account, so Is It Beach Day inherits it.
  No banking/tax work is needed.
- The paywall, the 3-day server trial, the unlock code, and entitlement gating
  (`entitled()` → `plan === "plus" && entitlementUntil > now`) all work today.
- The webhook that syncs a RevenueCat purchase onto the D1 device row is built:
  `POST /api/revenuecat/webhook` (+ `lib/plus/revenuecat.ts`, tested).

## What's missing

1. **Subscription products for this app** — none exist yet (Landfall has its own).
2. **A RevenueCat project** connected to App Store Connect.
3. **The RevenueCat SDK wired into the app**, so the paywall's button actually
   buys, and one native build with it.

## Steps, in order

### 1. Create the two subscription products (App Store Connect)

App Store Connect → Is It Beach Day → **Subscriptions** → create a group
`Beach Day Plus`, then two auto-renewable products (mirror Landfall's naming):

| Product ID | Duration | Price |
|---|---|---|
| `com.isitbeachday.app.plus.monthly` | 1 month | $2.99 |
| `com.isitbeachday.app.plus.yearly` | 1 year | $19.99 |

On each: a **3-day free trial** introductory offer, a localized name +
description, and one review screenshot. Products submit for review with the next
app build. (This can be scripted via the App Store Connect API with the existing
App-Manager key — ask and it'll be done that way; pricing uses Apple's price-point
IDs per territory.)

### 2. RevenueCat project (you — it's an account signup, I can't create it)

1. Sign up at revenuecat.com (free under ~$2.5k/mo of tracked revenue).
2. Add an app → App Store, bundle `com.isitbeachday.app`.
3. Connect it: paste an **App Store Connect API key** (or the app-specific shared
   secret) so RevenueCat can validate receipts.
4. Create an **entitlement** called `plus`, attach both products to it.
5. Create an **offering** (the default) with a monthly and an annual package.
6. Copy two values for me:
   - the **public SDK key** (starts `appl_…`) → app config
   - set a **webhook**: URL `https://app.isitbeachday.com/api/revenuecat/webhook`,
     and an **Authorization header value** → I store it as the
     `REVENUECAT_WEBHOOK_SECRET` wrangler secret.

### 3. Wire the SDK (me, once step 2 gives the key)

- Add `@revenuecat/purchases-capacitor`, configure with the public key and
  `appUserID = getDeviceId()` (so the webhook's `app_user_id` maps to the D1 row).
- Point the paywall's "Start 3-day free trial" / "Subscribe" button at
  `Purchases.purchasePackage(...)`; on success, refresh entitlement (the webhook
  will also have written it). Keep the unlock code path.
- One native build → TestFlight → sandbox-test the trial → purchase → restore.

### 4. Verify

- Sandbox purchase in TestFlight flips the headline to the personal score.
- `wrangler d1 execute isitbeachday-plus --remote --command "SELECT plan, entitlement_until FROM devices WHERE ..."` shows `plus`.
- Cancel in sandbox → at expiry the row returns to `free` (the timestamp already
  enforces this even if the EXPIRATION webhook is missed).

## The one honest gate

Until step 2 (your RevenueCat signup) and step 1 (products) are done, the
"Subscribe" button still says billing is being connected. Everything else is
ready for it.
