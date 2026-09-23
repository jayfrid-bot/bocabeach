#!/usr/bin/env bash
# Build the iOS app + Beach Session Live Activity extension and upload to TestFlight.
#
# Usage:  scripts/ios/build-testflight.sh <BUILD_NUMBER>      e.g. 2026092301
#
# Recipe (proven 2026-09-07 for build 2026090701, extended for the extension):
#   1. bump CURRENT_PROJECT_VERSION in the pbxproj (both targets share it)
#   2. `npx cap sync ios` (never skip — needed for the web bundle + npm plugins;
#      our local BeachSessionActivityPlugin registers itself in code via
#      BeachBridgeViewController.capacitorDidLoad(), not via the synced config)
#   3. archive with AUTOMATIC signing + the App Store Connect auth key
#      (passing PROVISIONING_PROFILE_SPECIFIER on the CLI breaks SPM package targets)
#   4. export with MANUAL signing via scripts/ios/ExportOptions.plist, which maps
#      BOTH bundle ids to their installed profiles
#   5. upload with altool
# Never commit key material; the ASC key lives in ~/.appstoreconnect/private_keys.
set -euo pipefail
BUILD="${1:?build number, e.g. 2026092301}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KEY_ID="2BH6NC23C4"
ISSUER="6d956ebe-b0b8-43a9-8bb0-3ab92e66a4e1"
KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"
OUT="${TMPDIR:-/tmp}/isitbeachday-ios-$BUILD"
mkdir -p "$OUT"

cd "$ROOT"
echo "== 1. build number $BUILD"
sed -i '' -E "s/CURRENT_PROJECT_VERSION = [0-9]+;/CURRENT_PROJECT_VERSION = $BUILD;/g" ios/App/App.xcodeproj/project.pbxproj
grep -c "CURRENT_PROJECT_VERSION = $BUILD;" ios/App/App.xcodeproj/project.pbxproj | xargs echo "   occurrences:"

echo "== 2. cap sync"
npx cap sync ios >/dev/null

echo "== 3. archive (automatic signing + ASC auth key)"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/App.xcarchive" \
  -allowProvisioningUpdates -authenticationKeyPath "$KEY_PATH" \
  -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ISSUER" \
  archive | grep -E "error:|warning: .*sign|ARCHIVE (SUCCEEDED|FAILED)" || true
[ -d "$OUT/App.xcarchive" ] || { echo "archive missing"; exit 1; }
ls "$OUT/App.xcarchive/Products/Applications/App.app/PlugIns" | xargs echo "   extensions in archive:"

echo "== 4. export (manual signing, both profiles)"
xcodebuild -exportArchive -archivePath "$OUT/App.xcarchive" \
  -exportOptionsPlist "$ROOT/scripts/ios/ExportOptions.plist" -exportPath "$OUT/export" \
  -allowProvisioningUpdates -authenticationKeyPath "$KEY_PATH" \
  -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ISSUER" \
  | grep -E "error:|EXPORT (SUCCEEDED|FAILED)" || true
IPA="$(ls "$OUT"/export/*.ipa | head -1)"; [ -f "$IPA" ] || { echo "no ipa"; exit 1; }
echo "   ipa: $IPA"

echo "== 5. upload"
xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$KEY_ID" --apiIssuer "$ISSUER" 2>&1 | grep -E "UPLOAD SUCCEEDED|error|Error" || true
echo "== done: build $BUILD uploaded; it appears in App Store Connect after processing (~10 min)"
