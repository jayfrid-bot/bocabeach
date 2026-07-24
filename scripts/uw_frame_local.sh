#!/bin/bash
# Deerfield underwater sea-cam FRAME COURIER (runs on the owner's Mac, hourly
# via launchd — see scripts/com.isitbeachday.uwframe.plist).
#
# WHY THIS EXISTS: YouTube blocks yt-dlp from GitHub Actions' datacenter IPs
# (confirmed 2026-07-24: ios/tv/default clients all exit 1 in CI while the same
# call works from this residential connection). So the Mac grabs the frame and
# pushes it to the repo's `uw-frames` branch; the cam-vision Action then reads
# the frame from raw.githubusercontent.com (see fetch_uw_frame in
# cam_seaweed.py) and does the vision call with its own keys. Everything here
# is best-effort: if the Mac is asleep or offline, the Action just skips the
# underwater read for that hour, exactly like before.
set -euo pipefail

REPO="jayfrid-bot/bocabeach"
BRANCH="uw-frames"
URL="${UW_STREAM_URL:-https://www.youtube.com/watch?v=SHfAtWHr9Ks}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# node (for yt-dlp's JS runtime) + ffmpeg must be on PATH under launchd, which
# does NOT load the user's shell profile.
export PATH="$HOME/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# Daylight-only (the cam is dark at night); launchd also gates hours, this is a
# belt-and-suspenders check for manual runs.
hour=$((10#$(date +%H)))  # 10# guards the octal trap on "08"/"09"
if (( hour < 6 || hour > 20 )); then
  echo "outside daylight hours ($hour) — skipping"
  exit 0
fi

manifest=$(yt-dlp -g "$URL" | head -1)
[[ "$manifest" == http* ]] || { echo "no manifest URL" >&2; exit 1; }
ffmpeg -y -loglevel error -i "$manifest" -frames:v 1 "$TMP/latest.jpg"
[[ -s "$TMP/latest.jpg" ]] || { echo "empty frame" >&2; exit 1; }

# Push via the GitHub contents API (no local clone state needed). The branch is
# created on first push; subsequent pushes need the existing file's sha.
b64="$TMP/latest.b64"
base64 -i "$TMP/latest.jpg" | tr -d '\n' > "$b64"
sha=$(gh api "repos/$REPO/contents/latest.jpg?ref=$BRANCH" --jq .sha 2>/dev/null || true)
args=(-X PUT "repos/$REPO/contents/latest.jpg"
      -f message="uw frame $(date -u +%Y-%m-%dT%H:%MZ)"
      -f branch="$BRANCH")
[[ -n "$sha" ]] && args+=(-f sha="$sha")
gh api "${args[@]}" -F content=@"$b64" --jq .commit.sha

# Companion timestamp so the Action can verify freshness without trusting the
# commit time.
meta="{\"grabbedAtUtc\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
msha=$(gh api "repos/$REPO/contents/meta.json?ref=$BRANCH" --jq .sha 2>/dev/null || true)
margs=(-X PUT "repos/$REPO/contents/meta.json"
       -f message="uw meta" -f branch="$BRANCH"
       -f content="$(printf '%s' "$meta" | base64)")
[[ -n "$msha" ]] && margs+=(-f sha="$msha")
gh api "${margs[@]}" --jq .commit.sha
echo "frame + meta pushed to $BRANCH"
