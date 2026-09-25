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
    date: "2026-09-25",
    title: "Smoother Plus purchases",
    details:
      "Backing out of the App Store payment sheet no longer shows an error, purchases that need a family organizer's approval say so, and Plus re-checks your subscription on its own when a billing period ends. The privacy page now explains what Apple and RevenueCat receive for a subscription.",
    tag: "fixed",
  },
  {
    date: "2026-09-24",
    title: "Hour-by-hour rip current risk",
    details:
      "Rip current risk now shows a percent chance for each hour, from NOAA's hourly rip current model, at 27 beaches. Alerts only show as active while they're actually in effect, never before they start. When the model and the National Weather Service forecast disagree, the app shows both.",
    tag: "improved",
  },
  {
    date: "2026-09-23",
    title: "Privacy page: how we count daily visitors",
    details:
      "Your device now sends one note a day saying it opened the app, with a scrambled id that can't be traced back to you, so we can count people instead of page loads. The privacy page spells out exactly what's in it.",
    tag: "improved",
  },
  {
    date: "2026-09-23",
    title: "Nearest beach now checks the whole shoreline, not just one point",
    details:
      "South Boca no longer gets sent to Deerfield Beach — we now measure to the closest stretch of a beach's sand, not one pin in the middle of town.",
    tag: "fixed",
  },
  {
    date: "2026-09-23",
    title: "More of the score on your first screen",
    details:
      "A tighter top of the page on phones: a smaller beach name, no county line, lifeguard flags on one line, and less space around them, so the score wheel shows without scrolling.",
    tag: "improved",
  },
  {
    date: "2026-09-23",
    title: "Fresher data on quieter beaches, and the sun arc matches golden hour",
    details:
      "If a beach's conditions are more than 10 minutes old when you open it, the page now fetches fresh ones a few seconds later. The sun arc now glows for the same 20-minute golden hour window as the sunrise and sunset color card.",
    tag: "fixed",
  },
  {
    date: "2026-09-23",
    title: "Pull to refresh now feels like a refresh",
    details:
      "The page follows your finger, bounces back when fresh data lands, and a small note shows the time of the data you're now seeing.",
    tag: "improved",
  },
  {
    date: "2026-09-23",
    title: "Cam-based cards now say when the next camera read is coming, and the app updates itself",
    details:
      "Beach busyness, water clarity, and seaweed now show a quiet \"Next cam read ~\" line, learned from the last two weeks of camera reads. The app also reloads itself when you come back to it after an update, so you're never stuck looking at an old version.",
    tag: "new",
  },
  {
    date: "2026-09-23",
    title: "Simpler sunrise and sunset color card, and a tighter golden hour",
    details:
      "The card now says \"Upcoming sunrise color\" or \"Upcoming sunset color\" and rates it in one plain word: Poor, Fair, Good, Great, or Amazing. Golden hour now runs from 20 minutes before to 20 minutes after sunrise and sunset.",
    tag: "improved",
  },
  {
    date: "2026-09-22",
    title: "Beach Session on your Lock Screen — coming in the next app update",
    details:
      "While Beach Mode is on, opt in to a Lock Screen and Dynamic Island view of the score, sunset and tide countdowns, wind, waves, and a lightning heads-up where you're standing.",
    tag: "new",
  },
  {
    date: "2026-09-22",
    title: "Beach Mode now tells you about lightning and rain where you stand, not just at the beach's center",
    tag: "new",
  },
  {
    date: "2026-09-22",
    title: "Beaches with thin data now say so",
    details:
      "Most beaches don't have cams, so readings like seaweed, crowds and water clarity are often unavailable. The score now tracks how much is actually known — a forecast-model wave or water-temperature reading counts as partial, not full — shows a quiet note when a lot is missing or estimated, and can no longer call a beach 'Excellent' or 'Absolutely!' on a mostly unknown or estimated picture.",
    tag: "improved",
  },
  {
    date: "2026-09-22",
    title: "Deerfield Beach and Fort Lauderdale cam readings are back",
    details:
      "Crowd, seaweed and water-clarity readings for Deerfield Beach and Fort Lauderdale had stopped on September 18. The camera pickup recovered on its own, and the backup image reader that should have covered the gap was pointed at a model that no longer exists. Both are fixed, so those readings keep coming even when the main reader hits its daily limit.",
    tag: "fixed",
  },
  {
    date: "2026-09-18",
    title: "Water clarity tile no longer cuts off its note on phones",
    details:
      "When a beach's cams haven't had a clear read in a few days, the Water clarity tile explains that. On phones that note ran past the tile and got cut off mid-sentence; it now shows the short version, with the full wording on larger screens.",
    tag: "fixed",
  },
  {
    date: "2026-09-18",
    title: "The score holds steady when a storm sits on the edge",
    details:
      "When lightning was hovering right around five miles out, or a shower sat at the edge of the radar, the score could jump between a safety cap and a normal number every time you refreshed. Now a rain or lightning cap holds for a short while after the last observation — 30 minutes after the last close strike, matching the usual safety rule, 20 minutes after the radar last saw rain — and then clears. The card says when it's holding ('Rain in the last 20 minutes'). Safety alerts and the score now use the same rain and lightning rule.",
    tag: "fixed",
  },
  {
    date: "2026-09-18",
    title: "Boca Raton wave height now comes from a real buoy",
    details:
      "Boca's wave height was being estimated from a forecast model, which ran high — it could say 3 feet on a day the surf was barely over a foot. It now reads the live ocean buoy just down the coast at Hillsboro, the same one Deerfield and Fort Lauderdale already use, so the wave height matches what you actually see at the shore. Water temperature still comes from the closer Lake Worth Pier station.",
    tag: "fixed",
  },
  {
    date: "2026-09-17",
    title: "Your personal score profile is now Plus-only after the preview",
    details:
      "Everyone still gets the one-time preview of their personal score during setup. After that, saving changes to your score profile is part of Beach Day Plus, and the app now says so instead of quietly accepting the change.",
    tag: "improved",
  },
  {
    date: "2026-09-17",
    title: "Beach Mode now follows you, tells you what it's watching, and never misses a second warning",
    details:
      "Safety alerts now check every hazard on its own, so a tornado warning or a double-red closure is never hidden behind lightning, a rip-current note, or an alert you turned off. Move from one beach to another and the alerts move with you — and a beach you picked by hand stays put. The card now names the beach it is watching, says whether it's measuring from your spot or from the beach itself, and tells you plainly when notifications still need turning on instead of claiming alerts are on. Arriving at a beach only turns alerts on from a fresh, accurate position, never an old one. Rain timing now reads the forecast the way it is published, and 'rain clearing' is only promised when the whole next hour is known to be dry. Android phones that share an approximate location can still find their nearest beach.",
    tag: "fixed",
  },
  {
    date: "2026-09-17",
    title: "Beach Day Plus is a little harder to fool, and a lot harder to lose",
    details:
      "The free trial and the unlock code now hold up better under someone trying to abuse them, and a purchase that hits a bad connection right after checkout no longer gets stuck — it finishes unlocking Plus on its own the next time you open the app, or with a tap on Restore.",
    tag: "improved",
  },
  {
    date: "2026-09-17",
    title: "Fort Lauderdale now shows real lifeguard flags — and radar covers every beach",
    details:
      "Fort Lauderdale Beach now gets the City's daily lifeguard flags, sea-pest notes (like man-o'-war), and ocean report, read from Fort Lauderdale Fire Rescue's beach-conditions page the same way Deerfield's flags come from the City. The flag goes to 'unknown' if the City's page is more than two days old, so you never see a stale flag as today's. Rain radar now covers every beach in the app, not just Boca Raton.",
    tag: "new",
  },
  {
    date: "2026-09-17",
    title: "The privacy page now explains how we count our QR stickers",
    details:
      "If you get here by scanning one of our beach stickers, we count the scan and hold a scrambled, unreadable form of your network address for six hours, so we can tell whether the sticker actually helped anyone find the app. It expires on its own, it can't be read back as your address, and it never follows you anywhere else. The privacy page now says so plainly.",
    tag: "improved",
  },
  {
    date: "2026-09-16",
    title: "A live cam for Fort Lauderdale Beach",
    details:
      "Fort Lauderdale Beach now has a live beach camera, courtesy of Elbo Room. Its crowd, seaweed, and water-clarity readings come from that camera too. Like any cam, it won't show much after dark.",
    tag: "new",
  },
  {
    date: "2026-09-16",
    title: "Fort Lauderdale Beach is now supported",
    details:
      "Fort Lauderdale Beach at Las Olas gets its own Beach Day score. It uses tides from Bahia Mar, waves and water temperature from the Hollywood Beach buoy, the NWS Miami surf and rip-current forecast, and water-quality results from the Sebastian Street and Bahia Mar sampling sites.",
    tag: "new",
  },
  {
    date: "2026-09-14",
    title: "Faster share card and a cleaner shared link",
    details:
      "The card is now drawn ahead of time while you read the page and cached at the edge, so the Share sheet opens fast instead of pausing to render. The sheet also draws only the shape you pick. The link you share is now a plain isitbeachday.com — no tracking tag tacked on.",
    tag: "improved",
  },
  {
    date: "2026-09-14",
    title: "Share today's beach conditions as a card",
    details:
      "A new Share button next to Alerts builds a card in the Beach Day look — sun, waves, and the score ring — with water, air, and sand temp, water clarity, waves, and UV. Sized for an Instagram or TikTok story, or a square post. Post your own beach photos, then share the card alongside them.",
    tag: "new",
  },
  {
    date: "2026-09-14",
    title: "Deerfield Beach is now fully supported",
    details:
      "Deerfield Beach gets its own Beach Day score: tides from the Hillsboro River station, water quality from the two Deerfield sampling sites, and lifeguard flags straight from the City. Four City cameras — three on the sand and surf, one underwater — feed the busyness, seaweed, and water clarity readings.",
    tag: "new",
  },
  {
    date: "2026-09-10",
    title: "The 7-day outlook now forecasts the sea state for each day",
    details:
      "Every day card used to show today's wave reading — a whole week of '3 ft · really choppy' even when the ocean was forecast to calm down. Each day now uses the marine model's wave forecast for that day, so calm days ahead score as calm days.",
    tag: "fixed",
  },
  {
    date: "2026-09-08",
    title: "Sand temperature is one number now, not a 10-degree range",
    details:
      "The sand reading is now a single figure: the dry sand you actually walk across, the surface the thermometer calibrations are taken on. The firm, damp strip right at the water's edge runs cooler, but it no longer gets its own number.",
    tag: "improved",
  },
  {
    date: "2026-09-08",
    title: "Sand temperature now notices when the sky has thickened since the last satellite reading",
    details:
      "When the satellite's last measured hour was bright but a fresher pass shows the clouds have since closed in, the sand estimate no longer assumes the sun kept pouring through. A patchy late-morning sky read 126°F where the sand was really 120°F; the estimate now gives up part of the lost sun instead of carrying the earlier brightness forward at full strength. A sky that stays the same is unaffected.",
    tag: "improved",
  },
  {
    date: "2026-09-07",
    title: "Fourteen Plus fixes from a full review: alerts, Beach Mode, restore, and your settings",
    details:
      "Safety alerts no longer overwrite each other on your lock screen (a rain notice used to replace a lightning warning). Beach Mode's Off now stays off until you leave that beach, and Extend can only ever add time. The morning report arrives at 8 AM in your beach's time zone. Restore only says 'Restored' when Plus is actually on, and the trial button only promises 3 days free when the App Store confirms you're eligible — otherwise it plainly says Subscribe with the price. A code or trial you already have can never be shortened by a subscription, and a lost push token no longer erases anything. Settings you turned off stay off when you reopen the app, and a save that fails on a bad connection retries on its own.",
    tag: "fixed",
  },
  {
    date: "2026-09-07",
    title: "Beach Day Plus can now be bought in the iPhone app — monthly or yearly, with 3 days free",
    details:
      "The paywall in the app now offers two plans, $2.99 a month or $19.99 a year, and buys through the App Store like any subscription: 3 days free first, nothing charged today, cancel anytime in Settings. Restore brings a purchase back on a new phone. If you already have a code, it still works.",
    tag: "new",
  },
  {
    date: "2026-09-05",
    title: "Two iPhone fixes: the header clears the status bar, and Alerts stops crying wolf",
    details:
      "In the app, the top bar no longer sits under the clock and the Dynamic Island, and the last row no longer hides behind the home indicator. And the Alerts button only says notifications are blocked when your phone actually says so — a hiccup while turning them on now reads as 'Try again', not as a denial you never made.",
    tag: "fixed",
  },
  {
    date: "2026-09-05",
    title: "Beach Day Plus lives in the iPhone app — the website now points you there",
    details:
      "Personalized scores and location-based alerts need your phone: its location, its notifications, and the App Store to pay through. So the website no longer runs the Plus questions or the free trial. It shows what Plus includes and sends you to the app. Everything the site showed for free is still free, unchanged.",
    tag: "improved",
  },
  {
    date: "2026-09-04",
    title: "The Sky reading now measures the sun that's actually out",
    details:
      "On a blue-sky day behind thin, wispy cloud, the forecast models all cried overcast and the Sky line could read a contradictory 'Clear · 98% cloud' while you stood in full sun. When the sun is well up, we now measure it directly — how much sunlight the satellite sees reaching the ground — so a sky that's really clear reads clear and scores like it. A genuinely grey, overcast sky still reads grey.",
    tag: "improved",
  },
  {
    date: "2026-09-04",
    title: "Sand temperature and the rain warning now trust what's observed over what was forecast",
    details:
      "The forecast can call for a shower that never comes. When that happened, the sand estimate believed the beach was soaked and read 94°F on a day the sand was really 130°F, and the score warned of rain under a sunny sky. Now the radar and the satellite get the final say: an hour the satellite saw in full sun can't have rained, and a radar that sees nothing overrules a forecast rain warning for the current hour.",
    tag: "fixed",
  },
  {
    date: "2026-09-02",
    title: "Beach Day Plus, with a 3-day free trial",
    details:
      "A new paid tier: your own personal Beach Day score, safety and surf alerts computed from right where you're standing, and a morning summary in your number. Try it free for 3 days from the Personalize or Alerts button.",
    tag: "new",
  },
  {
    date: "2026-09-02",
    title: "Personalize my score",
    details:
      "Tell us how you use the beach — swimming, watching kids, sunbathing, snorkeling, walking the dog, walking the shore, or surfing — and the score re-ranks around what matters to you. Advanced tuning lets you adjust each factor by hand. Part of Beach Day Plus.",
    tag: "new",
  },
  {
    date: "2026-09-02",
    title: "A swim safety line, and a surf conditions line, right under the score",
    details:
      "The score now sits beside a plain safety read — Safe, Caution, or Stay out for swimmers; Go, Experienced only, or Closed for surfers — so the safety call is never buried in the fine print.",
    tag: "new",
  },
  {
    date: "2026-09-02",
    title: "Find my nearest beach, and a \"near you\" chip",
    details:
      "One tap sets your home beach by distance. Once it's set, a small chip shows how far you are from it, or points you to the nearest beach we cover.",
    tag: "new",
  },
  {
    date: "2026-09-02",
    title: "Beach Mode — alerts from right where you stand",
    details:
      "With Beach Day Plus, turn on Beach Mode and alerts are computed from your actual spot on the sand: lightning distance measured from you, rain where you are, flag and rip changes, and storms moving in. Auto-arms when you're near a beach.",
    tag: "new",
  },
  {
    date: "2026-09-02",
    title: "Alert settings, with a toggle for each kind",
    details:
      "Choose exactly which Beach Mode alerts you want — lightning, storms, rain, wind, flags, rip current, water advisories — each with its own on/off switch.",
    tag: "new",
  },
  {
    date: "2026-09-02",
    title: "The morning summary now speaks in your own score",
    details:
      "Beach Day Plus subscribers get the daily morning notification tuned to their personal score, instead of everyone's.",
    tag: "improved",
  },
  {
    date: "2026-09-02",
    title: "Water clarity now counts toward the score for snorkelers",
    details:
      "Pick the Snorkeling profile and water clarity becomes one of the biggest factors in your personal score, wherever we have a clarity reading.",
    tag: "improved",
  },
  {
    date: "2026-08-31",
    title: "Clearer overnight cam readings, and no cut-off text on the Golden hour card",
    details:
      "At night the busyness and water-clarity cards now read plainly as a look-back — \"Earlier today: Quiet\" (or \"Yesterday\" after midnight) with when the cameras resume in the morning — so it's obvious you're seeing the past, not a live number. The Golden hour card's lines also wrap fully instead of getting cut off on a phone.",
    tag: "improved",
  },
  {
    date: "2026-08-31",
    title: "A capped score now tells you why, right at the top",
    details:
      "When something holds the beach score down — lightning nearby, a water-quality advisory, high wind, heavy seaweed — a clear banner now sits at the top of the score saying what's capping it and to what, instead of hiding the reason in the fine print.",
    tag: "improved",
  },
  {
    date: "2026-08-31",
    title: "Simpler seasonal heads-up for sharks, jellyfish, and sea lice",
    details:
      "A calm \"What's in the water\" panel now shows every day, telling you at a glance whether it's the season for Portuguese man-o'-war, sea lice, and sharks — in plain, one-line language. Before, this only appeared on the rare day something was already flagged. It's seasonal guidance for SE-Florida beaches, not a live report, and it still speaks up when today's conditions are worth an extra look.",
    tag: "improved",
  },
  {
    date: "2026-08-28",
    title: "Fixed: cam readings going stale for hours",
    details:
      "The scheduler that reads the beach cams was being throttled to a few runs a day. It now keeps itself running through daylight hours, so seaweed, busyness, and water clarity stay current. Camera capture times are also fetched more reliably, and if readings ever do lapse, the cards now say plainly when the last clear read was.",
    tag: "fixed",
  },
  {
    date: "2026-08-23",
    title: "Fixed: cut-off text on phone-width cards",
    details: "Golden hour, water clarity, and seaweed no longer truncate mid-sentence on a phone — lines wrap, and long camera notes step aside on small screens.",
    tag: "fixed",
  },
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
