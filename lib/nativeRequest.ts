import { headers } from "next/headers";

/**
 * Detect the native app shell from the request User-Agent. The Capacitor iOS /
 * Android shells append "IsItBeachDayApp/<platform>" to the user agent (see
 * capacitor.config.ts `appendUserAgent`), and that tag rides on every request
 * the in-app WebView makes — including the HTML document request.
 *
 * Detecting server-side is the robust path for our remote-URL shell: it doesn't
 * depend on the bundled @capacitor/core's client detection, and — crucially —
 * it isn't defeated by a stale client JS cache. Calling this opts the page into
 * dynamic rendering, so the app always receives fresh, uncached HTML (which in
 * turn references the latest JS chunks) rather than a cached shell.
 */
const NATIVE_UA = /IsItBeachDayApp/i;

export async function isNativeAppRequest(): Promise<boolean> {
  try {
    const ua = (await headers()).get("user-agent") ?? "";
    return NATIVE_UA.test(ua);
  } catch {
    return false;
  }
}
