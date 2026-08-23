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
  /** Set when the entry was written AFTER the work shipped (documenting an
   *  earlier date). Tested: the date must then match a real commit day in git. */
  backfilled?: boolean;
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026-08-23",
    title: "Golden hour card: times, a countdown, and a simple timeline",
    details:
      "The sunset illustration is gone. The card now leads with how long until golden hour (or how long is left once you're in it), the exact window and sunset time, and a clean timeline that lights up while golden hour is on.",
    tag: "improved",
  },
  {
    date: "2026-08-23",
    title: "Fixed: beach cams could show an old frame labeled as live",
    details:
      "If the app sat in the background for a while, a cam could keep showing an older picture under a fresh-looking time. Cams now say \"Live\" only when both the picture and the page's data are truly current, refresh the moment you come back, and say \"Feed paused\" when a camera stops sending new frames.",
    tag: "fixed",
  },
  {
    date: "2026-08-23",
    title: "Overnight, busyness and water clarity show yesterday and the next read time",
    details:
      "The cams can't see in the dark, so instead of a blank, the cards now tell you how the day went — like \"Yesterday: Moderate, peaked around 2 PM\" or \"Yesterday: Mostly clear\" — plus when the next camera read lands in the morning.",
    tag: "improved",
  },
  {
    date: "2026-08-23",
    title: "Fixed: wrong dates on recent entries in this list",
    details: "Two August updates were mislabeled as July. Dates here are now checked against the actual release record.",
    tag: "fixed",
  },
  {
    date: "2026-08-17",
    title: "Is It Beach Day is on the App Store",
    details:
      "The iPhone app is here — free, with the same live Beach Day score, cams, and an optional morning heads-up notification. Look for the App Store link at the top of the page.",
    tag: "new",
  },
  {
    date: "2026-08-16",
    title: "Fixed: lifeguard flags read as double red all day",
    details:
      "The City's page added a standing note that double red flags may be flown during lightning. We were reading that as the flag actually flying, which pinned the beach score near zero. Now hedged wording is treated as a heads-up, not a posting — and the real flags (like yellow and purple) are read correctly.",
    tag: "fixed",
  },
  {
    date: "2026-07-28",
    title: "Live rain radar — see showers before they arrive",
    details:
      "Real weather radar now watches the beach: when rain is on the way you'll see it called out — roughly how far off it is and about when it could arrive. When radar shows rain, it overrides the forecast's opinion.",
    tag: "new",
  },
  {
    date: "2026-07-28",
    title: "Real water level, not just the tide tables",
    details:
      "The tide panel now shows the actually-measured water level from the nearest NOAA gauge and how far above or below the predicted tide it's running.",
    tag: "new",
  },
  {
    date: "2026-07-28",
    title: "Satellite eyes on the sky score",
    details:
      "The cloud reading behind the score now includes what the weather satellite actually sees overhead — not just what forecast models expect.",
    tag: "improved",
  },
  {
    date: "2026-07-28",
    title: "Straight talk about where each reading comes from",
    details:
      "Flip a card over and it now names its live source — real buoy vs. weather model — instead of implying measurements the local stations can't make. Rip current detail also now accounts for the direction waves approach the shore.",
    tag: "improved",
  },
  {
    date: "2026-07-24",
    title: "Little scenes on the Golden hour and Water clarity cards",
    backfilled: true,
    details:
      "The sunset card now paints tonight's predicted sky — vivid when a show is coming, gray for a dud — and water clarity shows a swimmer's-eye view where the seafloor fades with the murk.",
    tag: "new",
  },
  {
    date: "2026-07-24",
    title: "A cleaner, tidier dashboard",
    backfilled: true,
    details:
      "Cards reorganized so everything lines up with no gaps, duplicate readings removed, and quieter one-line advisories.",
    tag: "improved",
  },
  {
    date: "2026-07-24",
    title: "Water clarity tuned against a real swim",
    backfilled: true,
    details:
      "The clarity reading was calibrated against in-the-water checks at the beach itself — it now tracks what the water actually looks like much more closely.",
    tag: "improved",
  },
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
