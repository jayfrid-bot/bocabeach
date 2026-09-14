#!/bin/bash
# Deerfield Beach multi-cam FRAME COURIER (runs on the owner's Mac, hourly
# via launchd — see scripts/com.isitbeachday.camcourier.plist).
#
# WHY THIS EXISTS: as of 2026-09, YouTube refuses playback to Cloudflare's
# Browser Rendering fleet entirely for these streams — every grab attempt
# from workers/uw-frame's headless-Chrome path ends on the player's own "An
# error occurred. Please try again later. (Playback ID ...)" overlay
# (datacenter IPs blocked outright). From this Mac's residential connection,
# `yt-dlp -g` + `ffmpeg -frames:v 1` still works fine (verified 2026-09-14).
# So this script grabs a frame for each of the four Deerfield Beach cams and
# POSTs it straight into the worker via POST /ingest?cam=<id> — no git
# branch, no GitHub Actions relay. The worker's own headless-Chrome grab
# stays running unchanged as a self-healing fallback: if YouTube ever stops
# blocking Cloudflare's fleet, it quietly starts contributing frames again.
# Both writers go through the same server-side shouldReplaceStoredFrame
# guard, so neither can clobber the other's newer good frame.
#
# This SUPERSEDES scripts/uw_frame_local.sh (single-cam, pushed to a git
# branch instead of POSTing to the worker) — see that file's header. It is
# left in place, not deleted, but is no longer installed.
#
# INSTALL (NOT done by this change — run these yourself when ready):
#   1. Create the token file whose contents match the worker's INGEST_TOKEN
#      secret exactly (no trailing newline):
#        mkdir -p "$HOME/.config/isitbeachday"
#        printf '%s' '<the same value set via `wrangler secret put INGEST_TOKEN`>' \
#          > "$HOME/.config/isitbeachday/courier.token"
#        chmod 600 "$HOME/.config/isitbeachday/courier.token"
#   2. Install the launchd job (renders __HOME__ in the plist, then loads it):
#        sed "s#__HOME__#$HOME#g" scripts/com.isitbeachday.camcourier.plist \
#          > "$HOME/Library/LaunchAgents/com.isitbeachday.camcourier.plist"
#        launchctl bootstrap gui/$(id -u) \
#          "$HOME/Library/LaunchAgents/com.isitbeachday.camcourier.plist"
#   3. (Optional) run once by hand first, outside daylight hours if needed:
#        bash scripts/cam_courier_local.sh --force
#
# Logs land at ~/Library/Logs/cam-courier.log (StandardOutPath/ErrorPath in
# the plist).
#
# set -euo pipefail governs this script's OWN control flow (arg parsing,
# the token-file check). Each cam's grab+upload runs through
# grab_and_upload, called only as an `if` condition below — a non-zero
# return from a command tested by `if`/`while`/`||` does NOT trigger -e, so
# one cam's failure is logged and the loop continues to the next cam
# (best-effort per cam, per the spec this script was built from).
set -euo pipefail

# --- PATH: launchd does NOT load the user's shell profile, so yt-dlp
# (needs node as its JS runtime), ffmpeg, and curl must be found explicitly
# here rather than relying on ~/.zshrc / ~/.zprofile having set PATH. ---
export PATH="$HOME/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

COURIER_URL="${COURIER_URL:-https://uw-frame.entwined-app.workers.dev}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.config/isitbeachday/courier.token}"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --once) : ;; # default behavior already (single pass, no loop); accepted for explicitness
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

if [[ ! -s "$TOKEN_FILE" ]]; then
  log "ERROR: token file missing or empty at $TOKEN_FILE — refusing to run. See this script's header for the install steps."
  exit 1
fi
TOKEN="$(cat "$TOKEN_FILE")"

# Daylight-only gate in America/New_York (06:00-20:00), unless --force. The
# cams are dark/pointless at night; this mirrors the worker's own daylight
# gating for the surface cams and flag read.
if [[ "$FORCE" -ne 1 ]]; then
  eastern_hour=$(TZ="America/New_York" date +%H)
  eastern_hour=$((10#$eastern_hour)) # 10# guards the octal trap on "08"/"09"
  if (( eastern_hour < 6 || eastern_hour > 20 )); then
    log "outside daylight hours in America/New_York ($eastern_hour) — skipping (use --force to override)"
    exit 0
  fi
fi

# id:youtube-video-id pairs — kept in sync with
# workers/uw-frame/src/lib/schedule.ts CAMERA_REGISTRY.
CAMS=(
  "deerfield-spinner-uw:SHfAtWHr9Ks"
  "deerfield-beach-cam:rdeoEeJ00xA"
  "deerfield-surf-cam:hIeFPNHfuoY"
  "deerfield-pier-cam:H33wtprQqSM"
)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Runs "$@" in the background and force-kills it if it's still running
# after $1 seconds; otherwise returns its real exit status. This is the
# "background-kill guard" backstop behind yt-dlp's own --socket-timeout and
# ffmpeg's own -rw_timeout/-t, for whatever a tool's internal timeout
# doesn't cover (DNS, a hung subprocess, etc). macOS ships no `timeout(1)`,
# hence doing it by hand.
run_with_timeout() {
  local secs="$1"; shift
  "$@" &
  local pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) &
  local watcher=$!
  local status=0
  wait "$pid" 2>/dev/null || status=$?
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  return "$status"
}

# Grabs and uploads ONE camera; every failure path logs and returns 1
# rather than aborting the script (see the -euo pipefail note above).
grab_and_upload() {
  local cam_id="$1" video_id="$2"
  local jpg="$TMP/$cam_id.jpg"
  local manifest_file="$TMP/$cam_id.manifest"
  local grabbed_at
  grabbed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if ! run_with_timeout 45 yt-dlp -g --no-warnings --socket-timeout 20 \
      -f "best[height<=720]/best" \
      "https://www.youtube.com/watch?v=$video_id" > "$manifest_file" 2>"$TMP/$cam_id.ytdlp.err"; then
    log "$cam_id: yt-dlp -g failed or timed out"
    return 1
  fi
  local manifest
  manifest="$(head -1 "$manifest_file" 2>/dev/null || true)"
  if [[ "$manifest" != http* ]]; then
    log "$cam_id: no manifest URL from yt-dlp"
    return 1
  fi

  if ! run_with_timeout 40 ffmpeg -loglevel error -y \
      -rw_timeout 40000000 \
      -i "$manifest" \
      -frames:v 1 -q:v 4 -t 5 \
      "$jpg" 2>"$TMP/$cam_id.ffmpeg.err"; then
    log "$cam_id: ffmpeg failed or timed out"
    return 1
  fi
  if [[ ! -s "$jpg" ]]; then
    log "$cam_id: empty frame"
    return 1
  fi

  if ! curl -sS -f -X POST "$COURIER_URL/ingest?cam=$cam_id" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: image/jpeg" \
      -H "X-Grabbed-At: $grabbed_at" \
      --data-binary "@$jpg" \
      --max-time 20 \
      -o "$TMP/$cam_id.response.json"; then
    log "$cam_id: upload failed"
    [[ -s "$TMP/$cam_id.response.json" ]] && cat "$TMP/$cam_id.response.json"
    return 1
  fi

  log "$cam_id: uploaded — $(cat "$TMP/$cam_id.response.json" 2>/dev/null)"
  return 0
}

uploaded=0
for entry in "${CAMS[@]}"; do
  cam_id="${entry%%:*}"
  video_id="${entry#*:}"
  if grab_and_upload "$cam_id" "$video_id"; then
    uploaded=$((uploaded + 1))
  fi
done

log "done: $uploaded/${#CAMS[@]} cams uploaded"
[[ "$uploaded" -gt 0 ]] && exit 0
exit 1
