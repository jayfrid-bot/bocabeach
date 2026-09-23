/**
 * A tiny module-level "don't reload right now" counter.
 *
 * lib/useReloadOnNewVersion.ts reloads the page when a new build has
 * deployed, but a hard `location.reload()` mid-purchase, mid-restore,
 * mid-redeem, or mid Beach Mode arm/disarm/location-request would blow away
 * that in-flight work (and, for a store purchase, could strand a charged
 * customer without Plus). Callers that start one of those flows take a hold
 * for its duration; the reload hook checks `reloadHeld()` before reloading
 * and simply retries on the next resume if something is held.
 */

let holdCount = 0;

/** Take a hold. Call the returned function exactly once, when the flow ends
 *  (success, failure, or cancel) — a `finally` block is the usual place. */
export function holdReload(): () => void {
  holdCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holdCount = Math.max(0, holdCount - 1);
  };
}

/** True while any flow currently holds a reload. */
export function reloadHeld(): boolean {
  return holdCount > 0;
}

/** Test-only escape hatch — resets the counter between test cases. */
export function _resetReloadGuardForTests(): void {
  holdCount = 0;
}
