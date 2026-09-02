# Beach Day Plus — Premium Roadmap

Is It Beach Day · drafted 2026-09-01 · build plan. Strategy context lives in `docs/MONETIZATION_PLAN.md`; this document is what we build.

## Bottom line

One subscription — **Beach Day Plus** — with two things worth paying for: a score tuned to how *you* use the beach, and alerts computed from where *you* are standing. Free users keep everything they have today, see it the instant the app opens, and never sit through an onboarding. Plus onboarding runs once, ends with a one-time reveal of the personal score, then the paywall.

About 3.5 weeks of build in six phases. One native app build (location permission + billing SDK). Everything else ships through the normal web deploy.

## Decisions made (Sep 1, 2026)

- **All alerts are Plus, safety included.** Free = today's app; nothing is removed.
- **Location comes from the device** ("While Using"). Alerts use the person's actual fix, not the beach centroid — the accuracy is part of the product.
- **Beach Mode auto-arms** when the app is opened near a beach; manual arm is the fallback. Background location comes later, if ever.
- **Cloudflare Cron Trigger** drives the alert loop. Subscribers move from KV to **D1**; sending goes through **Queues**.
- **Seven profiles, Surf included.** Personal Beach Day score plus a separate safety line that is never diluted — and for Surf, redefined.
- **Onboarding once. Preview once.** No live personal score for non-subscribers after the reveal.
- **The app opens straight to the free dashboard, always.**

## Free vs. Plus

| | Free | Plus (proposed $2.99/mo · $19.99/yr · 3-day trial) |
|---|---|---|
| Score | Everyone's score, full dashboard, best times, 7-day outlook, cams, hazards | **Your score** — profile + advanced tuning; best times and outlook re-ranked for you |
| Safety | Cap banner, Swim safety line | Swim / Surf safety line matched to your profile |
| Location | Nearest-beach pick, near-you chip | **Beach Mode** — alerts armed from where you stand |
| Alerts | none | Every kind: at-the-beach safety, weather, planning, personalized morning digest |
| Later | | Multi-beach, quiet hours, web Plus |

## First run — and every run after

Four rules, all satisfied:

1. **All free data, right away.** Launch → free dashboard. No screens in the way. First launch only: a one-line banner "Find my nearest beach" → one tap → OS location prompt → home beach set. Answer or dismiss, it never returns.
2. **Never repeat onboarding.** Two doors to Plus live inside the dashboard: a **Personalize my score** card under the score, and the **Alerts** button. Both open the same onboarding, which runs once.
3. **See your number before paying.** Onboarding = three questions → reveal screen ("Your score today 71 · Everyone's 58 · tuned for Snorkeling") → paywall with trial.
4. **No free personal score after that.** Decline → profile and `previewSeen` saved. The dashboard shows a locked "Your score" pill — no number, no recompute. Tap → paywall, with a reminder ("On Sep 1 your score ran 13 points above everyone's"). Profile stays editable in Settings, still locked. Subscribe → personal number becomes the headline, toggle to see everyone's, alerts unlock.

Persistence: profile and flags live on the phone (localStorage, proven by the push token today) **and** on the server against a device id / subscription identity — so reinstall + Restore Purchases brings everything back without onboarding. Web stays free-tier only in v1, with "Get the app" for Plus.

## Scoring — the personal Beach Day score

### Today's engine, in one paragraph

Ten factors, fixed weights summing to 100: air temp 16, sky 16, sea state 14, wind 13, water temp 9, comfort 8, sand temp 8, seaweed 7, crowds 5, UV 4. Each factor has an "ideal" curve (air 78–88 °F, water 77–90 °F, wind 5–13 mph, calmer waves = better). Safety caps clamp the result. Pure functions, already run in the browser; best-time windows and the 7-day outlook flow from the same function; the score wheel redraws from whatever weights it is given. Personalization is a *parameter*, not a rewrite.

### Two dials

1. **Weights** — how much each factor matters.
2. **Ideals** — what counts as good: heat, water temp, waves (calm / some / surf — the surf profile flips the wave curve).

Plus one **new factor: water clarity**, already measured by the cams but not in the score. Where a beach has no cams it drops out and the other weights re-balance, as the engine already does for missing data.

### Profiles — full weight vectors (each column sums to 100)

| Factor | Everyone | Swim | Kids | Sun | Snorkel | Dog | Walk | Surf |
|---|---|---|---|---|---|---|---|---|
| Air temp | 16 | 12 | 12 | 22 | 6 | 20 | 22 | 8 |
| Sky | 16 | 14 | 16 | 28 | 10 | 12 | 14 | 10 |
| Wind | 13 | 10 | 10 | 12 | 14 | 8 | 10 | 18 |
| Waves | 14 | 20 | 18 | 2 | 22 | 2 | 4 | 30 |
| Water temp | 9 | 16 | 12 | 4 | 12 | 2 | 2 | 12 |
| Comfort | 8 | 6 | 6 | 10 | 2 | 10 | 14 | 2 |
| Sand temp | 8 | 4 | 10 | 6 | 2 | 26 | 12 | 2 |
| Seaweed | 7 | 10 | 6 | 6 | 8 | 6 | 6 | 8 |
| Crowds | 5 | 4 | 4 | 6 | 2 | 10 | 10 | 6 |
| UV | 4 | 4 | 6 | 4 | 2 | 4 | 6 | 4 |
| Clarity (new) | 0 | 0 | 0 | 0 | 20 | 0 | 0 | 0 |

Pick one profile or two; two blends the vectors.

### Ideals per profile

| Profile | Air ideal °F | Water ideal °F | Waves | Wind mph |
|---|---|---|---|---|
| Everyone / Swim | 78–88 | 77–90 | calm best | 5–13 |
| Kids | 78–88 | 79–90 | calm best, steeper penalty | 5–12 |
| Sun | 84–94 | — | — | 3–10 |
| Snorkel | 76–90 | 78–90 | calm best, steep | 3–10 |
| Dog | 68–82 | — | — | 5–15; sand curve = Underpaw paw thresholds |
| Walk / shell | 65–82 | — | — | 5–15; low-tide bonus later |
| Surf | 70–90 | 74–88 | peak 2–5 ft, poor < 1 ft | lighter better; offshore bonus where coast bearing is known |

### Safety line and cap policy

The score is personal; safety information never is. Three cap policies:

| Policy | Profiles | Caps applied to the score | Shown instead in the safety line |
|---|---|---|---|
| **Water** | Swim, Kids, Snorkel | all caps, as today | Swim safety: Safe / Caution / Stay out |
| **Shore** | Sun, Dog, Walk | weather caps only (lightning, thunder, severe, wind > 20, rain) + seaweed ceiling | Swim safety line carries flags, rip, water quality, no-swim |
| **Surf** | Surf | weather caps + double-red (beach closed) + water-quality advisory | **Surf conditions: Go / Experienced only / Closed** — red flag and high rip are information, not stop signs; high-surf advisory lifts the wave factor |

### Advanced mode

One row per factor with five stops — Doesn't matter / A little / Normal / A lot / Essential (0×, 0.5×, 1×, 2×, 3× of the profile weight, renormalized). Two range sliders for ideal air and water temperature. Wave preference: Calm / Some / Surf. Crowd sensitivity. The wheel redraws live; "Reset to Snorkeling" puts it back.

### Where it runs

- **On the phone.** The server's shared per-beach cache stays untouched; the phone re-scores from data it already receives (the full snapshot and 216 hourly buckets are already in the response). Sliders feel instant.
- **Profile also on the server** (same D1 row as the alert subscription) so the morning digest and threshold alerts speak in the user's number — "*Your* score turned Excellent." Group by (beach, profile hash) at send time; presets keep the variants per beach to a handful.
- Default weights stay the default, so the 92 scoring tests pass untouched. Pass `nowMs` in from the client (the engine's one hidden `Date.now()` is a hydration trap).
- The "why" summary sentence in `lib/explain.ts` hardcodes today's priorities — make it profile-aware ("Tuned for snorkeling: clarity and calm water lead").

## Alerts — from where you stand

### Presence and fix

On open and on every foreground: the app sends `{deviceId, lat, lon, accuracyM, fixAt}` plus the nearest served beach. **Beach Mode auto-arms** when within 2 mi of any served beach: 4 h, extended on every foreground. **Manual arm** ("Heading to the beach", 6 h) uses the last fix, or the home beach centroid if there is none — labeled as less precise.

### Alert catalog (each a toggle)

- **At the beach** (only while armed): lightning within 5 mi (repeat every 30 min; escalate when it halves to ≤2 mi), thunderstorm approaching, severe weather warning, rain starting within 30 min, rain clearing, wind gusting, red / double-red flag change, high rip, water advisory. Profile-filtered: Surf gets flag and rip as "conditions changed," not alarms.
- **Home beach** (daily): personalized morning digest, "your score turned Excellent," weekend outlook, seaweed cleared, water-temp milestone.

### Accuracy vs. scale

- **Lightning: exact, from the person's fix.** Strike-to-user distance is cheap; the strike feed is already national.
- **Rain: the radar pixel containing the fix** where MRMS is enabled, else the 15-minute forecast for the ~3-mi cell around it.
- **NWS warnings and flags** are zone- or beach-based by nature.
- Fixes snap to 0.05° cells (~3 mi) before any external fetch, so external calls scale with occupied cells (people cluster at beaches), not with users. 10,000 users ≈ a few dozen cells.
- Dedup per device per alert key in D1; nothing repeats inside 30 min except lightning escalation.

### Latency caveat

Alert age = strike-feed age (up to 10 min, on GitHub) + cron (5 min): **up to 15 minutes** for a paid lightning alert. Roadmap item: move strike ingest off GitHub (the NOAA GLM source is netCDF, heavy for a Worker; a paid real-time feed is the realistic path). Not in these phases; flagged.

## Architecture

```mermaid
flowchart LR
  subgraph phone [Phone]
    OPEN[Open / foreground] --> FIX[Device fix]
    FIX --> NB[nearest served beach]
    NB --> ARM[Beach Mode<br/>auto-arm ≤2 mi · 4 h]
    RES[/api/conditions per beach<br/>shared 120 s cache/] --> SCORE[Personal score<br/>re-scored on device]
    PROF[Profile · localStorage] --> SCORE
  end
  ARM -->|fix + slug + until| CHK[/api/presence]
  PROF -->|profile json| REG[/api/devices]
  CHK --> D1[(D1: devices · presence<br/>alert_prefs · alert_log)]
  REG --> D1
  CRON[Cloudflare cron */5] --> EVAL[evaluate armed devices<br/>lightning per fix · rain per cell<br/>NWS per zone]
  D1 --> EVAL
  EVAL --> Q[[Queue: push-send]]
  Q --> SEND[consumer: APNs / FCM<br/>batches of 100]
  MORN[08:00 local · per beach × profile] --> Q
```

### D1 schema

```sql
devices     (id TEXT PK, platform, push_token, tz, home_slug, profile_json,
             plan TEXT CHECK (plan IN ('free','plus')), entitlement_until INTEGER,
             preview_seen INTEGER, created_at, updated_at)
presence    (device_id PK → devices, slug, lat REAL, lon REAL, accuracy_m, fix_at,
             armed_until, source TEXT CHECK (source IN ('auto','manual')))
alert_prefs (device_id PK → devices, json)
alert_log   (device_id, alert_key, sent_at)  -- index (device_id, alert_key)
```

- **Cron:** `*/5 * * * *` in `wrangler.jsonc`. OpenNext's worker exports only `fetch`, so `worker/entry.js` re-exports it and adds `scheduled()` and `queue()`; wrangler `main` points there.
- **Queue:** `push-send`, batches of 100 tokens, retries on 5xx, dead tokens pruned on 410.
- **Migration:** read-both / write-new from KV for one release, then drop the KV keys. Also fixes the current bug where the push store shares a namespace with the page cache and every run scans it.
- **Billing:** RevenueCat (one SDK for iOS + Android, receipts, restore, `appUserID` = our device id) — recommended over raw StoreKit 2 + Play Billing. Entitlement mirrored into `devices.plan` by webhook.

## Phases

### 0 — Groundwork (2 days)
1. D1 database + the four tables; migrate subscribers from KV (read-both / write-new).
2. `worker/entry.js` custom entry: cron trigger + queue bindings. One-day spike; fallback is the lightning loop hitting the run route every 10 min.
3. `docs/architecture.md` (Mermaid), required by house rules for backend changes.
4. Location permission strings (iOS plist, Android manifest). Side effect: fixes the finder's location button, which silently fails in the native shell today.
5. RevenueCat account + SDK spike in the shell.

Accept: `/api/push/run` counts equal real devices; cron fires every 5 min in the Cloudflare log.

### 1 — Scoring engine (2 days)
1. `scoreBeachDay(d, opts = DEFAULT)` — weights, ideals, cap policy as parameters; threaded through hourly, best-window, multi-day.
2. Clarity factor (weight 0 by default; wheel hides zero-weight slices).
3. Safety line: `swimSafety(snapshot)` and `surfConditions(snapshot)`, pure.
4. `lib/profile/presets.ts` — the eight vectors and ideals above; `blend(a, b)`.
5. Tests: existing 92 untouched; new per-preset fixtures; cap-policy cases.

Accept: default output byte-identical to today; each preset moves the sample-day score in the expected direction.

### 2 — Personal score in the app (2 days)
1. `usePersonalScore(res, profile, nowMs)` — memoized client recompute of score, hourly, windows; debounced for sliders.
2. Dashboard: headline swaps to the personal result when entitled; "Everyone's score" toggle; wheel, explainer, cap banner, outlook strip all fed the personal result.
3. Profile-aware "why" summary.
4. Changelog entry; mobile gate at 390 px.

Accept: with a Snorkel profile on a clear-water day the headline, wheel, and best-time window all shift together; toggle shows today's number.

### 3 — Plus onboarding and paywall (3 days)
1. Doors: **Personalize my score** card, **Alerts** button.
2. Three questions → reveal screen → paywall (RevenueCat, 3-day trial).
3. Entitlement gating; locked "Your score" pill; Restore Purchases.
4. Profile persistence: localStorage + `POST /api/devices` (profile, `preview_seen`).
5. Settings sheet: profile, advanced mode, home beach.
6. Changelog entry; mobile gate.

Accept: fresh install → dashboard with no prompts; onboarding once; decline → locked pill and no recompute; subscribe (sandbox) → headline flips; reinstall + restore → no onboarding.

### 4 — Location and Beach Mode (3 days)
1. `@capacitor/geolocation` behind `lib/location/device.ts` (synchronous plugin lookup — the remote-URL shell's proxy hangs if awaited); web falls back to `navigator.geolocation`.
2. `lib/location/nearest.ts` on the shared haversine; delete the duplicate in `BeachFinder.tsx`.
3. First-run "Find my nearest beach" banner; home beach; near-you chip; `router.replace` to the home beach on later launches.
4. `POST /api/presence` with fix; auto-arm on foreground within 2 mi; manual arm; Beach Mode card + chip (Plus only; free users see the card as a door).
5. Changelog entry; mobile gate.

Accept: simulator parked at Boca opens Boca with the chip and auto-arms; parked at Orlando neither; denied permission → today's behavior.

### 5 — Alerts engine (4 days)
1. Evaluator: load armed devices, snap to cells, lightning per fix, rain per cell, NWS per zone, flags per beach; profile filters.
2. Catalog + `alert_prefs` + settings toggles; replaces the hardcoded `{morning, safety}`.
3. Queue producer/consumer; dedup + escalation in `alert_log`; dead-token pruning.
4. Personalized morning digest by (beach, profile hash).
5. Flip `PUSH_SAFETY_ALERTS` on (stays as kill switch). Retire the hourly GitHub cron after a clean week.
6. Tests: gate logic (armed / expired / far), escalation, cell snapping, dedup. Simulator run with a custom location + lightning fixture.
7. Changelog entry.

Accept: parked at Boca with a strike fixture at 4 mi → one alert within 5 min, one at 30 min, an escalation when a 1.5-mi strike is added; Orlando → nothing; expired arm → nothing.

### 6 — Ship (1 day)
Privacy page rewrite (it currently promises location is never read and never sent); App Store privacy label (precise location, linked to purchase identity); App Review notes; one native build to TestFlight; changelog entries confirmed for every user-visible phase.

**Total ≈ 17 working days.**

## Risks and open items

- **Lightning latency** (above). Decide on a real-time feed before marketing "lightning alerts."
- **App Review:** new location permission and a subscription in one build — clear purpose string, "While Using" only, no background location, paywall shows price and trial terms.
- **RevenueCat vs. direct StoreKit 2 + Play Billing** — recommend RevenueCat; confirm.
- **Price** — proposed $2.99/mo · $19.99/yr · 3-day trial; confirm.
- **Web Plus** — later (Stripe); out of scope here.
- **Two profiles blended** can produce a mushy score; the reveal screen should say which one leads.
