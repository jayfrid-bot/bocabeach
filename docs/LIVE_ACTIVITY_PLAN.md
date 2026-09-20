# Beach Session Live Activity — build plan (App Store 1.2)

**Status:** reviewed, not started (2026-09-20). Supersedes the draft in GitHub issue #18. Reviewed by Codex on 2026-09-20 — verdict **build with changes**; every change is folded in below and the full review is in the appendix.

**Release plan:** 1.1 ships billing alone. This is the headline Plus feature of **1.2** and is built while 1.1 is in App Review. It needs a new native build (Widget Extension) and its own review.

## What it is

While a Plus user is at the beach (Beach Mode armed), a Live Activity on the Lock Screen and Dynamic Island shows the beach score, a sunset countdown, a next-tide countdown, wind, waves, clarity and seaweed — and promotes **lightning near you** to the hero when the shared hazard assessment says it is active.

Design rules that come from ActivityKit itself: no looping animation; the countdowns are on-device timers (`Text(timerInterval:)`) that tick with zero pushes; the server pushes only on meaningful change plus a freshness heartbeat; one hero and two or three compact stats per presentation.

## What the review changed

| Draft said | Codex found | Decision |
|---|---|---|
| Start on every Beach Mode arm, or a tap each visit | Silently putting beach/hazard info on the Lock Screen the first time is too surprising; a tap per visit is friction | **One-time opt-in**, then auto-start on arm. Manual "Heading to the beach" starts it with that tap. Off ends it. Dismissing the activity does NOT disarm Beach Mode, and suppresses auto-recreation for that session. |
| `staleDate` ~20 min + push only on change | They conflict: an hour of unchanged weather would make a healthy activity look stale | **Freshness heartbeat every ~15 min** (priority 5), `stale-date` = evaluation + 20–25 min. If feeds are stale, do NOT extend freshness — render "Conditions unavailable". |
| Request frequent updates? | Not high-frequency: evaluation is every 5 min, timers need no pushes | **Do not** request `NSSupportsLiveActivitiesFrequentUpdates` in v1. |
| Lightning hero via `AlertConfiguration` | A time-sensitive push already fires from `lib/alerts`; Apple says never send both for one event | **Silent** Live Activity update promotes the hero; the ordinary notification stays the one interruption. No alerting LA updates in v1. |
| Hero tests `lightningMiles <= 5` | Must not re-derive the rule | Hero consumes the **same device-anchored `HazardAssessment`** as the alert (`lib/hazards/assess.ts`), incl. the 30-min hold. `evaluateAtBeach` must return the assessment, not discard it. Label honestly: score is "for the beach", lightning is "near you". |
| "Approaching / receding" | Not supported by the data: consecutive nearest flashes are different flashes, not a tracked cell | **Deferred.** Ship bearing, distance, observation age, latched status. |
| Token stored on the device row | Per-activity, rotates, different lifecycle; a dead LA token must never clear the APNs device token | **New D1 table `live_activities`, one row per activity.** |
| `getPushToken()` getter in the plugin | Tokens rotate via an async sequence, possibly while the WebView is dead | Native code consumes `pushTokenUpdates` and **uploads rotations itself**; plugin exposes start / update / end / status + listeners. |
| Alert runner as-is | `lib/alerts/run.ts` skips a device with no normal push token **before evaluating** — would starve a valid Live Activity | **One evaluation, two fan-outs** (below). |
| iOS floor unspecified | — | **16.2** for the feature; host app keeps iOS 15; extension target 16.2; availability-guarded. No push-to-start (17.2), no broadcast channels (18). |
| ContentState with ISO strings + derived words | Fine for size; fragile for versioning | Compact, versioned, numeric epochs; derive verdict, cardinal directions, rising/falling, strings, colors on-device. New fields optional. Never rename or retype a shipped field. |

## Architecture

### Native (`ios/App`)
- **Widget Extension target** `com.isitbeachday.app.beachsession`, deployment target 16.2, its own App ID + distribution profile. Added deliberately — NOT wedged into the CLI-managed `CapApp-SPM` package. No App Group needed (ActivityKit carries the state).
- `ActivityAttributes` (static): beach name, slug, session start. **No coordinates, device id or profile data.**
- `ContentState` (versioned): `v`, `seq`, `score`, wind mph / gust / direction degrees, `waveFt`, clarity + seaweed enums, next tide epoch + `high|low`, sunset epoch, optional lightning `{active, latched, miles, bearingDeg, observedAt, holdUntil}`, `updatedAt`, `unavailable?`.
- **Capacitor plugin `BeachSessionActivity`**: `start → {activityId}`, `update(activityId, state)`, `end(activityId, finalState, dismissal)`, `getStatus()`, listeners for token change and activity state. Swift validates every argument (schema version, slug, dates, score bounds, session ownership). Bridge use restricted to `https://app.isitbeachday.com`. Tokens are never logged. JS side: resolve the plugin **synchronously** and never return/await the proxy itself (the `.then` trap documented in `lib/push/native.ts`).

### Server
- **D1 `live_activities`** (one row per activity): `activity_id` PK, `device_id`, `beach_slug`, `schema_version`, `app_build`, `apns_environment`, `push_token`, `token_updated_at`, `started_at`, `expires_at` (= earliest of Beach Mode expiry, start + 8 h, entitlement end), `ended_at`, `status`, `last_state_json`, `last_state_hash`, `pending_state_json`, `pending_since`, `next_send_at`, `last_sent_at`, `last_apns_timestamp`, `last_apns_status`. Index active-by-device and by-expiry; unique active token; **one active session per device**. On APNs 410 mark only that activity dead and null the token; purge rows after 24–72 h. Registration requires an entitled device with a matching armed Beach Mode session. Tokens never appear in read APIs or logs.
- **APNs**: a distinct Live Activity path in `lib/push/apns.ts` — `apns-push-type: liveactivity`, topic `com.isitbeachday.app.push-type.liveactivity`, ActivityKit `timestamp` / `event` / `content-state`, `stale-date`, `dismissal-date`, `relevance-score` (50 normal, 100 while lightning active, 0 on end). Priority 5 for heartbeats and ordinary changes; 10 only for the lightning promotion and a timely end. Monotonic timestamp per activity so overlapping cron runs cannot deliver old state over new.
- **One evaluation pipeline** (refactor `lib/alerts/run.ts`): armed session → load conditions / lightning / rain once → shared hazard assessments once → score + display projection once → fan out to (a) ordinary alert decisions and (b) the desired Live Activity state. Evaluate every eligible armed session even with no normal push token; deliver to whichever surfaces exist.
- **The 5-min cron**: sweep activities due to end (including sessions `listArmed` no longer returns); evaluate; write a coalesced desired-state/outbox; send lightning transitions immediately; send ordinary state after its debounce (score band, wind bucket, ~0.5 ft waves, enum changes); send the ~15-min heartbeat; advance the tide countdown to the following event once one passes; reuse the atomic send-claim so the two schedulers never double-send.

## Phases

0. **Contracts + plumbing** — versioned attributes/state, extension target, signing + export profiles (the current "automatic archive, manual export" recipe fails at export until the extension profile is mapped), availability gates, D1 schema, one-active-session rule.
1. **Local UI** — every presentation (Lock Screen, Dynamic Island compact / expanded / minimal), stale and ended states, the lightning hero from fixtures, accessibility, timers. Simulator-provable; no server.
2. **Bridge + Beach Mode** — one-time opt-in, start/update/end/status, native token + state observers, origin restriction, Plus gate, Off / dismiss semantics. Physical device.
3. **Server updates** — token registration + rotation, the `liveactivity` sender, coalesced outbox, heartbeat, expiry sweep, shared-evaluation fan-out.
4. **Lightning breakthrough** — exact shared-assessment projection; silent hero update alongside the one ordinary alert.

## Failures to design for (none may fail silently)
Live Activities disabled (`areActivitiesEnabled == false`) → structured result, the card never claims it started · user dismisses → row ended, no re-creation that session, Beach Mode stays armed · missed token rotation → native observer · APNs 200 is not proof of display · old timestamp / schema mismatch → monotonic timestamps + versioned Codable · session expiry → due-end sweep · the 8-hour ActivityKit limit ends it regardless of D1 · Low Power Mode delays pushes (timers are the resilient part; stale UI must be honest) · feed outage → never advance freshness on old data · notifications off must not stop LA updates, and LA off must not stop alerts.

## App Review checklist (1.2)
A Live Activity makes the app look less like a thin web view but does not remove guideline 4.2 risk. Provide an immediately testable demo Beach Session (reviewer entitlement or demo mode — it must be useful without real lightning or a particular tide); explain the native location, notifications, purchase and ActivityKit integration in the review notes; show the paywall + Restore; never describe lightning delivery as immediate, guaranteed or life-safety; show source age / stale state; keep web deploys backward-compatible with the reviewed binary.

---

# Appendix — Codex review, verbatim (2026-09-20)

