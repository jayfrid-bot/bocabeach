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

## Apple Watch app (branch `watch-app`, not shipped yet)

The watch app ships INSIDE the iPhone app build. There is no separate
archive, upload or ASC app record: step 2's archive of the `App` scheme builds
and embeds it, and step 4 uploads one `App.ipa`.

What the project now has (all in `ios/App/App.xcodeproj`):

| Target | Bundle id | What it is |
| --- | --- | --- |
| `App` | `com.isitbeachday.app` | iPhone app. Now also embeds the watch app ("Embed Watch Content") and has the `WatchSync` Capacitor plugin (`App/WatchSyncPlugin.swift`). |
| `BeachDayWatch` | `com.isitbeachday.app.watchkitapp` | watchOS 10+ app, display name "Beach Day". Companion of the iPhone app, also runs on its own (it fetches `app.isitbeachday.com/api/conditions/<slug>` itself). |
| `BeachDayWatchWidget` | `com.isitbeachday.app.watchkitapp.widget` | watchOS widget extension: circular, rectangular and inline complications and the Smart Stack widget. Embedded in the watch app. |

Source folders: `ios/App/BeachDayWatch/`, `ios/App/BeachDayWatchWidget/`,
`ios/App/WatchShared/` (compiled into both watch targets) and
`ios/App/Shared/WatchSyncPayload.swift` (compiled into all three).

**Before the first release that includes the watch (account steps, not done):**

1. Register App IDs `com.isitbeachday.app.watchkitapp` and
   `com.isitbeachday.app.watchkitapp.widget`.
2. Register the App Group `group.com.isitbeachday.app` and enable the **App
   Groups** capability on all three App IDs: the iPhone app, the watch app and
   the widget. Until then the iPhone target will not sign, because
   `App/App.entitlements` now lists the group. The watch app still runs
   without it, but the complications cannot read the chosen beach.
3. Create App Store profiles for the two new App IDs named exactly
   `IsItBeachDay Watch AppStore` and `IsItBeachDay WatchWidget AppStore`
   (they are already listed in `ExportOptions.plist`), and regenerate the
   existing "IsItBeachDay AppStore Push" profile so it carries the App Group.
   The BeachSession profile does not change.
4. Step 1's version bump already covers the new targets: they use the same
   `CURRENT_PROJECT_VERSION` and `MARKETING_VERSION`, so the bump touches
   every occurrence.
5. Archive with `-allowProvisioningUpdates` only after steps 1 to 3, or Xcode
   will try to create the IDs and group itself.

How the home beach reaches the watch: the web app calls
`WatchSync.setBeaches({homeSlug, favorites})` (`lib/watchSync.ts`) whenever the
home beach changes and on every app open or return to the foreground. The
plugin keeps the values in the App Group and sends them with WatchConnectivity
`updateApplicationContext`, which delivers only the newest state, even if the
watch app is not running or is installed later. A watch pick overrides home
until the home beach changes on the phone. The web app has no favorites list
yet, so `favorites` is always empty. Free users usually have no home beach, so the
web app also sends `lastViewedSlug` (the beach page last opened, saved as
`bd:last-viewed-beach`). The watch shows: a beach picked on the watch, else the
home beach, else the last viewed beach.

Other notes:

- The watch beach list is bundled: `ios/App/WatchShared/Beaches.json`. After
  adding a beach in the admin console, run
  `node scripts/ios-watch/export-beaches.mjs`. Until the next release the new
  beach is missing from the watch picker (a phone-synced home still works).
- `ScoreBands.swift` mirrors `lib/scoreBands.ts`; `lib/watchSync.test.ts`
  fails if they drift.
- Simulator checks: `-debugHome <slug>`, `-debugOffline 1`, `-debugScreen
  picker|complications` and others are DEBUG-only launch arguments (see
  `BeachDayWatch/DebugHooks.swift`). Screenshots are in `docs/watch/`.
- Build for a watch simulator:
  `xcodebuild -project ios/App/App.xcodeproj -scheme BeachDayWatch -destination 'platform=watchOS Simulator,name=Apple Watch Series 12 (46mm)' CODE_SIGNING_ALLOWED=NO build`
- TODO later: Plus personal score on the watch (hook noted in
  `WatchShared/BeachSummary.swift`), a lean conditions endpoint (the full one
  is 17 KB gzipped for a few numbers), watch-side favorites.
