# iOS release from the command line

Verified 2026-10-09 (build 2026100901). No Xcode GUI. Keys live in
`~/.appstoreconnect/private_keys/` (never in the repo). Issuer ID
`6d956ebe-b0b8-43a9-8bb0-3ab92e66a4e1`, key `2BH6NC23C4` (App Manager).

1. Bump `CURRENT_PROJECT_VERSION` in `ios/App/App.xcodeproj/project.pbxproj`
   (every occurrence; format YYYYMMDDNN), then `npx cap sync ios`.
2. Archive:
   `xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -destination 'generic/platform=iOS' -archivePath $S/App.xcarchive archive -allowProvisioningUpdates -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_2BH6NC23C4.p8 -authenticationKeyID 2BH6NC23C4 -authenticationKeyIssuerID 6d956ebe-b0b8-43a9-8bb0-3ab92e66a4e1`
3. Export with manual signing (`ExportOptions.plist` here). Both targets need
   an App Store profile: the app and the Live Activity extension
   `com.isitbeachday.app.beachsession`. Installed profiles "IsItBeachDay
   AppStore Push" + "IsItBeachDay BeachSession AppStore" expire 2027-06-10.
   `xcodebuild -exportArchive -archivePath $S/App.xcarchive -exportPath $S/export -exportOptionsPlist scripts/ios-release/ExportOptions.plist`
4. Upload: `xcrun altool --upload-app -f $S/export/App.ipa -t ios --apiKey 2BH6NC23C4 --apiIssuer 6d956ebe-b0b8-43a9-8bb0-3ab92e66a4e1`
5. ASC API (`asc.mjs` signs a fresh ES256 JWT per call): wait for the build's
   `processingState` = VALID, then add it to the Internal Testers beta group
   (`9247b08b-593d-4ff9-8a55-64fb9e83b286`; it does NOT auto-receive builds)
   and attach it to the App Store version draft. The app's ASC id is
   `6779072992`.

## Apple Watch app (version 1.3, build 2026101401)

The watch app ships INSIDE the iPhone app build. There is no separate archive,
upload or ASC app record: step 2's archive of the `App` scheme builds and embeds
it, and step 4 uploads one `App.ipa`. `scripts/ios/build-testflight.sh` runs the
whole recipe and uses the same `ExportOptions.plist` as step 3 (one shared file,
four profiles).

| Target | Bundle id | What it is |
| --- | --- | --- |
| `App` | `com.isitbeachday.app` | iPhone app. Embeds the watch app ("Embed Watch Content"); has the `WatchSync` Capacitor plugin (`App/WatchSyncPlugin.swift`). |
| `BeachDayWatch` | `com.isitbeachday.app.watchkitapp` | watchOS 10+ app, display name "Beach Day". Companion of the iPhone app; also runs alone (it reads `app.isitbeachday.com/api/watch/<slug>`). |
| `BeachDayWatchWidget` | `com.isitbeachday.app.watchkitapp.widget` | watchOS widget extension: circular, rectangular and inline complications and the Smart Stack widget. Embedded in the watch app. |
| `BeachDayWatchTests` | `com.isitbeachday.app.watchkitapp.tests` | Unit tests (decoder, widget refresh policy, payload rules). Not shipped. |

Source folders: `ios/App/BeachDayWatch/`, `ios/App/BeachDayWatchWidget/`,
`ios/App/WatchShared/` (compiled into both watch targets),
`ios/App/BeachDayWatchTests/` and `ios/App/Shared/WatchSyncPayload.swift`
(compiled into all of them).

Account state (done 2026-10-14): the two watch App IDs, the App Group
`group.com.isitbeachday.app` on all three App IDs, and the profiles
`IsItBeachDay AppStore Push` (remade with the group), `IsItBeachDay Watch
AppStore` and `IsItBeachDay WatchWidget AppStore`. All four profiles are listed in
`ExportOptions.plist`; a missing mapping fails the export, not the archive. The
BeachSession profile did not change.

**Every target shares one version and build number** (`MARKETING_VERSION` 1.3,
`CURRENT_PROJECT_VERSION`): step 1's bump (and `build-testflight.sh`'s) replaces
every occurrence, and `lib/watchSync.test.ts` fails if they differ. Build
`2026100901` was already uploaded, so a new upload needs a new number.

**Privacy manifests.** `PrivacyInfo.xcprivacy` is in the iPhone app, the watch app
and the widget, each declaring UserDefaults reason `1C8F.1` (App Group). The code
has no `UserDefaults.standard` use outside DEBUG, so no second reason is needed.
Capacitor ships its own manifests; Xcode merges them for the privacy report.

**App Store Connect: do these by hand for version 1.3.**
1. Open the app's 1.3 version, then the Apple Watch section, and add **Apple Watch
   screenshots** (required once a watch app is in the build). Ready files are in
   `screenshots/appstore/watch-1.3/`: `416x496-series-10-11-12/` (Series 10, 11,
   12) and `422x514-ultra-3-4/` (Ultra 3 and 4), 4 PNGs each, no alpha. The
   accepted sizes are listed at
   developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications.
   Use one size set for every localization.
2. Add a line about the watch to the description, for example: "Apple Watch: see
   the Beach Day score, flags, rip current status and best time on your wrist, and
   add a complication to your watch face."

**How the beach reaches the watch.** The web app calls
`WatchSync.setBeaches({homeSlug, favorites, lastViewedSlug})` (`lib/watchSync.ts`)
when the home beach changes, when a beach page is opened, and on every app open
or return to the foreground; calls are single-flight. The plugin (one serial
queue; the web view URL is read on the main thread) keeps the values in the App
Group and sends them with WatchConnectivity `updateApplicationContext`. It
reactivates a failed session and reports a refused send to JS so JS tries again.
The watch shows: a beach picked on the watch, else the home beach, else the beach
last viewed on the phone. The web app has no favorites list yet, so `favorites`
is always empty.

**What the watch shows is decided on the server.** `GET /api/watch/<slug>`
(`lib/watchView.ts`) is under 2 KB and edge-cached like the conditions route. It is
built from the website's own rules (`deriveMetrics`, the hazard assessments in
`lib/hazards/assess.ts`, `lib/ripRisk`, `goodWindow`), so flags (several at once),
the most recent strike within 5 mi, bacteria advisories, the independent rip
model and stale-radar handling match the page. The watch only decodes it
(every field optional, bad lines skipped, numbers range-checked). It must be
deployed before this build ships, or the watch shows "Beach not found". Deploying
the web app is not part of the iOS release recipe.

**Complication budget.** `WatchShared/WidgetRefreshPolicy.swift`: a reading
received in the last 30 minutes is shown with no request; failures back off 30,
60, 120 minutes; no beach chosen means no reload; snapshots use the cache only;
the app reloads the widget once, after it saves new data.

Other notes:

- The watch beach list is bundled: `ios/App/WatchShared/Beaches.json`. After adding
  a beach in the admin console, run `node scripts/ios-watch/export-beaches.mjs`.
  Until the next release the new beach is missing from the picker (a phone-synced
  beach still works).
- `ScoreBands.swift` mirrors `lib/scoreBands.ts`; `lib/watchSync.test.ts` fails if
  they drift.
- Simulator checks: DEBUG-only launch arguments (`-debugHome`, `-debugLastViewed`,
  `-debugOffline 1`, `-debugWatchJSON <dir>`, `-debugScreen picker|complications`,
  more in `BeachDayWatch/DebugHooks.swift`). `docs/watch/` has screenshots.
- Unit tests: `xcodebuild -project ios/App/App.xcodeproj -scheme BeachDayWatch -destination 'platform=watchOS Simulator,name=Apple Watch Series 12 (46mm)' CODE_SIGNING_ALLOWED=NO test`
- Build for a watch simulator: same command with `build`.
- TODO later: Plus personal score on the watch (hook in
  `WatchShared/BeachSummary.swift`), watch-side favorites.
