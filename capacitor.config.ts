import type { CapacitorConfig } from "@capacitor/cli";

// iOS shell app: a native container that loads the live site, so web deploys
// reach the app instantly with no App Store resubmission. `webDir` is only a
// tiny offline fallback page (mobile/www) shown if the remote can't load.
const config: CapacitorConfig = {
  appId: "com.isitbeachday.app",
  appName: "Is It Beach Day",
  webDir: "mobile/www",
  server: {
    url: "https://isitbeachday.com",
  },
  ios: {
    contentInset: "automatic",
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
