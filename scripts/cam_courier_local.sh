#!/bin/bash
# Multi-cam FRAME COURIER (runs on the owner's Mac via launchd: hourly at :07
# from scripts/com.isitbeachday.camcourier.plist, plus every 10 minutes in the
# golden-hour windows from scripts/com.isitbeachday.camcourier.golden.plist,
# which passes --golden-only). No longer Deerfield-only: it also carries Fort
# Lauderdale Beach's Elbo Room cam (see the CAMS array below).
#
# GOLDEN-HOUR MODE (--golden-only): the webcam archive keeps a shot every 10
# minutes around sunrise (-20/+40 min) and sunset (-40/+20 min) — see
# lib/camFrames/golden.ts — but the hourly run gives these courier cams at
# most one frame an hour. The golden launchd job fires at :00/:10/:20/:30/:40/:50
# through every local hour a window can touch (6-8 and 16-20 America/New_York,
# all seasons, plus 21:00 and 21:10 for Pensacola Beach's summer sunset) and this flag makes the run grab ONLY while
# `python3 scripts/golden_now.py` says it is inside a window for the courier
# beaches (Deerfield Beach, Fort Lauderdale, Fort Myers Beach, Pensacola Beach); outside one it logs a line and
# exits 0. If golden_now.py cannot tell (exit 2) the run logs an ERROR and exits
# 1 without grabbing; the hourly job still runs. Two runs never overlap: a run
# that finds another one in progress logs it and exits 0.
#
# WHY THIS EXISTS: as of 2026-09, YouTube refuses playback to Cloudflare's
# Browser Rendering fleet entirely for these streams — every grab attempt
# from workers/uw-frame's headless-Chrome path ends on the player's own "An
# error occurred. Please try again later. (Playback ID ...)" overlay
# (datacenter IPs blocked outright). From this Mac's residential connection,
# `yt-dlp -g` + `ffmpeg -frames:v 1` still works fine (verified 2026-09-14).
# So this script grabs a frame for each configured cam and POSTs it straight
# into the worker via POST /ingest?cam=<id> — no git branch, no GitHub
# Actions relay. The worker's own headless-Chrome grab stays running
# unchanged as a self-healing fallback: if YouTube ever stops blocking
# Cloudflare's fleet, it quietly starts contributing frames again.
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
#   2. Install the two launchd jobs (each renders __HOME__ in its plist, then
#      loads it): the hourly :07 job and the golden-hour every-10-minutes job.
#        for job in com.isitbeachday.camcourier com.isitbeachday.camcourier.golden; do
#          sed "s#__HOME__#$HOME#g" "scripts/$job.plist" \
#            > "$HOME/Library/LaunchAgents/$job.plist"
#          launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/$job.plist"
#        done
#      (To change an already-installed job, `launchctl bootout gui/$(id -u)/<label>`
#      first, then bootstrap again.)
#   3. (Optional) run once by hand first, outside daylight hours if needed:
#        bash scripts/cam_courier_local.sh --force
#      or see what the golden check says right now (0 = inside a window):
#        python3 scripts/golden_now.py; echo $?
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORCE=0
GOLDEN_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --golden-only) GOLDEN_ONLY=1 ;;
    --once) : ;; # default behavior already (single pass, no loop); accepted for explicitness
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

# --golden-only: grab only inside a sunrise/sunset golden window of the courier
# beaches (computed by scripts/golden_now.py: exit 0 inside, 1 outside, 2 can't
# tell). --force skips this check, like the daylight gate below. This runs
# before the token check so the ~40 outside-window launches a day stay quiet.
if [[ "$GOLDEN_ONLY" -eq 1 && "$FORCE" -ne 1 ]]; then
  golden_status=0
  golden_line="$(python3 "$SCRIPT_DIR/golden_now.py" 2>&1)" || golden_status=$?
  case "$golden_status" in
    0) log "golden-only: $golden_line" ;;
    1) log "golden-only: $golden_line — skipping"; exit 0 ;;
    *) log "ERROR: golden_now.py could not tell (exit $golden_status): $golden_line — skipping this run"; exit 1 ;;
  esac
fi

if [[ ! -s "$TOKEN_FILE" ]]; then
  log "ERROR: token file missing or empty at $TOKEN_FILE — refusing to run. See this script's header for the install steps."
  exit 1
fi
TOKEN="$(cat "$TOKEN_FILE")"

# Daylight-only gate in America/New_York (06:00-20:00), unless --force. The
# cams are dark/pointless at night; this mirrors the worker's own daylight
# gating for the surface cams and flag read. --golden-only has already decided
# by the sun (its windows can touch 16:47-20:37 local), so it skips this gate.
if [[ "$FORCE" -ne 1 && "$GOLDEN_ONLY" -ne 1 ]]; then
  eastern_hour=$(TZ="America/New_York" date +%H)
  eastern_hour=$((10#$eastern_hour)) # 10# guards the octal trap on "08"/"09"
  if (( eastern_hour < 6 || eastern_hour > 20 )); then
    log "outside daylight hours in America/New_York ($eastern_hour) — skipping (use --force to override)"
    exit 0
  fi
fi

# id:youtube-video-id pairs — kept in sync with
# workers/uw-frame/src/lib/schedule.ts CAMERA_REGISTRY.
#
# ftl-elbo-beach-cam is Elbo Room's public "Fort Lauderdale Beach LIVE: Surf,
# Wind & Golden Hour" YouTube stream (owner approved for this use). Elbo Room
# also runs a patio cam (shows bar patrons) and a "weather station" cam
# (shows the street) on the same page — neither is a beach/ocean view, so
# neither is added here, on purpose.
#
# fort-myers-beach-cam (Visit Fort Myers) and pensacola-sria-west-cam (Santa Rosa
# Island Authority) are public tourism-board and public-authority streams that
# face WEST over the Gulf (added 2026-10-15 for sunset truth; see
# docs/research/2026-10-15-west-facing-cams.md). Pensacola is on Central time;
# the daylight gate below is Eastern, which still covers its evening.
CAMS=(
  "deerfield-spinner-uw:SHfAtWHr9Ks"
  "deerfield-beach-cam:rdeoEeJ00xA"
  "deerfield-surf-cam:hIeFPNHfuoY"
  "deerfield-pier-cam:H33wtprQqSM"
  "ftl-elbo-beach-cam:1j1lgppb0PY"
  "fort-myers-beach-cam:nj9jdOXXhEo"
  "pensacola-sria-west-cam:HKIc6CYlMzI"
)

# HOURLY-ONLY cams (added 2026-10-17, Florida Atlantic coast; see
# docs/research/2026-10-16-atlantic-cams.md). Each is pulled once per HOURLY run
# (06:00-20:59 Eastern, so 15 pulls a day per cam) and NEVER by a --golden-only run,
# so the 10-minute golden fires keep pulling only the seven cams above. That holds the
# YouTube call rate down: these 15 cams add 15 yt-dlp pulls an hour, no more. To re-pace
# them, change only this array and the loop that reads it below.
HOURLY_CAMS=(
  "jax-beach-bw-cam:bZ4uxyLqV-E"
  "jax-pier-overview-cam:EOTLy91Ycew"
  "st-augustine-pier-cam:Q6eZVkUKFxo"
  "st-augustine-surf-cam:H2q_DJc33kg"
  "vilano-surf-station-cam:o4BJ-eDgYrM"
  "ormond-cam-180:p1s7EdZgGvU"
  "dunlawton-cam-180:3hwTkO_5KXo"
  "new-smyrna-cam-180:550p9smwjPM"
  "ponce-inlet-cam-180:ZCozdEGwkDI"
  "hollywood-broadwalk-cam:cmkAbDUEoyA"
  "dania-pier-cam:o1eTLR7Degs"
  "jupiter-reef-club-cam:1FYgBpkM7SA"
  "key-west-southernmost-waterside-cam:UyfDBDRwPeI"
  "key-west-southernmost-shores-cam:gsDDwA96F6Q"
  "sombrero-beach-cam:jE4og3o_SXs"
)

# One run at a time (scripts/courier_lock.sh says how the lock stays safe). The
# hourly :07 job and the 10-minute golden job can meet.
LOCK_DIR="${COURIER_LOCK_DIR:-${TMPDIR:-/tmp}/isitbeachday-courier.lock}"
# shellcheck source=scripts/courier_lock.sh
source "$SCRIPT_DIR/courier_lock.sh"
courier_lock_acquire || exit 0
trap courier_lock_release EXIT # from here on every exit path gives the lock back (if still ours)

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
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) &
  local watcher=$!
  local status=0
  wait "$pid" 2>/dev/null || status=$?
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  return "$status"
}

# FORT LAUDERDALE (ftl-elbo-beach-cam) ONLY: Elbo Room's stream id changes
# whenever they restart it, so the id saved in CAMS can go stale. When the
# saved id fails to play, this re-derives the current one straight from
# Elbo Room's own beach-cam page: the embedded player's live-chat iframe
# (youtube.com/live_chat?v=<ID>) is the most reliable place to scrape the
# CURRENT video id out of plain HTML, no YouTube Data API key needed. Every
# id found is deduped (first-seen order kept) and tried with `yt-dlp -g`;
# the first whose title contains "Surf" wins, otherwise the first that
# simply plays. Prints the winning video id on stdout (nothing else, so a
# caller can capture it with $(...)); all logging goes to stderr. Prints
# nothing and returns 1 if no candidate id plays.
resolve_elbo_fallback_video_id() {
  local page_html="$TMP/elbo-beach-cam-page.html"
  local candidate title winner="" winner_reason=""

  if ! run_with_timeout 20 curl -sS -f \
      -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36" \
      --max-time 15 \
      "https://www.elboroom.com/beach-cam/" -o "$page_html" 2>"$TMP/elbo-page.err"; then
    log "ftl-elbo-beach-cam: fallback page fetch failed" >&2
    return 1
  fi

  while IFS= read -r candidate; do
    [[ -z "$candidate" ]] && continue
    if ! run_with_timeout 20 yt-dlp -g --no-warnings --socket-timeout 15 \
        -f "best[height<=720]/best" \
        "https://www.youtube.com/watch?v=$candidate" \
        > /dev/null 2>"$TMP/elbo-$candidate.ytdlp.err"; then
      continue # this candidate id doesn't play — try the next one
    fi
    # Only the beach view ("... Surf, Wind & Golden Hour") is acceptable. The
    # same page also lists the weather-station stream, which shows the street,
    # so a playable-but-wrong stream must never become the fallback.
    title="$(run_with_timeout 15 yt-dlp --no-warnings --print "%(title)s" \
        "https://www.youtube.com/watch?v=$candidate" 2>/dev/null || true)"
    if [[ "$title" == *Surf* ]]; then
      winner="$candidate"
      winner_reason="title matched \"Surf\": $title"
      break
    fi
  done < <(grep -oE 'live_chat\?v=[A-Za-z0-9_-]{6,}' "$page_html" \
      | sed -E 's/^live_chat\?v=//' | awk '!seen[$0]++')

  if [[ -z "$winner" ]]; then
    log "ftl-elbo-beach-cam: no live beach (\"Surf\") stream found on the beach-cam page — skipping this run" >&2
    return 1
  fi
  log "ftl-elbo-beach-cam: fallback resolved video id -> $winner ($winner_reason)" >&2
  printf '%s\n' "$winner"
  return 0
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
    log "$cam_id: yt-dlp -g failed or timed out for saved video id $video_id"
    if [[ "$cam_id" == "ftl-elbo-beach-cam" ]]; then
      local fallback_id
      if ! fallback_id="$(resolve_elbo_fallback_video_id)"; then
        return 1
      fi
      log "$cam_id: retrying with fallback video id $fallback_id"
      video_id="$fallback_id"
      if ! run_with_timeout 45 yt-dlp -g --no-warnings --socket-timeout 20 \
          -f "best[height<=720]/best" \
          "https://www.youtube.com/watch?v=$video_id" > "$manifest_file" 2>"$TMP/$cam_id.ytdlp.err"; then
        log "$cam_id: yt-dlp -g failed even with fallback video id $video_id"
        return 1
      fi
    else
      return 1
    fi
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

# The cams this run pulls: the base list always, the hourly-only list except on a golden run.
RUN_CAMS=("${CAMS[@]}")
if [[ "$GOLDEN_ONLY" -ne 1 ]]; then
  RUN_CAMS+=("${HOURLY_CAMS[@]}")
fi

uploaded=0
for entry in "${RUN_CAMS[@]}"; do
  cam_id="${entry%%:*}"
  video_id="${entry#*:}"
  if grab_and_upload "$cam_id" "$video_id"; then
    uploaded=$((uploaded + 1))
  fi
done

log "done: $uploaded/${#RUN_CAMS[@]} cams uploaded"
[[ "$uploaded" -gt 0 ]] && exit 0
exit 1
