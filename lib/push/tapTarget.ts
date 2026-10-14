// Where a tapped notification may take the web view. A push payload is data from outside the
// page, so it never names an arbitrary address: only a path on THIS app, and only one of the
// pages a push is known to open:
//   /<beach slug>              the beach pages every other alert opens
//   /admin/review?alert=<id>   the owner's quality review (docs/QUALITY_PLAN.md)
//   /admin/report              the owner's report screen
// An absolute address is accepted only when its origin is the app's own; it is cut down to its
// path. Anything else (another host, another scheme, a protocol-relative "//host", a path with
// dots or slashes) is refused with null. Pure.

// Not imported from lib/quality/notify.ts: this file runs in the browser, and that one is server code.
const APP_ORIGIN = "https://app.isitbeachday.com";

const SLUG_PATH = /^\/[a-z0-9][a-z0-9-]{0,63}$/;
const ADMIN_PATHS = new Set(["/admin/review", "/admin/report"]);

/** `origins`: the origins that count as this app (the page's own, and the production one). */
export function safeTapTarget(raw: unknown, origins: string[] = [APP_ORIGIN]): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 300 || /[\u0000-\u001f\\]/.test(raw)) return null;
  // "//host/..." is an address on another host, whatever follows.
  if (raw.startsWith("//")) return null;
  // The URL parser would quietly resolve dots and decode escapes; refuse them outright instead.
  if (raw.includes("..") || raw.includes("%")) return null;
  let url: URL;
  try {
    url = new URL(raw, APP_ORIGIN);
  } catch {
    return null;
  }
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (absolute && !origins.includes(url.origin)) return null;
  if (!absolute && url.origin !== APP_ORIGIN) return null;
  if (url.username || url.password) return null;
  const path = url.pathname;
  if (ADMIN_PATHS.has(path)) {
    if (path === "/admin/review") {
      const id = url.searchParams.get("alert");
      return id && /^[1-9][0-9]{0,9}$/.test(id) ? `${path}?alert=${id}` : path;
    }
    return path;
  }
  if (SLUG_PATH.test(path) && !path.startsWith("/admin")) return path;
  return null;
}
