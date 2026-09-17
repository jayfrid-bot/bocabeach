# Is It Beach Day? — Location-feature bug report

**Repository:** `jayfrid-bot/bocabeach`  
**Audited revision:** `main` at `2d783633ec7009774cbc4ec5853db9086c2778a9`  
**Report publication date:** September 17, 2026, America/New_York  
**Application changes:** None. This publication adds audit documentation only.  
**Source index:** [Pinned file references and inspected ranges](./SOURCE_INDEX.md)

Publication note: this is the previously prepared audit of the pinned revision, not a new audit of subsequent commits. The original artifact's September 14 date was erroneous and predates the audited commit. Supporting reproduction and proposed regression-test files remain in the audit ZIP shared in the conversation; this documentation publication does not install or run them in the repository.

## Executive assessment

**Recommendation: do not treat the location-aware alert experience as release-ready until the five P1 findings below are resolved and verified on devices.** The most consequential failures are missed independent hazards, monitoring the wrong beach after travel, and saying alerts are on when there is no delivery token.

This is not just a review of an unimplemented proposal. The location and Plus code is already in the audited `main` revision. GitHub's comparison reports `beach-day-plus` at `7dd2fa2feda20eba7f5207d450b5b9986a11d20e` as 51 commits behind that revision and zero commits ahead. This report does not cover uncommitted work on a developer's computer or every other branch. [S1]

**Results:** 12 code-level findings: five P1 and seven P2. An offline harness reproduced 16 source-excerpt/control-flow failure scenarios across those findings, with six comparison checks passing. These are NOT 16 observed production incidents, NOT execution of the complete application, and NOT the repository's Vitest results. Three additional lifecycle risks are listed separately, without claiming real-device reproduction.

### Method and limits

The audit traced discovery and first-run navigation, cached/device location, Beach Mode, presence registration, hazard selection, repeat suppression, rainfall timing, notification readiness, native permission declarations, and related tests. It compared implementation with the roadmap and the newer binding build specification. Where the specification intentionally narrowed the roadmap, that distinction is explicit below.

Files were read through the connected GitHub service at the pinned commit. A complete local checkout and dependency installation were unavailable, so **the full build, TypeScript project check, Vitest suite, Playwright suite, native builds, and APNs/FCM delivery were not run**. The offline harness uses manually transcribed, source-derived logic and controlled fixtures, not the full repository modules. It does not simulate actual GPS hardware or an operating-system permission dialog.

A separate proposed Vitest regression file imports the real repository modules. It was syntax-checked, but was not project-typechecked or executed. Application security beyond these location paths, complete billing behavior, database concurrency/performance, production configuration, feed uptime, and all unrelated app features remain outside this audit's verification.

### Priority meanings

- **P1 — Release blocker for reliable location alerts:** can suppress an important alert, monitor the wrong beach, or imply notifications are deliverable when they are not.
- **P2 — Correctness fix before broad rollout:** location/permission, timing, input-validation, or forecast-completeness defects with narrower prerequisites.

## Findings at a glance

| ID | Priority | Finding | Main code area |
|---|---|---|---|
| LOC-01 | P1 | Selecting only one snapshot hazard suppresses other hazards | `alerts/evaluate.ts`, `push/notify.ts` |
| LOC-02 | P1 | A live alert window blocks beach switching and fresh-position uploads | `plus/beachMode.ts`, `BeachModeCard.tsx` |
| LOC-03 | P1 | “Safety alerts on” does not establish push-delivery readiness | `BeachModeCard.tsx`, presence route, `alerts/run.ts` |
| LOC-04 | P1 | Auto-arm retains the old beach after awaiting a fresh location | `BeachModeCard.tsx` |
| LOC-05 | P2 | Extend can silently change a manually armed beach | `BeachModeCard.tsx` |
| LOC-06 | P2 | The refresh path still permits a ten-minute-old cached location | `location/device.ts`, `plus/client.ts` |
| LOC-07 | P2 | Android approximate permission is incorrectly classified as denied | `location/device.ts` |
| LOC-08 | P1 | Repeat suppression carries across different beaches | `alerts/catalog.ts`, `dedup.ts`, `run.ts` |
| LOC-09 | P2 | Future-dated fixes pass the freshness check | presence route, `alerts/run.ts` |
| LOC-10 | P2 | Rain accumulation timestamps are assigned to the wrong interval | `alerts/rain.ts` |
| LOC-11 | P2 | Missing or incomplete forecast data can produce “rain clearing” | `alerts/rain.ts` |
| LOC-12 | P2 | Automatic arrival ignores the position's uncertainty | `BeachModeCard.tsx`, `plus/beachMode.ts` |

## Detailed findings

### LOC-01 — One selected hazard hides separate active hazards

**Priority:** P1. **Evidence:** source inspection and three offline reproductions. [S5, S6]

`activeSafety()` returns a single highest-priority condition. `snapshotHazard()` calls it and immediately returns `null` when that condition is lightning, because the alert engine intends to substitute the device-based lightning calculation. It does not go back and examine the remaining warnings. The same one-hazard design also filters preferences only after selection.

**Reproduction A:** Supply a snapshot with lightning four miles from the beach centre and a Tornado Warning. Supply no qualifying device-based strike. `activeSafety()` selects lightning; `snapshotHazard()` discards it; the separate severe-warning subject is absent.

**Reproduction B:** Supply high rip-current risk and a double-red flag together. High rip risk is selected first. The closure is never made into its own alert subject.

**Reproduction C:** Supply a water advisory and double-red flag; disable water-advisory notifications but leave flag notifications enabled. The selected water advisory is filtered out and the enabled closure notification is not reconsidered.

**Impact:** A user can miss a distinct warning even though the required data exists. This is not merely notification ordering. The fixture results establish missing subjects, not that a specific real-world user missed a push.

**Fix direction:** Evaluate independent hazard categories, using the device geometry only for categories that support it. Apply preferences to the resulting set, then urgency, repeat controls, and any deliberate batching. Do not use the dashboard's single-headline selector as an exhaustive alert evaluator. A double-red closure should not disappear behind an informational surfing/rip message.

**Acceptance:** All three fixtures preserve the enabled severe/closure subject; device-based lightning still replaces only the centroid lightning calculation. No duplicate weaker lightning push on escalation.

### LOC-02 — Session renewal, location updates, and beach changes share the wrong gate

**Priority:** P1. **Evidence:** source inspection and two offline reproductions. [S2, S3, S4, S7]

`shouldAutoArm(now, lastArmAt, armedUntil)` prevents writes while more than one hour remains. Its inputs do not include the armed beach, the new nearest beach, or whether the fix changed. `BeachModeCard` uses that decision before calling the presence API.

**Reproduction A:** Arm Beach A for four hours. Ten minutes later, get a valid nearby fix for Beach B. Because the old window has more than one hour left, auto-arm does not switch the presence to B. This can persist for roughly the first three hours of the original four-hour window.

**Reproduction B:** Keep the existing window active and obtain a fresh client fix on foreground. The same gate can prevent uploading it. At 31 minutes, the server's `fixOf()` rejects the original stored fix as stale and falls back to the beach centre, even though the client may now have better coordinates.

**Impact:** The displayed nearby beach, the stored monitoring target, and the geometry used for notifications can disagree. The server's stale-fix fallback is intentional; withholding an available new fix is the defect.

**Fix direction:** Separate three operations: selecting/changing the monitored beach, refreshing presence coordinates, and extending the expiry. A location change should not wait for expiry renewal. Send a bounded/throttled foreground location update independently of extending the session. Define whether a deliberate manual destination remains sticky or requires confirmation before auto-switching.

**Acceptance:** A→B changes the intended target promptly; a stationary foreground refresh updates `fixAt` without shortening or unnecessarily extending the existing window. Location refresh and expiry renewal each have independent tests.

### LOC-03 — The interface can claim alerts are on without a delivery channel

**Priority:** P1. **Evidence:** end-to-end source trace and an offline state/control-flow reproduction; no real push send. [S3, S7, S8, S9, S10]

The Beach Mode card considers an unexpired presence sufficient for its armed view. The presence API accepts an entitled device without requiring a push token. The alert runner separately intersects armed devices with `listPushable()` and skips devices without a usable subscription. Notification registration lives in the separate `NotifyButton`/`enableNative` flow; the parent dashboard does not gate Beach Mode on that result.

**Reproduction:** Activate Plus but do not enable notifications. Arm Beach Mode. Presence can be stored and the card can show “Safety alerts on,” while the runner skips that device for lack of a token. Notifications disabled later in system settings also need an explicit readiness check; this audit did not exercise that OS transition.

**Impact:** A user can reasonably believe notifications will arrive when the application has not established a path to deliver them.

**Fix direction:** Model monitoring and delivery readiness separately: monitoring armed, notification permission, token registered, and settings/readiness unknown. Offer notification setup from the Beach Mode flow. Only display an unqualified alerts-on claim after the necessary checks; even then do not imply guaranteed delivery. Show the monitored beach and whether geometry uses the phone or the beach centre.

**Acceptance:** No-token and permission-denied states never produce an unqualified safety-alerts-on message. Registration failure remains visible and retryable. A valid token with an armed session follows the normal path.

### LOC-04 — Auto-arm uses a pre-refresh beach with post-refresh coordinates

**Priority:** P1. **Evidence:** source inspection and offline callback control-flow reproduction. [S3, S2]

Inside `arm()`, the code awaits `request()` and uses its result as `activeFix`, but chooses `target` from the `nearest` variable captured before that await. Automatic arming does not recompute the nearest beach or recheck the arrival radius from the returned fix. `resolveArmCoords("auto", ...)` then forwards those coordinates without an additional distance check.

**Reproduction:** Start with a stale fix near A so auto-arm begins. Resolve the new location at B, or far from all covered beaches. The pending callback still submits `slug: A` with the new coordinates. A later component render does not change the target already captured by the pending callback.

**Impact:** Monitoring can begin for a beach the person is no longer near. The server may reject the new geometry as too distant and fall back to A, retaining the wrong target rather than cancelling the arm.

**Fix direction:** Treat an arm request as a single validated decision: await a suitable fix, recompute nearest, check age/accuracy/distance, choose target, and submit. Cancel an automatic arm when the fresh fix no longer establishes arrival. Prevent older outstanding arm attempts from winning over newer user intent.

**Acceptance:** An A→B refresh arms B only under the chosen destination policy; a far-away refresh does not auto-arm A. Returned failure does not resurrect a stale arrival decision.

### LOC-05 — Extend can change the monitored destination

**Priority:** P2. **Evidence:** source inspection and offline callback reproduction. [S3]

The armed card invokes `arm(AUTO_ARM_MS, presence.source)`. When that source is manual, `arm()` chooses the current page's `slug`, not `presence.slug`.

**Reproduction:** Manually arm A; browse B while A is still active; press Extend. The request targets B. The armed card does not name the armed beach, making the change particularly hard to notice. Its displayed end time also uses the page's timezone rather than looking up the armed target's timezone.

**Fix direction:** Pass the existing presence slug explicitly for Extend. Make switching a separate action and display the target in the card. Format session time using that target's timezone, or clearly identify the time basis.

**Acceptance:** Browsing B then extending A only changes A's expiry. Switching remains deliberate and visible.

### LOC-06 — “Refresh” still allows a ten-minute cached fix

**Priority:** P2. **Evidence:** source inspection, documented API semantics, and offline option/age reproduction. [S4, S11, E1]

The app decides a session fix should be refreshed at five minutes, but `getFix()` defaults `maxAgeMs` to 600,000. `useDeviceFix.request()` does not override it, including when Beach Mode calls that request before arming. The native/browser provider may therefore satisfy that refresh with the same eight-minute-old cached position.

On a failed request, `useDeviceFix` keeps the previous session fix, and `arm()` uses `freshFix ?? fix`. A failure can consequently preserve an old position rather than explicitly downgrading the decision.

**Fix direction:** Use a stricter freshness policy for arming and foreground presence updates than for casual nearest-beach browsing. Pass `maxAgeMs: 0` or another intentionally small bound for those operations and validate the returned timestamp. Keep old readings available for display only with a stale label; do not treat them as a confirmed arrival after permission or acquisition failure.

**Acceptance:** An eight-minute OS cache cannot satisfy a fresh arm request. Failed refreshes do not auto-arm from an obsolete fix. Cached browsing can remain a separate intentional optimization.

### LOC-07 — Android approximate permission is treated as denied

**Priority:** P2. **Evidence:** source inspection, Capacitor permission contract, and offline permission fixture. [S11, E1]

The native permission check uses `perm.location ?? perm.coarseLocation`. A defined `location: "denied"` wins over `coarseLocation: "granted"`. Capacitor exposes coarse permission separately because Android can grant approximate location without granting precise location.

**Reproduction:** Return `{ location: "denied", coarseLocation: "granted" }`. The function returns denied, so the silent discovery path does not obtain the approximate position.

**Impact:** Nearest-beach discovery can fail despite a usable permission grant. This matters to discovery even if some Android paid features remain deferred.

**Fix direction:** Recognize fine or coarse permission appropriately and preserve precision as a separate attribute. Approximate permission can support a general nearby-beach list without being sufficient for an automatic at-beach assertion.

**Acceptance:** Coarse-only access supports discovery; Beach Mode applies its own accuracy policy; true denial stays denied. Add native-bridge fixtures rather than relying solely on browser permission tests.

### LOC-08 — Alerts at Beach B inherit Beach A's repeat suppression

**Priority:** P1. **Evidence:** source inspection and offline key/window reproduction. This is a location-correctness/design flaw in the current per-device repeat policy, not a claim that implementation violates the specification's wording. [S12, S13, S7]

Push collapse tags include the beach slug, but `dedupKeyFor()` does not. The runner retrieves the previous mark using only device ID and dedup key. Distinct collapse tags do not help if the second alert is suppressed before sending.

**Reproduction:** A double-red alert is marked at A. Five minutes later the device monitors B, which also has a double-red flag. B's decision uses the same `flag:double-red` key and is held for the remainder of A's 30-minute window.

**Related source finding:** `recentRain()` reads `rain-soon` and `rain-wet` by device only, ignoring the beach stored in metadata. Rain history from A can qualify a rain-clearing message at a dry B within the three-hour memory window. That additional outcome was traced in source, not separately executed in the offline harness.

**Fix direction:** Include the monitored beach or presence-session identity in repeat and rain-memory state. Update lookup, write, supersession, send-claim, and migration behavior together; changing only the push collapse tag is insufficient. Preserve lightning escalation semantics within the same monitored context.

**Acceptance:** The same closure at a newly monitored beach is eligible immediately; repeat notices at the same beach still obey the cooldown; rain history cannot leak between destinations.

### LOC-09 — Future-dated fixes bypass the freshness check

**Priority:** P2. **Evidence:** source inspection and offline `fixOf()` reproduction. [S7, S8]

The presence API accepts positive `fixAt` values up to `Number.MAX_SAFE_INTEGER`. `fixOf()` rejects old timestamps with `nowMs - fixAt > FIX_MAX_AGE_MS`, but has no future-skew bound. A future timestamp yields a negative age and passes.

**Reproduction:** Submit a nearby, accurate fix dated 24 hours ahead. The server-side selector accepts it as device geometry. It can remain apparently fresh throughout a renewed/active session; this does not bypass the separate maximum arming-window limit.

**Related input issue:** Invalid provided `accuracyM` values become `null` without a request rejection. The selector permits an absent accuracy, so malformed supplied precision can become indistinguishable from unreported precision. That validation path was inspected, not exercised through a live route.

**Fix direction:** Enforce an explicit small clock-skew tolerance and reject or downgrade future timestamps on the server. Track receive time independently of device time. Validate every supplied precision/timestamp field; decide deliberately how genuinely missing precision is handled.

**Acceptance:** Future, stale, malformed, and acceptable-skew fixtures are distinct. Invalid supplied accuracy does not silently become trusted missing data.

### LOC-10 — Rainfall accumulation is shifted into the next 15-minute interval

**Priority:** P2. **Evidence:** source inspection, provider documentation, and offline parser reproduction. [S14, E2]

Open-Meteo defines each 15-minute precipitation value as an accumulation over the preceding interval. `parseMinutely()` treats that timestamp as the start of the following interval instead.

**Reproduction:** At 13:05 UTC, a wet precipitation value timestamped 13:15 describes the 13:00–13:15 bucket. The current parser classifies that value as future and returns `etaMinutes: 10`, with `rainingNow: false`, because it assigns the value to 13:15–13:30.

**Impact:** The bucket-to-time mapping is displaced by 15 minutes, affecting rain-now, starting, and clearing decisions. An accumulated forecast does not establish the exact minute rain begins; the defect is the interval interpretation, not proof that rain actually started at 13:00.

**Fix direction:** Interpret accumulated precipitation as ending at its timestamp and keep instant/probability fields' semantics separate. Avoid asserting minute-precise onset from a 15-minute accumulation alone.

**Acceptance:** Tests cover the interior and boundaries of accumulation intervals, UTC midnight, and current-versus-upcoming classification.

### LOC-11 — Unknown or short rain forecasts become reassuring clearing signals

**Priority:** P2. **Evidence:** source inspection and two offline parser reproductions. [S14]

`wet()` returns false when precipitation and probability are both missing. Any future timestamp sets `anyAhead`, even when it has no usable value. `clearingSoon` requires only `anyAhead && !wetAhead`, not valid coverage of the stated one-hour horizon.

**Reproduction A:** Supply future timestamps with neither precipitation nor probability arrays. The parser returns `clearingSoon: true` rather than unknown.

**Reproduction B:** Supply a single upcoming dry bucket. The parser again returns clearing, even though it cannot establish a dry hour. The request uses `forecast_days=1`; day-end truncation is an additional boundary worth testing, not a live API failure observed here.

**Impact:** A user with recent rain history can receive a clearing message based on missing or insufficient information.

**Fix direction:** Represent wet, dry, and unknown distinctly. Require valid continuous coverage for the promised clearing horizon. Fetch enough steps across the day boundary, and keep unknown conservative rather than converting it to dry.

**Acceptance:** Missing arrays, null values, gaps, partial coverage, and truncated days cannot produce an unqualified clearing message. A complete dry forecast can.

### LOC-12 — A low-precision fix can establish automatic arrival

**Priority:** P2. **Evidence:** source inspection and offline distance/accuracy reproduction. [S3, S2, S7]

The card's `atBeach` decision checks only whether the reported point is within two miles of a served beach. It does not inspect the reported accuracy or freshness. Automatic coordinate selection forwards any provided fix. The server later downgrades inaccurate geometry, but still retains the armed beach.

**Reproduction:** Return coordinates close to a beach with `accuracyM: 50000`. The client qualifies for automatic arming even though that fix cannot reliably establish arrival. The server falls back to the beach centre instead of correcting the original arrival assertion.

**Fix direction:** Apply age and uncertainty criteria before auto-arm. Use an accuracy-aware arrival policy, with stable entry/exit thresholds if needed, and offer manual destination monitoring when arrival is uncertain. Discovery permission and high-confidence presence should be separate decisions.

**Acceptance:** Approximate fixes can produce a clearly labelled nearby list without claiming the user is at a particular beach. Precise, fresh fixes inside the radius can establish arrival.

## Additional lifecycle risks — require mounted/native tests

These are not additional reproduced production bugs and are not included in the 12-finding count.

**R-01 — Automatic writes before saved state is loaded (high-priority integration check).** The rendered loading state depends on `deviceLoaded`, but the auto-arm effect does not. Its local Off suppression also begins as null and is loaded in an effect. With a cached entitlement and session fix, verify that auto-arm cannot overwrite existing manual presence or act before a saved Off suppression is adopted. Gate side effects on state readiness, not just the visual loading message. [S3, S4]

**R-02 — Older asynchronous results can win (integration check).** Multiple `useDeviceFix` consumers can independently request positions on foreground; there is no shared in-flight request or timestamp ordering in `setSessionFix()`. Arm callbacks can also outlive their original page. Test out-of-order location and presence responses during rapid app switching/navigation. Only the latest applicable user intent should update presence. [S4, S3]

**R-03 — Dismissing discovery does not cancel the pending result (UI check).** `FirstRunBanner.dismiss()` hides the banner, but a pending `find()` continuation still sets the home beach and redirects after success. Test dismissal while the location request is unresolved. Dismissal should cancel the pending navigation/home change, not only remove the visible banner. [S15]

## Planned limitations and product-precision gaps — not newly discovered defects

**Background arrival/departure is not implemented by design.** The roadmap explicitly chooses foreground/While Using access and defers background location. Do not describe the current feature as continuous tracking or automatic background geofencing. The iOS usage strings and Android coarse/fine declarations exist; this audit did not find missing location declarations in the files inspected. [S16, S17, S18]

**Exact phone geometry has a limited lifetime.** The binding spec and server deliberately fall back to the beach when a fix is stale, inaccurate, or too far away. That is a protective behavior. The product should disclose which location is being monitored, especially during a long background session. LOC-02 and LOC-06 address avoidable failures to supply a fresh usable fix. [S7, S19]

**Radar rainfall is beach-based in the current implementation.** A fresh radar read is cached as `radar:<slug>` and does not use the phone's point. Forecast fallback uses a location cell. The older roadmap described the radar pixel containing the phone; the newer binding spec explicitly allows the presence beach's radar. Treat this as a product/specification reconciliation, not an unambiguous failure to follow the latest contract. “Where you stand” copy should distinguish exact-position lightning from beach/cell-based rain. [S14, S16, S19]

**Lightning delivery has a documented latency limitation.** The roadmap already warns of a potential roughly 15-minute feed-plus-cron delay and defers faster ingestion. That is a documented architectural estimate, not a latency measurement from this audit. Do not market the resulting notification stream as an immediate or guaranteed safety warning system. [S16]

**Multi-beach monitoring, quiet hours, and later alert types are roadmap items.** Their absence should not be entered as regressions unless they have become requirements for the current release. [S16]

## Test coverage and release acceptance

The inspected `lib/location/device.test.ts` explicitly covers the web path and says the native bridge path is not exercised there. `components/plus/BeachModeCard.test.ts` tests the pure renewal helper, including deliberately holding a live window; it does not mount the card and test a change of beach or an independently refreshed position. This is a finding about those inspected tests, not a claim that no other tests exist anywhere. [S20, S21]

### Required end-to-end matrix

| Scenario | Required result |
|---|---|
| First launch; allow precise location | Nearest selection works; no paid-alert promise before permission/registration |
| Deny location; later grant it | Recovery works; stale positions are not presented as new arrival |
| Android approximate permission only | Discovery works; automatic arrival respects uncertainty |
| Activate Plus with notifications off | Clear setup-needed state, not unqualified “alerts on” |
| Move A→B with three hours remaining | Target follows the intended auto/manual policy immediately |
| Foreground after 31 minutes | Fresh position reaches the server; existing expiry is not accidentally shortened |
| Refresh returns far-away coordinates | Old nearby beach is not auto-armed |
| Browse B; Extend a manual A session | A remains the target |
| Off; remount; foreground | Suppression is loaded before any automatic write |
| Rapid navigation with delayed API responses | Older callbacks cannot overwrite newer presence intent |
| Same warning at a newly monitored beach | Correct new-context notification; no inherited unrelated cooldown |
| Simultaneous lightning, severe warning, closure | Relevant enabled hazards survive independent evaluation |
| Missing/null/truncated rain feed | Unknown, not reassuring clearing |
| Rain timestamp at and around UTC midnight | Correct preceding-interval mapping and sufficient horizon |
| Actual iPhone and Android delivery | Verify permission, registration, background push receipt, expired token, and fallback labels |

### Suggested implementation order

1. Fix independent hazard evaluation and cross-beach repeat/rain memory: LOC-01, LOC-08.
2. Separate target selection, position refresh, and expiry renewal; fix fresh-fix selection and Extend: LOC-02, LOC-04, LOC-05.
3. Make delivery readiness and monitored location visible: LOC-03.
4. Harden freshness, approximate permission, uncertainty, and server validation: LOC-06, LOC-07, LOC-09, LOC-12.
5. Correct rain intervals, unknown handling, and horizon coverage: LOC-10, LOC-11.
6. Exercise R-01 through R-03 in mounted/native tests, then run the project's build, typecheck, Vitest and mobile checks, followed by physical-device delivery testing.

For user-visible fixes, follow the repository's existing changelog and mobile-layout requirements. Do not remove the expiry cap, per-device entitlement checks, same-beach repeat protection, or conservative server fallback while fixing the identity/update logic. [S22]

## Delivered files and how to use them

The original audit bundle shared in the conversation contains the files below. This GitHub publication includes `BUG_REPORT.md` and `SOURCE_INDEX.md` only; the proposed tests have not been installed into the application's test suite.

- `BUG_REPORT.md`: this report.
- `repro/reproduce.cjs`: offline source-excerpt/control-flow harness, dependency-free Node.js.
- `repro/results.json` and `repro/results.txt`: actual recorded execution results.
- `regression/location-audit.regression.test.ts`: proposed tests importing real repository modules; nine test bodies plus ten explicitly pending integration cases. Syntax-checked only.
- `SOURCE_INDEX.md`: pinned file links, symbols, and inspected ranges.

From the extracted audit bundle, run the independent reproduction harness:

```bash
node repro/reproduce.cjs
```

Its “REPRODUCED” result means a controlled fixture triggers the audited failure in the extracted logic, not that the application is healthy. For work in the real checkout, copy the proposed regression file into `lib/location/`, inspect/adapt its fixtures if necessary, and run:

```bash
npx vitest run lib/location/location-audit.regression.test.ts
```

The behavior assertions are intentionally written for the corrected behavior and are expected to expose defects on the pinned revision. That expectation is not an executed repository test result. Do not report an application-wide pass from the standalone harness.

## Source references

All repository references are pinned in [SOURCE_INDEX.md](./SOURCE_INDEX.md). File paths and function names are used instead of invented exact line numbers. External references were checked against official provider documentation.

[S1] GitHub main branch and comparison with `beach-day-plus`.  
[S2] `lib/plus/beachMode.ts`: `shouldAutoArm`, `resolveArmCoords`, `resolveBeachModeView`.  
[S3] `components/plus/BeachModeCard.tsx`: `arm`, auto-arm effect, `disarm`, armed view and Extend.  
[S4] `lib/plus/client.ts`: `usePlus`, `arm`, `useDeviceFix`, `request`, `setSessionFix`.  
[S5] `lib/alerts/evaluate.ts`: `snapshotHazard`, `evaluateAtBeach`, `rainSubject`.  
[S6] `lib/push/notify.ts`: `activeSafety`.  
[S7] `lib/alerts/run.ts`: `fixOf`, `recentRain`, `runAtBeachAlerts` through the dedup loop.  
[S8] `app/api/presence/route.ts`: POST/DELETE.  
[S9] `components/NotifyButton.tsx`: permission/registration flow.  
[S10] `components/ConditionsDashboard.tsx`: native/Plus state and component wiring.  
[S11] `lib/location/device.ts`: permission selection and fix options.  
[S12] `lib/alerts/catalog.ts`: dedup key and collapse tag construction.  
[S13] `lib/alerts/dedup.ts`: `shouldFire`, `splitByDedup`.  
[S14] `lib/alerts/rain.ts`: `parseMinutely`, `rainForFix`, request options.  
[S15] `components/plus/FirstRunBanner.tsx`: `find`, `dismiss`.  
[S16] `docs/PREMIUM_ROADMAP.md`: decisions, location, accuracy, latency, later work.  
[S17] `ios/App/App/Info.plist`.  
[S18] `android/app/src/main/AndroidManifest.xml`.  
[S19] `docs/PLUS_BUILD_SPEC.md`: visible location/presence and alert contracts.  
[S20] `lib/location/device.test.ts`.  
[S21] `components/plus/BeachModeCard.test.ts`.  
[S22] `CLAUDE.md`.  
[E1] [Capacitor Geolocation documentation](https://capacitorjs.com/docs/apis/geolocation): permission aliases and cached-position age.  
[E2] [Open-Meteo forecast documentation](https://open-meteo.com/en/docs): 15-minute accumulation interval and forecast-range options.
