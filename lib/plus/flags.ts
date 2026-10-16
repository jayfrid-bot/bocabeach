// Feature flags for Plus screens that ship dark. One line to turn a feature off.

/** The "go back to any day" picker, day sheet and webcam viewer in the Last-N-days section. */
export const DAY_VIEW_ENABLED = true;

/** True for "on", "1", "true" or "yes" (any case); anything else, or unset, is off. */
export function isFlagOn(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "on" || v === "1" || v === "true" || v === "yes";
}

/**
 * Does the app promise sunrise/sunset COLOR ALERTS? Default OFF. This is the
 * client-side twin of the server's `SUN_ALERTS_ENABLED` (lib/alerts/sunColor.ts,
 * wrangler.jsonc), which gates the push itself. The browser cannot read a
 * Worker variable, so this one is a build-time `NEXT_PUBLIC_` variable: Next
 * inlines it into the bundle, which is why the access must stay the literal
 * `process.env.NEXT_PUBLIC_SUN_ALERTS`. Turn the alerts back on by setting BOTH
 * `SUN_ALERTS_ENABLED=on` (wrangler var) and `NEXT_PUBLIC_SUN_ALERTS=on` (at
 * build time, before `npm run deploy`). While off, the paywall, the website's
 * app card and the alert settings stop promising the alert and say what the app
 * does show instead (lib/plus/sunAlertCopy.ts).
 */
export const SUN_ALERTS_UI_ENABLED = isFlagOn(process.env.NEXT_PUBLIC_SUN_ALERTS);
