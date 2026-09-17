# Beach Day Plus — turning on real billing

## The server trial is off by default (2026-09-17)

`POST /api/devices/trial` used to grant a 3-day trial to any new device id,
guarded only by a User-Agent check — that let anyone mint unlimited free
trials from a fresh localStorage id. The App Store already gives every
eligible Apple account a real 3-day free trial through RevenueCat (see
`trialEligibility` in `lib/plus/billing.ts`), so the server route now checks
env `PLUS_SERVER_TRIAL`:

- unset or anything other than the exact string `"on"` → the route answers
  403 `{ error: "server-trial-off" }` and grants nothing.
- `PLUS_SERVER_TRIAL=on` → the original behavior (one trial per device,
  `claimTrial`'s atomic "already used" check unchanged).

Only turn it on as a **billing-outage fallback** — RevenueCat or the App
Store itself unreachable for an extended stretch — and turn it back off once
billing is confirmed working again. The paywall (`components/plus/Paywall.tsx`)
never calls this route when `billingAvailable()` is true; it only shows the
"Start 3-day free trial" button that calls it when billing is unavailable,
and switches to a plain Subscribe/honest-unavailable state once the route
answers `trial-used` or `server-trial-off`.

## Unlock code: multiple codes + rate limiting (2026-09-17)

`POST /api/devices/unlock` now accepts either the original single
`PLUS_UNLOCK_CODE` secret or a comma-separated list in `PLUS_UNLOCK_CODES` —
set both if you want to revoke one code (e.g. a leaked press code) without
rotating the code everyone else has. Every candidate is compared
constant-time.

The route is also rate limited: 5 attempts per hour, tracked independently by
IP and by deviceId on the `PUSH_KV` binding (fixed-window counters,
`lib/plus/rateLimit.ts`), falling back to an in-memory counter off Cloudflare
(dev/tests). Past the limit it answers 429 with a `Retry-After` header instead
of running the code compare at all.


**Status 2026-09-07: WIRED END TO END, awaiting a sandbox purchase test and the
review submission.** Everything below is done unless marked otherwise.

- App Store Connect: group "Beach Day Plus" (22367204) with
  `com.isitbeachday.app.plus.monthly` (6809597275, $2.99) and
  `com.isitbeachday.app.plus.yearly` (6809597421, $19.99); 175 territories priced,
  3-day free-trial intro offers in all 175, review screenshot attached — both
  **Ready to Submit** (they go to review with the next app submission).
- RevenueCat project "Is It Beach Day" (b46c13c9): App Store app `app8918e42531`
  (bundle com.isitbeachday.app, In-App Purchase key BHL4L3AX5U shared with the
  other apps), both products, entitlement `plus`, offering `default` with
  `$rc_monthly` + `$rc_annual`, webhook "Is It Beach Day server" →
  `/api/revenuecat/webhook` (verified live: real header 200, wrong 401),
  v1 secret key "isitbeachday-server".
- Worker secrets set: `REVENUECAT_WEBHOOK_SECRET`, `REVENUECAT_SECRET_KEY`.
  Public key `NEXT_PUBLIC_REVENUECAT_IOS_KEY` in `.env.local` (baked at deploy).
- iOS build **2026090701** on TestFlight carries the RevenueCat plugin.
- Gotcha learned: RevenueCat's v1 API answers 403 to a SECRET key that sends an
  `X-Platform` header. The server does not send one.

Still to do: (1) sandbox purchase on the TestFlight build (trial → purchase →
Restore) and confirm the D1 row flips; (2) the Account Holder must re-accept the
updated Apple Developer Program License Agreement; (3) submit the app + both
subscriptions for review.

The original plan follows, kept for the reasoning. The goal: a real, chargeable
subscription behind the paywall, using **RevenueCat** as the billing layer.
Confirmed decisions: $2.99/mo · $19.99/yr · 3-day free trial.

## What's already true (don't redo)

- **The Paid Applications agreement is ACTIVE.** Proven: the Landfall app on the
  same account has two live, approved auto-renewable subscriptions with a
  purchase on record. Agreements are per-account, so Is It Beach Day inherits it.
  No banking/tax work is needed.
- The paywall, the 3-day server trial, the unlock code, and entitlement gating
  (`entitled()` → `plan === "plus" && entitlementUntil > now`) all work today.
- The webhook that syncs RevenueCat onto the D1 device row is built:
  `POST /api/revenuecat/webhook` (+ `lib/plus/revenuecat.ts`, tested). It
  doesn't trust the event's own meaning — any event naming a known device
  makes it re-ask RevenueCat's live subscriber record and write that, so an
  out-of-order or retried delivery can't undo a newer renewal or revocation.

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
