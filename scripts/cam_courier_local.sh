#!/bin/bash
# Multi-cam FRAME COURIER (runs on the always-on home Mac via launchd).
#
# TWO launchd jobs run this one script (see docs/courier-pacing.md):
#   scripts/com.isitbeachday.camcourier.plist         every 5 minutes, no flag: ROUTINE run
#   scripts/com.isitbeachday.camcourier.golden.plist  every 10 minutes, --golden-only: GOLDEN run
#
# WHICH CAMS: this script names no cam. scripts/courier_schedule.py builds the
# list from config/archive-cams.json, config/vision-cams.json,
# config/sun-cams.json and config/courier-cams.json, and decides which cams are
# due right now:
#   routine: a cam whose last good frame is 57+ minutes old (a few cams per run,
#            so the hour is spread out, not one burst at :07).
#   golden : a cam whose OWN beach is inside a sunrise (-20/+40 min) or sunset
#            (-40/+20 min) window. One frame every 10 minutes, or every 20-30 when
#            many cams are in a window at once (the call budget decides).
# Add a cam to the config files and it is picked up on the next run.
#
# WHY THE PACER: YouTube answers "Sign in to confirm you're not a bot" when one IP
# makes too many yt-dlp calls (about 150 in 15 minutes). Every yt-dlp call here
# goes through scripts/yt_pacer.py: at most 60 calls per rolling 15 minutes for
# ALL jobs on the box, golden work before routine work, 4 s between calls, and a
# 20-minute stop for every job after a bot check. If the pacer says "backing
# off" this run stops at once and exits 0; the next run tries again.
#
# --force skips the daylight gate and the schedule: it grabs EVERY cam now (use it
# by hand). --dry-run prints the cams the run would grab and does nothing else.
#
# WHY THIS EXISTS: as of 2026-09, YouTube refuses playback to Cloudflare's
# Browser Rendering fleet entirely for these streams — every grab attempt
# from workers/uw-frame's headless-Chrome path ends on the player's own "An
# error occurred. Please try again later. (Playback ID ...)" overlay
# (datacenter IPs blocked outright). From this Mac's residential connection,
# `yt-dlp -g` + `ffmpeg -frames:v 1` still works fine (verified 2026-09-14).
# So this script grabs a frame for each due cam and POSTs it straight
# into the worker via POST /ingest?cam=<id> — no git branch, no GitHub
# Actions relay. The worker's own headless-Chrome grab stays running
# unchanged as a self-healing fallback: if YouTube ever stops blocking
# Cloudflare's fleet, it quietly starts contributing frames again.
# Both writers go through the same server-side shouldReplaceStoredFrame
# guard, so neither can clobber the other's newer good frame.
#
# This SUPERSEDES scripts/uw_frame_local.sh (single-cam, pushed to a git
# branch instead of POSTing to the worker) — see that file's header.
#
# INSTALL (run these yourself when ready; docs/courier-pacing.md has the order):
#   1. Create the token file whose contents match the worker's INGEST_TOKEN
#      secret exactly (no trailing newline):
#        mkdir -p "$HOME/.config/isitbeachday"
#        printf '%s' '<the same value set via `wrangler secret put INGEST_TOKEN`>' \
#          > "$HOME/.config/isitbeachday/courier.token"
#        chmod 600 "$HOME/.config/isitbeachday/courier.token"
#   2. Install the two launchd jobs (each renders __HOME__ in its plist, then loads it):
#        for job in com.isitbeachday.camcourier com.isitbeachday.camcourier.golden; do
#          sed "s#__HOME__#$HOME#g" "scripts/$job.plist" \
#            > "$HOME/Library/LaunchAgents/$job.plist"
#          launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/$job.plist"
#        done
#      (To change an already-installed job, `launchctl bootout gui/$(id -u)/<label>`
#      first, then bootstrap again.)
#   3. See what a run would do right now, without grabbing:
#        bash scripts/cam_courier_local.sh --dry-run
#        bash scripts/cam_courier_local.sh --golden-only --dry-run
#
# Logs land at ~/Library/Logs/cam-courier.log (StandardOutPath/ErrorPath in
# the plist).
#
# set -euo pipefail governs this script's OWN control flow. Each cam's
# grab+upload runs through grab_and_upload, called only as an `||` operand
# below — a non-zero return from a command tested that way does NOT trigger
# -e, so one cam's failure is logged and the loop continues to the next cam.
set -euo pipefail

# --- PATH: launchd does NOT load the user's shell profile, so yt-dlp
# (needs node as its JS runtime), ffmpeg, and curl must be found explicitly
# here rather than relying on ~/.zshrc / ~/.zprofile having set PATH. ---
# COURIER_BIN_DIR (tests only) puts fake yt-dlp/ffmpeg/curl first.
export PATH="${COURIER_BIN_DIR:+$COURIER_BIN_DIR:}$HOME/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

COURIER_URL="${COURIER_URL:-https://uw-frame.entwined-app.workers.dev}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.config/isitbeachday/courier.token}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACER="$SCRIPT_DIR/yt_pacer.py"
SCHED="$SCRIPT_DIR/courier_schedule.py"
FORCE=0
GOLDEN_ONLY=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --golden-only) GOLDEN_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --once) : ;; # default behavior already (single pass, no loop); accepted for explicitness
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

if [[ "$GOLDEN_ONLY" -eq 1 ]]; then MODE=golden; PRIORITY=golden; else MODE=routine; PRIORITY=routine; fi
[[ "$FORCE" -eq 1 ]] && MODE=all

# Prints the cams this run should grab, one "cam|youtube_id|fallback_page|fallback_title"
# line each ("-" = none). A scheduler failure is an ERROR, never a silent empty list.
# COURIER_NOW=<ISO instant> asks "what would run then?" (dry runs, tests).
due_cams() {
  python3 "$SCHED" due --mode "$MODE" ${COURIER_NOW:+--now "$COURIER_NOW"}
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "dry run: mode=$MODE priority=$PRIORITY (nothing is grabbed, no state is written)"
  due_cams || { log "ERROR: courier_schedule.py failed"; exit 1; }
  python3 "$PACER" status || true
  exit 0
fi

# The daylight gate (routine runs only, 06:00-20:59 America/New_York) lives in
# courier_schedule.py, so a night-time run lists no cams and exits quietly. A golden run
# is decided by the sun alone. --force skips both.

# A bot check set a backoff: every yt-dlp job stays quiet until it ends.
if until_msg="$(python3 "$PACER" backoff-check 2>/dev/null)"; then
  log "yt-dlp backoff active ($until_msg) — skipping this run"
  exit 0
fi

# One run at a time (scripts/courier_lock.sh says how the lock stays safe). The
# routine and golden jobs can meet. Taken BEFORE the due list is read, so two runs
# never pick the same cam.
LOCK_DIR="${COURIER_LOCK_DIR:-${TMPDIR:-/tmp}/isitbeachday-courier.lock}"
# shellcheck source=scripts/courier_lock.sh
source "$SCRIPT_DIR/courier_lock.sh"
courier_lock_acquire || exit 0
trap courier_lock_release EXIT # from here on every exit path gives the lock back (if still ours)

if ! DUE="$(due_cams)"; then
  log "ERROR: courier_schedule.py failed — no cams grabbed"
  exit 1
fi
if [[ -z "$DUE" ]]; then
  exit 0 # nothing due: stay quiet, this is the common case
fi
CAM_COUNT=$(printf '%s\n' "$DUE" | wc -l | tr -d ' ')

if [[ ! -s "$TOKEN_FILE" ]]; then
  log "ERROR: token file missing or empty at $TOKEN_FILE — refusing to run. See this script's header for the install steps."
  exit 1
fi
TOKEN="$(cat "$TOKEN_FILE")"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; courier_lock_release' EXIT

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
  # The watcher traps TERM so that stopping it also stops its `sleep` (a bare
  # `kill` left the sleep behind, holding the log pipe open for up to $secs).
  ( trap 'kill "$sp" 2>/dev/null; exit 0' TERM; sleep "$secs" & sp=$!; wait "$sp"; kill -9 "$pid" 2>/dev/null ) &
  local watcher=$!
  local status=0
  wait "$pid" 2>/dev/null || status=$?
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  return "$status"
}

# Pacer exit codes (scripts/yt_pacer.py): 75 backoff, 76 over budget, 77 bot check.
# resolve_stream prints the HLS URL to $2; returns the pacer's exit code.
resolve_stream() {
  local cam_id="$1" out="$2" video_id="$3" rc=0
  run_with_timeout 420 python3 "$PACER" resolve --video "$video_id" --cam "$cam_id" \
    --priority "$PRIORITY" > "$out" 2>"$TMP/$cam_id.ytdlp.err" || rc=$?
  # the pacer's own lines (a bot check, a refusal) belong in the run log
  grep ' pacer: ' "$TMP/$cam_id.ytdlp.err" || true
  return "$rc"
}

# Grabs and uploads ONE camera. Returns 0 = uploaded, 1 = this cam failed,
# 2 = skipped (over the call budget, try again later), 3 = stop the whole run
# (backoff or bot check). Every failure path logs and returns rather than
# aborting the script (see the -euo pipefail note above).
grab_and_upload() {
  local cam_id="$1" video_id="$2" fb_page="$3" fb_title="$4"
  local jpg="$TMP/$cam_id.jpg"
  local manifest_file="$TMP/$cam_id.manifest"
  local grabbed_at known rc=0
  grabbed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # A stream id found earlier by the fallback search (Elbo Room restarts its
  # stream and the id changes) beats the one in config for the next 12 hours.
  known="$(python3 "$PACER" cache-get "vid:$cam_id" 2>/dev/null || true)"
  [[ -n "$known" ]] && video_id="$known"

  resolve_stream "$cam_id" "$manifest_file" "$video_id" || rc=$?
  if [[ "$rc" -ne 0 && "$rc" -lt 75 || "$rc" -gt 77 ]]; then
    log "$cam_id: yt-dlp -g failed or timed out for video id $video_id: $(tail -c 200 "$TMP/$cam_id.ytdlp.err" 2>/dev/null | tr '\n' ' ')"
    if [[ "$fb_page" != "-" ]]; then
      local fallback_id="" frc=0
      fallback_id="$(run_with_timeout 420 python3 "$PACER" fallback --cam "$cam_id" --page "$fb_page" \
          --title-contains "$fb_title" --priority "$PRIORITY" 2>>"$TMP/$cam_id.ytdlp.err")" || frc=$?
      if [[ "$frc" -eq 0 && -n "$fallback_id" && "$fallback_id" != "$video_id" ]]; then
        log "$cam_id: retrying with fallback video id $fallback_id"
        video_id="$fallback_id"
        rc=0
        resolve_stream "$cam_id" "$manifest_file" "$video_id" || rc=$?
      else
        rc="${frc:-1}"; [[ "$rc" -eq 0 ]] && rc=1
      fi
    fi
  fi
  case "$rc" in
    0) : ;;
    75|77) log "$cam_id: yt-dlp backoff in force (bot check or pacer) — stopping this run"; return 3 ;;
    76) log "$cam_id: over the yt-dlp call budget — skipped, a later run will take it"; return 2 ;;
    *) log "$cam_id: no stream URL from yt-dlp"; return 1 ;;
  esac
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

  local http_code
  http_code="$(curl -sS -X POST "$COURIER_URL/ingest?cam=$cam_id" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: image/jpeg" \
      -H "X-Grabbed-At: $grabbed_at" \
      --data-binary "@$jpg" \
      --max-time 20 \
      -o "$TMP/$cam_id.response.json" -w '%{http_code}' 2>"$TMP/$cam_id.curl.err")" || true
  if [[ "$http_code" != 2* ]]; then
    log "$cam_id: upload failed (HTTP ${http_code:-000}) $(head -c 300 "$TMP/$cam_id.response.json" 2>/dev/null) $(head -c 200 "$TMP/$cam_id.curl.err" 2>/dev/null)"
    return 1
  fi

  log "$cam_id: uploaded — $(cat "$TMP/$cam_id.response.json" 2>/dev/null)"
  return 0
}

uploaded=0
attempted=0
while IFS='|' read -r cam_id video_id fb_page fb_title; do
  [[ -z "$cam_id" ]] && continue
  attempted=$((attempted + 1))
  rc=0
  grab_and_upload "$cam_id" "$video_id" "$fb_page" "$fb_title" || rc=$?
  case "$rc" in
    0) uploaded=$((uploaded + 1)); python3 "$SCHED" mark --cam "$cam_id" --ok || true ;;
    1) python3 "$SCHED" mark --cam "$cam_id" --fail || true ;;
    2) : ;;
    3) break ;;
  esac
done <<< "$DUE"

log "done ($MODE): $uploaded/$CAM_COUNT cams uploaded"
[[ "$uploaded" -gt 0 || "$attempted" -eq 0 ]] && exit 0
# Nothing uploaded. A pacer stop (rc 2 or 3) is not a failure of the job.
[[ "$rc" -eq 2 || "$rc" -eq 3 ]] && exit 0
exit 1
