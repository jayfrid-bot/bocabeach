// User-facing changelog, shown at the bottom of the page under "What's new."
// Newest entries first. Keep the language plain and beachgoer-friendly —
// this is release notes for people checking if today's a beach day, not an
// engineering log. No file names, no internal codenames.

export type ChangelogTag = "new" | "improved" | "fixed";

export interface ChangelogEntry {
  date: string; // YYYY-MM-DD
  title: string;
  details?: string;
  tag?: ChangelogTag;
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026-07-24",
    title: "Golden hour sunset quality, and labels on every score wheel slice",
    details:
      "Every wedge of the score wheel now shows its own label, rip current risk shows the time it applies to, and water clarity reads out in friendlier, more positive language.",
    tag: "improved",
  },
  {
    date: "2026-07-22",
    title: "Tide flags for king tides and unusually low tides",
    details: "A heads-up when the tide is running well above or below its normal range for the day.",
    tag: "new",
  },
  {
    date: "2026-07-22",
    title: "Water clarity, calibrated with an underwater camera",
    details:
      "An underwater camera at Deerfield Beach helps calibrate how clear the water actually looks from the shore cams.",
    tag: "new",
  },
  {
    date: "2026-07-22",
    title: "Busyness and seaweed, compared to the average day",
    details: "See how today stacks up — like \"about 10% quieter than the average Tuesday.\"",
    tag: "new",
  },
  {
    date: "2026-07-22",
    title: "Six new beach metrics",
    details:
      "Feels-like beach temperature, water cooling trend, hour-by-hour rip current detail, man-o'-war advisory, and seasonal shark context.",
    tag: "new",
  },
  {
    date: "2026-07-21",
    title: "Beach cams read water clarity every 10 minutes",
    details: "Clarity now refreshes through the whole day instead of just a few times.",
    tag: "improved",
  },
  {
    date: "2026-07-20",
    title: "Water quality advisories now cap the score instead of forcing it down",
    details: "Score bands were also recalibrated, and wind is now a factor.",
    tag: "improved",
  },
  {
    date: "2026-07-17",
    title: "Cards flip over to show how we compute this",
    details:
      "Tap a card and flip it for the plain-English math and data sources behind the number — including sun, tides, and air quality.",
    tag: "new",
  },
  {
    date: "2026-07-17",
    title: "Sand temperature's evening cooldown, tuned for accuracy",
    tag: "improved",
  },
  {
    date: "2026-07-17",
    title: "Fixed a false \"no good window\" on the last day of the forecast",
    tag: "fixed",
  },
  {
    date: "2026-07-16",
    title: "Sand temperature's afternoon dip smoothed into a gentle slope",
    details: "No more cliff-edge drop in the late afternoon reading.",
    tag: "fixed",
  },
  {
    date: "2026-07-16",
    title: "Tide curve restored alongside the animated shoreline",
    tag: "improved",
  },
  {
    date: "2026-07-16",
    title: "Score moved to the top of the page, tide trend made more prominent",
    tag: "improved",
  },
  {
    date: "2026-07-16",
    title: "UV now accounts for real satellite cloud cover, not just the forecast",
    tag: "improved",
  },
  {
    date: "2026-07-15",
    title: "Sand temperature reads the sky from satellite, not just the forecast",
    details: "Cloud cover feeding the sand temperature model now comes from real satellite observations.",
    tag: "improved",
  },
  {
    date: "2026-07-15",
    title: "Sun-position dial with the moon built in",
    details: "A live sun-arc dial shows where the sun is in the sky, plus the current moon phase.",
    tag: "new",
  },
  {
    date: "2026-07-15",
    title: "Live lightning strike tracking",
    details: "See recent strikes near the beach on a top-down radar view.",
    tag: "new",
  },
  {
    date: "2026-07-15",
    title: "UV, busyness, and seaweed get their own visuals",
    details: "A UV burn-time ring, a busyness crowd icon, and a seaweed coverage strip.",
    tag: "new",
  },
  {
    date: "2026-07-15",
    title: "An animated shoreline for the tide card",
    details: "Replaces the plain tide curve with a live cross-section of the beach and water.",
    tag: "new",
  },
  {
    date: "2026-07-14",
    title: "Storm activity meter",
    details: "An at-a-glance read on how much storm activity is happening nearby.",
    tag: "new",
  },
  {
    date: "2026-07-14",
    title: "Seaweed coverage now has a sliding ceiling on the score",
    details: "How much seaweed caps the score now scales with how much seaweed is actually out there.",
    tag: "improved",
  },
  {
    date: "2026-07-14",
    title: "One combined best-times-and-forecast strip",
    details: "Today's best window and the 7-day outlook now live in a single strip.",
    tag: "improved",
  },
  {
    date: "2026-07-14",
    title: "Build number and last-updated time added to the footer",
    tag: "new",
  },
  {
    date: "2026-07-09",
    title: "The site now runs on faster, more reliable hosting",
    tag: "improved",
  },
  {
    date: "2026-07-06",
    title: "Interactive score wheel replaces the hourly line graph",
    details: "Tap into the wheel to see exactly what's driving today's score.",
    tag: "new",
  },
  {
    date: "2026-06-26",
    title: "Morning beach-day summary notifications",
    details: "A rich daily push notification at 8 AM with the day's outlook, for the app on your phone.",
    tag: "new",
  },
  {
    date: "2026-06-23",
    title: "Sand temperature recalibrated against ground readings",
    details: "Tuned against real infrared thermometer readings taken on the sand.",
    tag: "improved",
  },
  {
    date: "2026-06-22",
    title: "Crescent Bay Park (Santa Monica, CA) added",
    tag: "new",
  },
  {
    date: "2026-06-21",
    title: "Fixed sand temperature showing two different values in different spots",
    tag: "fixed",
  },
  {
    date: "2026-06-17",
    title: "Native app push notifications, for iOS and Android",
    tag: "new",
  },
  {
    date: "2026-06-17",
    title: "About 35 US beaches, and a beach finder",
    details: "Boca Raton stays the home page, with a link to browse and search beaches nationwide.",
    tag: "new",
  },
  {
    date: "2026-06-17",
    title: "Multi-day best beach times forecast",
    tag: "new",
  },
  {
    date: "2026-06-16",
    title: "Lightning threshold tightened to 5 miles",
    details: "Fewer false alarms for storms that never actually got close.",
    tag: "improved",
  },
  {
    date: "2026-06-15",
    title: "Rain and nearby lightning now properly tank the score",
    tag: "fixed",
  },
  {
    date: "2026-06-15",
    title: "Pull-to-refresh, and a plain-English score explainer",
    details: "Pull down on the page to refresh, and see the score explained in plain English alongside the technical breakdown.",
    tag: "new",
  },
  {
    date: "2026-06-12",
    title: "Multi-source weather consensus",
    details: "Conditions are now cross-checked across multiple weather sources instead of relying on just one.",
    tag: "improved",
  },
  {
    date: "2026-06-12",
    title: "Light mode",
    details: "A three-way toggle between light, dark, and system theme.",
    tag: "new",
  },
  {
    date: "2026-06-12",
    title: "Sand temperature calibrated to infrared ground readings",
    details: "Plus a surf-to-dunes temperature range instead of a single number.",
    tag: "improved",
  },
  {
    date: "2026-06-11",
    title: "Moon cycle gets its own card",
    tag: "new",
  },
  {
    date: "2026-06-11",
    title: "Now available as an iOS app",
    tag: "new",
  },
  {
    date: "2026-06-11",
    title: "Sand temperature scored as its own metric",
    details: "Plus a live daylight arc and compass.",
    tag: "new",
  },
  {
    date: "2026-06-10",
    title: "Live wind, tide, and moon cycle visuals",
    tag: "new",
  },
  {
    date: "2026-06-10",
    title: "Rebrand: Is It Beach Day",
    details: "New name, new logo and icons, and a verdict-led redesign.",
    tag: "new",
  },
  {
    date: "2026-06-08",
    title: "History charts for seaweed and busyness",
    details: "See how seaweed and crowd levels have trended by hour and by day.",
    tag: "new",
  },
  {
    date: "2026-06-08",
    title: "Installable as an app on your phone",
    details: "Add the site to your home screen and it works like a native app, even with spotty signal.",
    tag: "new",
  },
  {
    date: "2026-06-03",
    title: "Water quality advisories, air quality meter, and hourly score forecast",
    tag: "new",
  },
  {
    date: "2026-06-03",
    title: "Live lightning strike radar",
    details: "Direction and distance to the nearest strike, plus square lifeguard-style flags.",
    tag: "new",
  },
  {
    date: "2026-06-03",
    title: "Rip current risk and active weather alerts",
    tag: "new",
  },
  {
    date: "2026-06-03",
    title: "Seaweed outlook, read straight from the beach cams",
    tag: "new",
  },
  {
    date: "2026-06-02",
    title: "Hourly Beach Day score forecast",
    tag: "new",
  },
];
