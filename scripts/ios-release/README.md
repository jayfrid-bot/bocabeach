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
