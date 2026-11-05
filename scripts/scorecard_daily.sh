#!/usr/bin/env bash
# Daily prediction scorecard, run by launchd (scripts/com.isitbeachday.scorecard.plist).
#
# Why a launchd job and not a Claude scheduled task: the weekly Claude task
# stopped on 2026-10-20. Each unattended run stopped at its first shell
# command and wrote nothing for three weeks, and nothing said so. This job
# needs no one at the keyboard, and it says when it fails.
#
# What it does, once a day:
#   1. Fetches origin/main into its own worktree (never the owner's checkout).
#   2. Runs scripts/scorecard.ts. That script only READS production D1, through
#      the wrangler login on this Mac.
#   3. Commits docs/scorecards/ only, and pushes to main. The pre-push hook
#      runs the mobile layout check. If the push fails, the commit stays local
#      and the log says so.
#   4. On any failure: a macOS notification, a line in the log, and the
#      file docs/scorecards/FAILED (in the worktree) with the error.
#
# Log: ~/Library/Logs/beachday-scorecard.log
set -uo pipefail

REPO="${BEACHDAY_REPO:-$HOME/Projects/bocabeach}"
WT="${BEACHDAY_SCORECARD_WT:-$HOME/Projects/bocabeach-scorecard-job}"
NODE_DIR="${BEACHDAY_NODE_DIR:-$HOME/.hermes/node/bin}"
# Two Cloudflare accounts share this login; wrangler cannot pick one without a
# terminal. This is the account that holds isitbeachday-plus (wrangler.jsonc).
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-10cdd8dec9ac9d0593e31a55eeaee1e2}"
export PATH="$NODE_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

stamp() { date "+%Y-%m-%d %H:%M:%S"; }
log() { echo "[$(stamp)] $*"; }
fail() {
  log "FAILED: $*"
  mkdir -p "$WT/docs/scorecards" 2>/dev/null && echo "$(stamp) $*" > "$WT/docs/scorecards/FAILED"
  osascript -e "display notification \"$(echo "$*" | tr '"' "'" | cut -c1-180)\" with title \"Beach Day scorecard failed\"" 2>/dev/null || true
  exit 1
}

log "start (node $(node --version 2>/dev/null || echo missing))"
command -v node >/dev/null || fail "node not found in $NODE_DIR"

git -C "$REPO" fetch -q origin main || fail "git fetch failed"

# Own worktree, detached at origin/main. Created on the first run.
if [ ! -d "$WT/.git" ] && [ ! -f "$WT/.git" ]; then
  git -C "$REPO" worktree add -q --detach "$WT" origin/main || fail "could not create worktree $WT"
fi
cd "$WT" || fail "no worktree at $WT"
git checkout -q --detach origin/main 2>/dev/null || { git reset -q --hard && git checkout -q --detach origin/main; } || fail "could not check out origin/main"
rm -f docs/scorecards/FAILED

# Run the newest copy of this script: launchd starts the copy in the owner's
# checkout, which can lag behind main.
if [ -z "${SCORECARD_REEXEC:-}" ] && [ -f "$WT/scripts/scorecard_daily.sh" ] && ! cmp -s "$0" "$WT/scripts/scorecard_daily.sh"; then
  log "re-running from the fetched copy"
  SCORECARD_REEXEC=1 exec /bin/bash "$WT/scripts/scorecard_daily.sh"
fi

# node_modules: an APFS clone of the deploy worktree's copy on first run,
# refreshed when package-lock.json changes. Never a symlink.
LOCK_SUM="$(shasum package-lock.json | cut -d' ' -f1)"
if [ ! -d node_modules ] || [ "$(cat node_modules/.scorecard-lock 2>/dev/null)" != "$LOCK_SUM" ]; then
  log "installing node_modules"
  npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || fail "npm ci failed"
  echo "$LOCK_SUM" > node_modules/.scorecard-lock
fi

log "running scorecard"
if ! npx vite-node -c vitest.config.ts scripts/scorecard.ts > /dev/null 2> /tmp/beachday-scorecard.err; then
  fail "scorecard.ts: $(tail -3 /tmp/beachday-scorecard.err | tr '\n' ' ')"
fi
tail -4 /tmp/beachday-scorecard.err | sed 's/^/  /'

git add docs/scorecards/
if git diff --cached --quiet; then
  log "no change in the report"
  exit 0
fi
git -c user.name="Beach Day scorecard" -c user.email="jayfrid-bot@users.noreply.github.com" \
  commit -q -m "scorecard: daily run $(date +%F) [skip ci]" || fail "git commit failed"

if [ -n "${SCORECARD_NO_PUSH:-}" ]; then
  log "SCORECARD_NO_PUSH set: committed $(git rev-parse --short HEAD) locally, not pushed"
  exit 0
fi

# Push the report. If main moved since the fetch, rebase once and retry.
push() { git push -q origin HEAD:main > /tmp/beachday-scorecard-push.log 2>&1; }
if ! push; then
  git fetch -q origin main && git rebase -q origin/main && push \
    || fail "push failed, report kept as a local commit in $WT: $(tail -2 /tmp/beachday-scorecard-push.log | tr '\n' ' ')"
fi
log "pushed $(git rev-parse --short HEAD)"
