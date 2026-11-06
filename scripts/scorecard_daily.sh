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
#   2. Pushes any report an earlier run could not push.
#   3. Runs scripts/scorecard.ts. That script only READS production D1, through
#      the wrangler login on this Mac.
#   4. Commits docs/scorecards/ only, and pushes to main. The pre-push hook
#      runs the mobile layout check.
#   5. On any failure: a macOS notification and a line in the log. When the
#      worktree exists, also the file docs/scorecards/FAILED there.
#
# Log: ~/Library/Logs/beachday-scorecard.log
set -uo pipefail

REPO="${BEACHDAY_REPO:-$HOME/Projects/bocabeach}"
WT="${BEACHDAY_SCORECARD_WT:-$HOME/Projects/bocabeach-scorecard-job}"
NODE_DIR="${BEACHDAY_NODE_DIR:-$HOME/.hermes/node/bin}"
# Two Cloudflare accounts share this login; wrangler cannot pick one without a
# terminal. This is the account that holds isitbeachday-plus.
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-10cdd8dec9ac9d0593e31a55eeaee1e2}"
export PATH="$NODE_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# Absolute path of this copy, taken before any cd (for the re-run check).
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
ERR_FILE="${TMPDIR:-/tmp}/beachday-scorecard.err"
PUSH_LOG="${TMPDIR:-/tmp}/beachday-scorecard-push.log"

stamp() { date "+%Y-%m-%d %H:%M:%S"; }
log() { echo "[$(stamp)] $*"; }
fail() {
  log "FAILED: $*"
  # Write the marker only inside a real worktree. Creating $WT here would
  # leave a plain folder that `git worktree add` refuses on every later run.
  if [ -e "$WT/.git" ]; then
    mkdir -p "$WT/docs/scorecards" && echo "$(stamp) $*" > "$WT/docs/scorecards/FAILED"
  fi
  osascript -e "display notification \"$(echo "$*" | tr '"' "'" | cut -c1-180)\" with title \"Beach Day scorecard failed\"" 2>/dev/null || true
  exit 1
}

log "start (node $(node --version 2>/dev/null || echo missing))"
command -v node >/dev/null || fail "node not found in $NODE_DIR"

# The Mac may have just woken up with no network yet: try the fetch a few times.
fetched=""
for wait_s in 0 30 90 180; do
  [ "$wait_s" -gt 0 ] && sleep "$wait_s"
  if git -C "$REPO" fetch -q origin main; then fetched=1; break; fi
  log "git fetch failed, trying again"
done
[ -n "$fetched" ] || fail "git fetch failed 4 times"

# Our own worktree, created on the first run. Never act on any other folder.
REPO_TOP="$(git -C "$REPO" rev-parse --show-toplevel)" || fail "no repo at $REPO"
if [ ! -e "$WT/.git" ]; then
  if [ -e "$WT" ]; then
    fail "$WT exists but is not a git worktree; move it aside and the next run will recreate it"
  fi
  git -C "$REPO" worktree add -q --detach "$WT" origin/main || fail "could not create worktree $WT"
  # Mark it as this job's own, in its private git dir (never committed).
  touch "$(git -C "$WT" rev-parse --absolute-git-dir)/beachday-scorecard-job" || fail "could not mark $WT"
fi
WT_TOP="$(git -C "$WT" rev-parse --show-toplevel 2>/dev/null)" || fail "$WT is not a git worktree"
[ "$WT_TOP" != "$REPO_TOP" ] || fail "$WT is the main checkout; refusing to touch it"
# Read the list into a variable: piping into `grep -q` would end git early
# with SIGPIPE, and pipefail would turn that into a false "not a worktree".
WT_LIST="$(git -C "$REPO" worktree list --porcelain)" || fail "git worktree list failed"
printf '%s\n' "$WT_LIST" | grep -qx "worktree $WT_TOP" \
  || fail "$WT_TOP is not a worktree of $REPO; refusing to touch it"
# Only a worktree this job created carries the marker. Any other worktree
# (a feature branch, a deploy checkout) is refused before git touches it.
[ -f "$(git -C "$WT_TOP" rev-parse --absolute-git-dir)/beachday-scorecard-job" ] \
  || fail "$WT_TOP was not created by this job (no marker); refusing to touch it"
cd "$WT_TOP" || fail "cannot cd to $WT_TOP"

# Clear a rebase or merge an earlier run left half done.
git rebase --abort >/dev/null 2>&1 || true
git merge --abort >/dev/null 2>&1 || true
# A run killed mid-git leaves index.lock behind and blocks every later run.
LOCK="$(git rev-parse --git-path index.lock)"
if [ -f "$LOCK" ] && ! pgrep -f "git .*$WT_TOP" >/dev/null 2>&1; then rm -f "$LOCK"; fi

# A report an earlier run committed but could not push: push it first, so
# switching to origin/main below does not drop it.
if [ -z "${SCORECARD_NO_PUSH:-}" ] && [ -n "$(git rev-list origin/main..HEAD 2>/dev/null)" ]; then
  log "pushing $(git rev-list --count origin/main..HEAD) report commit(s) left by an earlier run"
  if git rebase -q origin/main && git push -q origin HEAD:main > "$PUSH_LOG" 2>&1; then
    git fetch -q origin main
  else
    git rebase --abort >/dev/null 2>&1 || true
    log "could not push the earlier report: $(tail -2 "$PUSH_LOG" 2>/dev/null | tr '\n' ' ')"
  fi
fi

git checkout -q --detach origin/main 2>/dev/null \
  || { git reset -q --hard && git checkout -q --detach origin/main; } \
  || fail "could not check out origin/main"
rm -f docs/scorecards/FAILED

# Run the newest copy of this script: launchd starts the copy in the owner's
# checkout, which can lag behind main. Copy it out first, so a later rebase
# cannot rewrite the file while bash is still reading it.
if [ -z "${SCORECARD_REEXEC:-}" ] && [ -f "$WT_TOP/scripts/scorecard_daily.sh" ] \
   && ! cmp -s "$SELF" "$WT_TOP/scripts/scorecard_daily.sh"; then
  RUN_COPY="${TMPDIR:-/tmp}/beachday-scorecard-daily.$$.sh"
  cp "$WT_TOP/scripts/scorecard_daily.sh" "$RUN_COPY" || fail "could not copy the fetched script"
  log "re-running from the fetched copy"
  SCORECARD_REEXEC=1 exec /bin/bash "$RUN_COPY"
fi

# node_modules: installed with npm ci on the first run, and again whenever
# package-lock.json changes. Never a symlink.
LOCK_SUM="$(shasum package-lock.json | cut -d' ' -f1)"
if [ ! -d node_modules ] || [ "$(cat node_modules/.scorecard-lock 2>/dev/null)" != "$LOCK_SUM" ]; then
  log "installing node_modules"
  npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || fail "npm ci failed"
  echo "$LOCK_SUM" > node_modules/.scorecard-lock
fi

log "running scorecard"
if ! npx vite-node -c vitest.config.ts scripts/scorecard.ts > /dev/null 2> "$ERR_FILE"; then
  fail "scorecard.ts: $(tail -3 "$ERR_FILE" | tr '\n' ' ')"
fi
tail -4 "$ERR_FILE" | sed 's/^/  /'

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
push() { git push -q origin HEAD:main > "$PUSH_LOG" 2>&1; }
if ! push; then
  if git fetch -q origin main && git rebase -q origin/main; then
    push || fail "push failed; the report stays as a local commit and the next run pushes it: $(tail -2 "$PUSH_LOG" | tr '\n' ' ')"
  else
    git rebase --abort >/dev/null 2>&1 || true
    fail "rebase onto main failed; the report stays as a local commit and the next run tries again"
  fi
fi
log "pushed $(git rev-parse --short HEAD)"
