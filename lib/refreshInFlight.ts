/**
 * A tiny module-level flag marking whether PullToRefresh's manual refresh is
 * currently in flight, so other refetch triggers (e.g.
 * ConditionsDashboard's resume-on-visibility refetch) can skip themselves
 * rather than racing the pull refresh and double-fetching.
 */

let inFlight = false;

/** True while a pull-to-refresh is in progress. */
export function isPullRefreshing(): boolean {
  return inFlight;
}

/** Mark a pull refresh as started. Call the returned function exactly once,
 *  when it ends (success, failure, or timeout) — a `finally` block. */
export function beginPullRefresh(): () => void {
  inFlight = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight = false;
  };
}

/** Test-only escape hatch — resets the flag between test cases. */
export function _resetRefreshInFlightForTests(): void {
  inFlight = false;
}
