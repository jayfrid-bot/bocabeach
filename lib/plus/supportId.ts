/** The short, shareable form of a device id shown as "Support ID" (Codex
 *  round 2 #1): our privacy page points people who want their record
 *  deleted at support@ with this, since the full id is otherwise not
 *  visible anywhere in the app. Just the first 12 characters (Codex round 3
 *  #1) — enough for us to find the row without ambiguity, short enough to
 *  read over the phone; the Copy button next to it still copies the FULL
 *  id. Its own tiny module so the dashboard footer can show it without
 *  pulling the whole Paywall into the first-load bundle. Pure, unit-tested
 *  through components/plus/Paywall.test.ts (Paywall re-exports it). */
export function supportId(deviceId: string): string {
  return deviceId.slice(0, 12);
}
