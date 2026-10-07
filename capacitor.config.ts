import type { CapacitorConfig } from "@capacitor/cli";

// iOS shell app: a native container that loads the live site, so web deploys
// reach the app instantly with no App Store resubmission. `webDir` is only a
// tiny offline fallback page (mobile/www) shown if the remote can't load.
const config: CapacitorConfig = {
  appId: "com.isitbeachday.app",
  plugins: {
    PushNotifications: {
      // Without this, iOS drops a push that arrives while the app is OPEN —
      // the exact moment a beachgoer has it open on the sand. Owner lost the
      // 2026-10-07 "rain starting soon" alert this way (APNs accepted it,
      // nothing showed). Show the banner, badge and sound in the foreground too.
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
  appName: "Is It Beach Day",
  webDir: "mobile/www",
  server: {
    // The app shell loads the LIVE site from a dedicated Cloudflare Worker origin
    // (OpenNext). A Worker always serves the latest deploy, so web changes reach the
    // app with no App Store resubmission — same property the old Netlify alias had.
    // Why a FRESH hostname (not isitbeachday.com): the apex once had a stuck service
    // worker serving stale JS across reinstalls; app.isitbeachday.com has no such
    // history. Push tokens register to Workers KV via this origin. No URL bar in the
    // shell, so the origin is invisible. (Migrated off Netlify 2026-07.)
    url: "https://app.isitbeachday.com",
  },
  ios: {
    // "never": the page's own CSS (globals.css, env(safe-area-inset-top/bottom))
    // is the ONE source of the status-bar / home-indicator inset. With
    // "automatic", once the app adopted UIScene (build 2026092303, iOS 27 crash
    // fix) the scroll view ALSO insets the page, so the status-bar gap showed
    // twice — a ~60 pt blank band above the header (owner 2026-09-28).
    contentInset: "never",
    backgroundColor: "#f3f7fb",
    // Build-stamped marker so the web app can detect the native shell even when
    // the bundled @capacitor/core mis-detects "web" on the remote URL.
    appendUserAgent: "IsItBeachDayApp/ios",
  },
  android: {
    backgroundColor: "#f3f7fb",
    appendUserAgent: "IsItBeachDayApp/android",
  },
};

export default config;
