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

## Verdict

Build it, but not exactly as planned.

The core idea is sound: ActivityKit is a strong fit for a bounded beach session, on-device countdowns are the right backbone, and the shared hazard assessment is a good foundation. The current plan has four material flaws:

1. A 20-minute `staleDate` conflicts with “push only on meaningful change” unless you send periodic freshness heartbeats.
2. The Live Activity token cannot live as another field on `devices`; it is per activity, rotates, and has a different lifecycle from the normal APNs device token.
3. The current alert runner skips evaluation entirely when a device lacks a normal notification token, which would incorrectly starve an otherwise-valid Live Activity.
4. Lightning “approaching/receding” is not supported by the current hazard assessment. Comparing successive nearest strikes would be misleading because they may be different flashes.

I could not load issue #18 because `gh` could not reach GitHub, so this review uses the supplied issue text and the current checkout. No files were modified.

## The seven questions

### 1. Start trigger: automatic or explicit?

Use automatic start when Beach Mode arms, but only after a one-time explicit Live Activity opt-in.

A separate tap for every beach visit is needless friction. However, silently placing beach/location information on someone’s Lock Screen the first time Plus auto-arms is too surprising. Add a setting or first-run choice such as:

> Automatically show a Beach Session on my Lock Screen while Beach Mode is active.

Then:

- Manual “Heading to the beach” starts it as part of that tap.
- Foreground auto-arm starts it automatically only if the preference is enabled.
- Turning Beach Mode off ends it immediately and records the existing Off suppression.
- Dismissing the Live Activity must not disarm Beach Mode or disable ordinary alerts, but it should suppress automatic recreation during that same session.

The existing auto-arm runs only while the app is open and after a validated fresh location check ([BeachModeCard.tsx](/Users/yitzfrid/Projects/bocabeach/components/plus/BeachModeCard.tsx:219)), so it satisfies the foreground-start requirement. ActivityKit normally permits starts only while the app is foregrounded; push-to-start is a separate later capability. [Apple also expects Live Activities to correspond to a current, understandable task](https://developer.apple.com/design/human-interface-guidelines/live-activities).

Privacy and battery:

- Do not put coordinates, a device identifier, or profile data in the attributes/state.
- Clearly disclose that beach and hazard information appears on the Lock Screen.
- Consider marking sensitive detail as privacy-sensitive in SwiftUI.
- The Live Activity itself cannot fetch location or network data, and timer text is efficient; the push and foreground-location cadence dominate battery use. Activity extensions run in their own sandbox and cannot fetch network/location data directly. [Apple ActivityKit constraints](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities?changes=_2)

Do not adopt push-to-start merely to reproduce something the app already knows during a foreground Beach Mode arm.

### 2. Update budget and frequent updates

“Meaningful change plus on-device timers” is the right policy, but it is not sufficient as currently stated because of `staleDate`.

If the state does not change for an hour and no push is sent, a `staleDate` of `lastUpdate + 20 minutes` makes a healthy activity look stale. Choose one:

- Send a low-priority freshness heartbeat every approximately 15 minutes, advancing `stale-date` to about 20–25 minutes ahead.
- Or use a much later stale date, accepting that weather fields can appear current when the backend stopped evaluating them.

I recommend the heartbeat. It is roughly 32 low-priority pushes over a full eight-hour session, plus actual changes. That is a reasonable design target, but Apple’s budget is dynamic and not a contractual quota.

Do not request `NSSupportsLiveActivitiesFrequentUpdates` initially. This feature is not genuinely high-frequency: the source evaluation runs every five minutes, while timers update without pushes. The key gives a higher budget but also creates a separate frequent-update permission state that must be observed through `frequentPushesEnabled`. [Apple’s frequent-update documentation](https://developer.apple.com/documentation/activitykit/activityauthorizationinfo?language=objc)

Use:

- `apns-priority: 5` for heartbeats and ordinary condition changes.
- `apns-priority: 10` only for urgent lightning promotion and possibly a timely end.
- One coalesced desired state per activity, never one push per changed field.
- A monotonic APNs event timestamp per activity so overlapping cron executions cannot deliver older state over newer state.
- Hysteresis and quantization, for example: score band or a meaningful score delta, wind buckets, wave changes of roughly 0.5 ft, and enum changes for clarity/seaweed.
- Immediate bypass of the ordinary debounce when lightning first becomes active or escalates.

Apple explicitly recommends updating only when new content exists, and high-priority updates consume more of the budget. [Apple’s Live Activity push guidance](https://developer.apple.com/videos/play/wwdc2023/10185/)

### 3. `staleDate`, relevance score, and dismissal

Recommended defaults:

- `stale-date`: `evaluationTime + 20–25 minutes`, but only if a heartbeat is sent no later than approximately 15 minutes after the preceding successful update.
- If required feeds fail or are already stale, do not keep extending freshness. Send a state that renders “Conditions unavailable” or allow it to become stale.
- `relevance-score`: `50` normally, `100` while the shared lightning assessment is active, and `0` on end. This is mostly moot if you enforce one Beach Session per device, but it provides sensible behavior if duplicates occur.
- `dismissal-date`: immediate for user-requested Off; approximately 10–15 minutes after natural session expiry if a short “Session ended” state is useful. Do not leave it for the default four hours.

A Live Activity can remain active for at most eight hours, after which iOS ends it and removes it from Dynamic Island; it may remain on the Lock Screen for up to four more hours unless explicitly dismissed. [Apple duration and ending behavior](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities?changes=_2)

The existing Beach Mode server cap is eight hours ([plus.ts](/Users/yitzfrid/Projects/bocabeach/lib/db/plus.ts:24)), but repeated extensions can keep Beach Mode alive longer than eight hours from the Live Activity’s original start. Track the ActivityKit start time separately and never assume an extended presence row extends the same Live Activity beyond Apple’s hard limit.

### 4. Lightning breakthrough and double-alerting

Do not send both an alerting Live Activity update and the existing time-sensitive notification for the same lightning event.

Apple’s guidance is unusually direct here: do not use an ordinary push notification alongside a Live Activity alert for the same update. [Live Activity HIG](https://developer.apple.com/design/human-interface-guidelines/live-activities)

Recommended policy:

- Preserve the normal lightning notification as the interruption mechanism. It works when the Live Activity is absent, disabled, dismissed, or stale, and it remains in Notification Center.
- Send the matching Live Activity update silently, promoting lightning to the hero.
- Use an alerting Live Activity update only if ordinary lightning notifications are disabled and the user separately opted into Live Activity alerts—or omit alerting Live Activity updates entirely in v1.

On iPhone, a Live Activity alert expands the Dynamic Island or presents the activity as a banner; it is not simply another normal notification. [Apple’s AlertConfiguration behavior](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities?changes=_2) It can still light the screen and play sound, so sending both produces exactly the duplicate interruption Apple advises against.

The hero must consume the exact device-anchored `HazardAssessment` used for the alert, not independently test `lightningMiles <= 5`. Currently, `evaluateAtBeach` constructs the assessment privately and discards it after producing alert subjects ([evaluate.ts](/Users/yitzfrid/Projects/bocabeach/lib/alerts/evaluate.ts:118)). Refactor the session evaluator to return the assessment along with alert decisions and Live Activity state.

One qualification: the score is intentionally beach-anchored, while at-beach alerts are device-anchored ([LOCATION_FIRST_PLAN.md](/Users/yitzfrid/Projects/bocabeach/docs/LOCATION_FIRST_PLAN.md:5)). They can legitimately differ because they answer different geographic questions. The Lock Screen should label this clearly—score for the beach, lightning “near you”—rather than claiming they are the same assessment. They must use the same rules for equivalent inputs, not necessarily the same anchor.

Also: do not ship “approaching/receding” yet. The source provides a bearing but no defensible motion trend ([lightning.ts](/Users/yitzfrid/Projects/bocabeach/lib/sources/lightning.ts:36)). Consecutive nearest flashes are not a tracked storm object. Ship bearing, distance, observation age, and latched status first. Add trend only after defining and testing a real cluster/cell-motion algorithm.

### 5. ContentState and the 4 KB limit

The proposed state is comfortably below 4 KB, but the limit includes static attributes plus dynamic state, and malformed or incompatible state can be silently ignored. [Apple’s 4 KB rule](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities?changes=_2)

Derive on-device:

- `verdict` from `score`.
- Golden-hour boundaries from sunset if the product definition is a fixed offset.
- “Rising/falling” from the next tide’s kind rather than carrying both `tideFalling` and event type.
- Cardinal wind direction from numeric degrees.
- Cardinal lightning bearing from numeric degrees.
- Display strings, units, rounding, colors, and accessibility labels.

Prefer compact numeric epochs over ISO strings. A reasonable state is:

- `score`
- wind speed, gust, and direction degrees
- wave height
- clarity and seaweed enums
- next tide epoch and `high|low`
- sunset epoch
- optional lightning projection: active/latched, distance, bearing, observed epoch, hold expiry, and eventually a validated trend
- `updatedAt`
- schema version/state sequence

Make new fields optional or provide custom decoding defaults. This matters more than raw size because the remote website and server can deploy immediately while old native extensions remain installed. Never rename fields or change their types for an existing schema. Store the supported schema/app build on the activity row and encode the appropriate payload version.

### 6. Capacitor, tokens, App Groups, SPM, and signing

The bridge should not be shaped around `getPushToken()` as a one-time getter.

Use:

- `start(...) -> { activityId, state }`
- `update(activityId, state)`
- `end(activityId, finalState, dismissalPolicy)`
- `getStatus()` or `listActivities()`
- a token-change listener, with native code continuously consuming `activity.pushTokenUpdates`
- an activity-state listener so dismissal/end is sent to the server

Each Live Activity gets its own update token, and that token may rotate. Apple says to observe the async sequence, update the server, and invalidate the old token. [Apple token lifecycle](https://developer.apple.com/documentation/activitykit/activity/pushtoken?changes=_8)

`pushToStartToken` is app/activity-type scope for starting future activities; it is not the token used to update an already-running activity. Do not store or expose it in v1.

The existing Capacitor `.then` hazard is real and already well documented in [native.ts](/Users/yitzfrid/Projects/bocabeach/lib/push/native.ts:96). The Live Activity resolver must likewise be synchronous: never return or await the plugin proxy itself; only await actual method calls and listener handles.

For the remote-URL WebView:

- Restrict bridge use to the trusted `https://app.isitbeachday.com` origin and prevent arbitrary navigation from retaining native API access.
- Validate all arguments in Swift, including schema version, slug, dates, score bounds, and session ownership.
- Prefer native code uploading token rotations directly, because a background token rotation may occur when the WebView JavaScript is not alive.
- Never log activity tokens; they are bearer capabilities.
- Do not equate normal notification authorization with Live Activity authorization.

No App Group is required for this plan. ActivityKit transports attributes and content state to the extension. Add an App Group only if the app and extension must share files/preferences beyond ActivityKit state.

SPM does not remove the need for an actual Widget Extension target. The current Capacitor package is explicitly CLI-managed ([Package.swift](/Users/yitzfrid/Projects/bocabeach/ios/App/CapApp-SPM/Package.swift:4)); do not wedge the extension target into that generated package mechanically. Add the extension target, shared Swift model source/package, embed phase, Info keys, and target-specific availability deliberately.

Signing is a release blocker, not cleanup:

- New extension bundle ID, for example `com.isitbeachday.app.beachsession`.
- Registered App ID and distribution provisioning profile for that bundle ID.
- Extension profile added to manual export options alongside the main app’s profile.
- Matching team, signing certificate, version/build numbers, and embedding.
- Verify the Release archive rather than relying on Debug automatic signing.

The current project has one automatically signed application target and an iOS 15 deployment target ([project.pbxproj](/Users/yitzfrid/Projects/bocabeach/ios/App/App.xcodeproj/project.pbxproj:298)). The existing “automatic archive, manual export” recipe will fail at export unless the extension’s profile is explicitly mapped.

The APNs sender also needs a distinct Live Activity path. The current implementation hardcodes normal alert payloads, `apns-push-type: alert`, and the app topic ([apns.ts](/Users/yitzfrid/Projects/bocabeach/lib/push/apns.ts:105)). Live Activity requests require:

- `apns-push-type: liveactivity`
- topic `<main bundle id>.push-type.liveactivity`
- priority `5` or `10`
- ActivityKit `timestamp`, `event`, and `content-state`

Do not let a dead Live Activity token clear the device’s normal APNs token.

### 7. iOS floor

Use iOS 16.2 as the feature floor.

Keep the host app’s existing iOS 15 support if it is still valuable, give the extension a 16.2 deployment target, and guard all host-side ActivityKit code with availability checks. Users below 16.2 simply retain Beach Mode and normal notifications.

Do not raise the floor to 17.2 for push-to-start. Beach Mode already arms in the foreground, so push-to-start adds token lifecycle and consent complexity without solving a current problem.

Do not target iOS 18 broadcast channels for this design. Broadcast is intended for many people following the same event; Apple recommends per-device tokens for person-specific activities. [Apple broadcast guidance](https://developer.apple.com/documentation/UserNotifications/setting-up-broadcast-push-notifications) Here, score/profile and device-anchored hazards differ per person. A broadcast beach channel could only carry a nonpersonal common subset and is not worth splitting the state model.

## Server and D1 model

Use one row per ActivityKit activity, not one token on `devices`.

A practical table would contain:

```text
live_activities
  activity_id       primary key
  device_id
  session_started_at
  beach_slug
  schema_version
  app_build
  apns_environment
  push_token
  token_updated_at
  started_at
  expires_at
  ended_at
  status
  last_state_json
  last_state_hash
  pending_state_json
  pending_since
  next_send_at
  last_sent_at
  last_apns_timestamp
  last_apns_status
```

Add indexes for active rows by device and expiry, plus uniqueness for active token values. Enforce one active Beach Session per device unless multiple sessions are deliberately supported.

On token rotation, atomically replace the token for that `activity_id`; never mutate the normal device token. On APNs `410`/`Unregistered` or equivalent permanent token failure, mark only that activity ended/dead. Null the bearer token promptly and retain nonsecret diagnostics briefly—perhaps 24–72 hours—then delete expired rows.

Set `expires_at` to the earliest of:

- Beach Mode expiry,
- Activity start plus eight hours,
- entitlement expiry if product policy requires it.

The registration endpoint must verify an entitled device with a matching active Beach Mode session. The current device ID is not strong authentication, so activity tokens should at least never be returned through read APIs or logs; an install credential would be a worthwhile later hardening step.

## One evaluation pipeline

Do not bolt a second “Live Activity conditions evaluator” beside `lib/alerts`.

Refactor the existing at-beach run into:

```text
armed session
  → load conditions/lightning/rain once
  → create shared hazard assessments once
  → compute score/display projection once
  → fan out:
      normal alert decisions
      desired Live Activity state
```

At present, [run.ts](/Users/yitzfrid/Projects/bocabeach/lib/alerts/run.ts:188) requires a normal push subscription and skips the device before evaluation if one is absent. That must change: evaluate every eligible armed session once, then independently deliver to whichever surfaces exist.

The five-minute cron should:

- Sweep activities due to end, including sessions no longer returned by `listArmed`.
- Evaluate active sessions once.
- Update a coalesced desired-state/outbox record.
- Send urgent lightning transitions immediately.
- Send ordinary state only after its debounce/minimum interval.
- Send the approximately 15-minute freshness heartbeat.
- Use the existing atomic send-claim concept to prevent duplicate sends from overlapping Cloudflare/GitHub runs.

On foreground Off, end locally immediately and call the server end endpoint. The cron remains the backstop when the WebView disappears before the request completes.

## Silent and degraded failures to design for

- `areActivitiesEnabled == false`: start fails or is unavailable. Return a structured result; the web card must not claim it started.
- User dismisses the activity: Beach Mode remains armed. Observe activity state, mark the row ended, and do not recreate it repeatedly in the same session.
- Token rotation is missed: APNs updates silently stop. The async token sequence must live natively.
- APNs accepts a push but the OS delays or suppresses presentation: HTTP 200 is not proof the user saw it.
- Old timestamp or schema mismatch: update may be ignored. Use monotonic timestamps and versioned Codable contracts.
- Session expires: `listArmed()` no longer returns it, so a separate due-end sweep is mandatory.
- Eight-hour ActivityKit limit: iOS ends it regardless of the D1 or Beach Mode state.
- Low Power Mode/thermal pressure: networking and display synchronization can be delayed. Timers remain the resilient element; stale UI must be honest.
- Feed outage: do not keep advancing freshness with old conditions.
- Normal notifications disabled: Live Activity updates should still work if ActivityKit is enabled.
- Live Activities disabled: normal Beach Mode alerts should still work.
- Next tide passes: the current countdown reaches zero; the five-minute pipeline must advance it to the following event rather than assuming one timestamp self-selects the next tide.

## App Review

The Live Activity helps the app look less like a thin WebView wrapper, but it does not eliminate Guideline 4.2 risk. Apple requires functionality that materially exceeds a repackaged website. [App Review Guideline 4.2](https://developer.apple.com/app-store/review/guidelines/uk/#minimum-functionality)

For review:

- Provide an immediately testable demo Beach Session or reviewer entitlement.
- Explain the native location, notifications, purchase, and ActivityKit integration in Review Notes.
- Ensure the extension is useful without waiting for real lightning or a particular tide.
- Show the Plus paywall and restore flow clearly.
- Avoid describing lightning delivery as immediate, guaranteed, or life-safety infrastructure.
- Include source age/stale presentation.
- Keep web-deployed changes backward-compatible with already-reviewed native binaries; a remote deploy must not materially turn the native bridge into an unreviewed general API.

The extension is related to the app’s core functionality, which aligns with Apple’s rule that widgets, extensions, and notifications must relate to the main app. The larger risk remains the remote WebView shell and any safety claims, not ActivityKit itself.

## Revised phasing

1. **Phase 0 — contracts and project plumbing:** versioned attributes/state, Widget Extension target, signing/export profiles, availability gates, D1 lifecycle schema, and one-active-session rules.
2. **Phase 1 — local UI:** all Lock Screen/Dynamic Island presentations, stale and ended states, accessibility, timer behavior, duplicate prevention, and a simulator demo. Include the lightning hero layout now, even if it uses fixtures.
3. **Phase 2 — bridge and Beach Mode:** one-time opt-in, start/update/end/status, native token/state observers, remote-origin restrictions, Plus gate, Off/dismiss semantics. Verify on physical devices.
4. **Phase 3 — server updates:** per-activity token registration/rotation, generalized APNs sender, coalesced outbox, heartbeat, expiry sweep, and shared-evaluation fanout.
5. **Phase 4 — lightning breakthrough:** exact shared assessment projection, silent Live Activity hero update plus one ordinary alert. Ship bearing/distance first; defer motion trend until it has a real model.

Positive assessment: the self-updating-timer backbone, bounded session, Plus tie-in, existing eight-hour cap, and one shared hazard truth are all strong design choices. The main work is lifecycle correctness, not visual design.

Review ratings: correctness is high risk until token/expiry/stale handling is fixed; security/privacy is medium risk because a remote WebView receives a capability-bearing native bridge; performance is low risk if evaluation is shared and updates are coalesced; maintainability is medium risk until the native/server schema is explicitly versioned.

**Build with changes: one-time auto-start consent; one D1 row per activity; native token/state observers; shared evaluation with independent notification and Live Activity fanout; 15-minute freshness heartbeats; no frequent-updates entitlement initially; silent lightning hero updates instead of double alerts; versioned compact ContentState; explicit expiry/end sweep; iOS 16.2 feature floor; and no approaching/receding claim until it is scientifically defined.**

