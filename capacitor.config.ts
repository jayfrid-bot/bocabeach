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
    backgroundColor: "#020617",
  },
};

export default config;
