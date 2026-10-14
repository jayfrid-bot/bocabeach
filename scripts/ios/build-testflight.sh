#!/usr/bin/env bash
# Build the iOS app (with its Beach Session Live Activity extension and its Apple
# Watch app + watch widget) and upload to TestFlight.
#
# Usage:  scripts/ios/build-testflight.sh <BUILD_NUMBER> [--no-upload]   e.g. 2026101401
#
# Recipe (proven 2026-09-07 for build 2026090701, extended for the extension and the watch):
#   1. bump CURRENT_PROJECT_VERSION in the pbxproj (every target shares it: the app,
#      the Live Activity extension, the watch app, the watch widget, the watch tests)
#   2. `npx cap sync ios` (never skip — needed for the web bundle + npm plugins;
#      our local plugins register themselves in code via
#      BeachBridgeViewController.capacitorDidLoad(), not via the synced config)
#   3. archive with AUTOMATIC signing + the App Store Connect auth key
#      (passing PROVISIONING_PROFILE_SPECIFIER on the CLI breaks SPM package targets)
#   4. export with MANUAL signing via scripts/ios-release/ExportOptions.plist (the one
#      shared file), which maps ALL FOUR bundle ids to their installed profiles
#   5. upload with altool
# Never commit key material; the ASC key lives in ~/.appstoreconnect/private_keys.
#
# Fail-closed: every step's exit code is checked, each run writes into a NEW empty
# directory (a failed run can never pick up an older archive or IPA), and the IPA is
# checked to be fresh and to carry the requested build number before it is uploaded.
# --no-upload stops after the export and verification.
set -euo pipefail

usage() {
  echo "Usage: scripts/ios/build-testflight.sh <BUILD_NUMBER> [--no-upload]" >&2
  echo "  BUILD_NUMBER is 10 digits, YYYYMMDDNN, e.g. 2026101401. Nothing else is accepted." >&2
}
# Strict arguments, checked before ANY work: exactly <build> or <build> --no-upload.
# A typo such as --no-uplaod must never fall through to an upload.
UPLOAD=1
case "$#" in
  1) ;;
  2) if [ "$2" = "--no-upload" ]; then UPLOAD=0; else usage; exit 2; fi ;;
  *) usage; exit 2 ;;
esac
BUILD="$1"
[[ "$BUILD" =~ ^[0-9]{10}$ ]] || { usage; exit 2; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KEY_ID="2BH6NC23C4"
ISSUER="6d956ebe-b0b8-43a9-8bb0-3ab92e66a4e1"
KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"
PBX="ios/App/App.xcodeproj/project.pbxproj"
EXPECTED_VERSION_SETTINGS=10   # 5 targets x Debug/Release
[ -f "$KEY_PATH" ] || { echo "missing App Store Connect key: $KEY_PATH" >&2; exit 2; }

# A new directory every run: nothing from an earlier run can be mistaken for this one.
OUT="$(mktemp -d "${TMPDIR:-/tmp}/isitbeachday-ios-$BUILD.XXXXXX")"
STARTED="$OUT/.started"; touch "$STARTED"
echo "output: $OUT"

cd "$ROOT"
echo "== 1. build number $BUILD"
sed -i '' -E "s/CURRENT_PROJECT_VERSION = [0-9]+;/CURRENT_PROJECT_VERSION = $BUILD;/g" "$PBX"
N="$(grep -c "CURRENT_PROJECT_VERSION = $BUILD;" "$PBX" || true)"
TOTAL="$(grep -c "CURRENT_PROJECT_VERSION = " "$PBX" || true)"
echo "   occurrences: $N of $TOTAL"
[ "$N" = "$TOTAL" ] && [ "$N" = "$EXPECTED_VERSION_SETTINGS" ] || { echo "expected all $EXPECTED_VERSION_SETTINGS version settings to be $BUILD" >&2; exit 1; }

echo "== 2. cap sync"
npx cap sync ios > "$OUT/cap-sync.log" 2>&1 || { tail -20 "$OUT/cap-sync.log" >&2; echo "cap sync failed" >&2; exit 1; }

echo "== 3. archive (automatic signing + ASC auth key)"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/App.xcarchive" \
  -allowProvisioningUpdates -authenticationKeyPath "$KEY_PATH" \
  -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ISSUER" \
  archive > "$OUT/archive.log" 2>&1 || { grep -E "error:" "$OUT/archive.log" | head -20 >&2; echo "archive failed (log: $OUT/archive.log)" >&2; exit 1; }
APP="$OUT/App.xcarchive/Products/Applications/App.app"
[ -d "$APP" ] || { echo "archive has no App.app" >&2; exit 1; }
for rel in PlugIns/BeachSessionActivity.appex Watch/BeachDayWatch.app Watch/BeachDayWatch.app/PlugIns/BeachDayWatchWidget.appex; do
  [ -d "$APP/$rel" ] || { echo "archive is missing $rel" >&2; exit 1; }
done
ARCHIVED="$(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' "$APP/Info.plist")"
[ "$ARCHIVED" = "$BUILD" ] || { echo "archive carries build $ARCHIVED, not $BUILD" >&2; exit 1; }
echo "   archive ok: build $ARCHIVED, Live Activity + watch app + watch widget embedded"

echo "== 4. export (manual signing, all four profiles)"
xcodebuild -exportArchive -archivePath "$OUT/App.xcarchive" \
  -exportOptionsPlist "$ROOT/scripts/ios-release/ExportOptions.plist" -exportPath "$OUT/export" \
  -allowProvisioningUpdates -authenticationKeyPath "$KEY_PATH" \
  -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ISSUER" \
  > "$OUT/export.log" 2>&1 || { grep -E "error:" "$OUT/export.log" | head -20 >&2; echo "export failed (log: $OUT/export.log)" >&2; exit 1; }
IPA="$OUT/export/App.ipa"
[ -f "$IPA" ] || { echo "export produced no App.ipa" >&2; exit 1; }
[ "$IPA" -nt "$STARTED" ] || { echo "App.ipa is older than this run: refusing it" >&2; exit 1; }
IPA_BUILD="$(unzip -p "$IPA" 'Payload/App.app/Info.plist' > "$OUT/ipa-Info.plist" && /usr/libexec/PlistBuddy -c 'Print CFBundleVersion' "$OUT/ipa-Info.plist")"
[ "$IPA_BUILD" = "$BUILD" ] || { echo "IPA carries build $IPA_BUILD, not $BUILD" >&2; exit 1; }
echo "   ipa: $IPA (build $IPA_BUILD)"

if [ "$UPLOAD" = 0 ]; then
  echo "== done (no upload): build $BUILD exported and verified"
  exit 0
fi

echo "== 5. upload"
xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$KEY_ID" --apiIssuer "$ISSUER" > "$OUT/upload.log" 2>&1 \
  || { tail -20 "$OUT/upload.log" >&2; echo "upload failed (log: $OUT/upload.log)" >&2; exit 1; }
grep -q "UPLOAD SUCCEEDED" "$OUT/upload.log" || { tail -20 "$OUT/upload.log" >&2; echo "upload did not report success" >&2; exit 1; }
echo "== done: build $BUILD uploaded; it appears in App Store Connect after processing (~10 min)"
