# shellcheck shell=bash
# Run lock for scripts/cam_courier_local.sh — sourced, not executed.
#
# One courier run at a time: the hourly :07 job and the 10-minute golden job
# can meet, and two grabs of the same cam would only double yt-dlp load.
#
#   courier_lock_acquire   0 = we hold the lock, 1 = another live run holds it
#   courier_lock_release   removes the lock ONLY if it is still ours
#
# How it stays safe (Codex review of 9764baa):
#  - mkdir is the atomic claim. The OWNER file is written atomically afterwards
#    (temp file inside the lock dir, then `mv` to `owner`), so a reader sees
#    either no owner file or a complete one, never half a line.
#  - A lock dir with no owner file is a run caught between mkdir and the owner
#    write, not necessarily a dead one. It is NEVER reclaimed at once: wait
#    COURIER_LOCK_WAIT_S seconds (default 2) and read again; only a dir that is
#    STILL ownerless, and is still the same directory, is reclaimed.
#  - The owner file holds "<pid> <token>"; the token is unique per run (pid,
#    random numbers, clock). A pid is trusted as live only if it is a positive
#    integer AND `ps -p <pid> -o command=` shows cam_courier_local.sh, so a
#    recycled pid (some unrelated process) does not hold the lock forever.
#  - A stale lock is reclaimed by renaming the directory away (atomic: one
#    claimant wins), then a fresh mkdir.
#  - On exit a run removes the lock only if `owner` still holds its own token,
#    so an old run's cleanup cannot delete a lock another run has since taken.
# Residual race: a window of a few microseconds between "read the owner" and
# "rename" in a reclaim, and between "check the token" and "rm" in a release.
# The worst case is two grabs overlapping once, which is harmless.

: "${COURIER_LOCK_WAIT_S:=2}"

_courier_lock_hook() { :; } # test seam: called right after a successful mkdir, before the owner write

_courier_lock_read_owner() { # prints the owner file's content, or nothing
  cat "$LOCK_DIR/owner" 2>/dev/null || true
}

_courier_lock_dir_id() { # identity of the lock directory itself (inode), to spot a swap
  ls -di "$LOCK_DIR" 2>/dev/null | awk '{print $1}'
}

_courier_lock_pid_is_live_courier() { # $1 = pid text from an owner file
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ "$(ps -p "$pid" -o command= 2>/dev/null)" == *cam_courier_local.sh* ]]
}

_courier_lock_write_owner() { # atomic: temp file in the lock dir, then mv
  local tmp="$LOCK_DIR/.owner.$$"
  printf '%s\n' "$COURIER_LOCK_OWNER" > "$tmp" 2>/dev/null || return 1
  mv -f "$tmp" "$LOCK_DIR/owner" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
}

_courier_lock_reclaim() { # rename the stale dir away; only one claimant can win
  local aside="$LOCK_DIR.stale.$$.$RANDOM"
  mv "$LOCK_DIR" "$aside" 2>/dev/null || return 1
  rm -rf "$aside"
}

courier_lock_acquire() {
  : "${LOCK_DIR:?LOCK_DIR must be set}"
  COURIER_LOCK_OWNER="$$ $$-$RANDOM-$RANDOM-$(date +%s)"
  local attempt owner pid id
  for attempt in 1 2 3 4; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      _courier_lock_hook
      if _courier_lock_write_owner && [[ "$(_courier_lock_read_owner)" == "$COURIER_LOCK_OWNER" ]]; then
        return 0
      fi
      continue # the dir was taken away under us before the owner landed: start over
    fi

    owner="$(_courier_lock_read_owner)"
    if [[ -z "$owner" ]]; then
      # Ownerless: maybe a run between mkdir and its owner write. Give it time.
      id="$(_courier_lock_dir_id)"
      sleep "$COURIER_LOCK_WAIT_S"
      owner="$(_courier_lock_read_owner)"
      if [[ -z "$owner" ]]; then
        [[ -n "$id" && "$(_courier_lock_dir_id)" == "$id" ]] || continue # swapped meanwhile: look again
        log "run lock at $LOCK_DIR has no owner after ${COURIER_LOCK_WAIT_S}s — reclaiming it"
        _courier_lock_reclaim
        continue
      fi
    fi

    pid="${owner%% *}"
    if _courier_lock_pid_is_live_courier "$pid"; then
      log "another courier run (pid $pid) is still going — skipping this one"
      return 1
    fi
    # Stale: bad pid, dead pid, or a recycled pid that is not a courier run.
    # Reclaim only if the owner file is unchanged since we read it.
    if [[ "$(_courier_lock_read_owner)" == "$owner" ]]; then
      log "run lock held by pid '$pid', which is not a live courier run — reclaiming it"
      _courier_lock_reclaim
    fi
  done
  log "could not take the run lock at $LOCK_DIR — skipping"
  return 1
}

courier_lock_release() {
  [[ -n "${COURIER_LOCK_OWNER:-}" && -n "${LOCK_DIR:-}" ]] || return 0
  if [[ "$(_courier_lock_read_owner)" == "$COURIER_LOCK_OWNER" ]]; then
    rm -rf "$LOCK_DIR"
  fi
  return 0
}
