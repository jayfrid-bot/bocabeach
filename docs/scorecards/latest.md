# Prediction scorecard — 2026-10-06

Data as of 2026-10-06 18:25 UTC. Hourly rows cover the last 14 days. Sun-color events cover everything since the log began. A system with too little data says "collecting" and shows counts only. That is expected early on. See docs/scorecards/README.md for definitions and minimums.

## At a glance

- **Sunrise and sunset color:** collecting — 0 of 10 pairs. (78 events forecast, 1 camera reading so far.)
- **Rain forecast:** collecting — 0 of 50 scored calls. (0 rain calls archived.)
- **Best time to go:** collecting — 0 of 10 days. (296 finished days with enough hours.)
- **Safety message and flags:** collecting — 0 of 50 hours. (0 hours with a green or yellow flag.)
- **Data health:** 39 beaches archiving. Extra data on 38.6% of the last 24 hours' rows. 36 beaches under 12 rows a day (0 of them curated). Beaches that should archive all day miss local hours 15, 16, 17, 18, 19 on most days.

## Sunrise and sunset color

We forecast the color of each sunrise and sunset. Then we compare with what the beach cameras saw. One pair is one event (one beach, one sunrise or sunset) that has both a forecast and a camera reading.

- Events loaded (a forecast made 60+ minutes ahead, or a camera reading): 78.
- Pairs: 0 (0 forecast rows). Status: collecting — 0 of 10 pairs.
- Camera readings in the archive: 1; 1 of them matched no forecast row, so they cannot be scored.

## Rain forecast

The app says "dry" or "raining" from a weather model. We check it against the radar reading one and two hours later. Radar rain means a rate above 0 mm/hr, or a fresh frame that saw rain at or near the beach in the last 20 minutes.

- Hours with a rain call: 0.
- Scored (radar one and two hours later): 0. Status: collecting — 0 of 50 scored calls.

## Best time to go

Each morning the app names a best window for the beach. We take the window it named by 10 AM local time. Then we compare it with the hourly scores the day really had, over daylight hours, for finished days only.

- Finished days with 8 or more scored daylight hours: 296.
- Of those, with a window named by 10 AM: 0. Status: collecting — 0 of 10 days.
- Left out: 39 still in progress, 230 with too few hours, 296 with no early window.

Days ahead: no outlook rows with a finished target day yet.

## Safety message and lifeguard flags

We compare our swim message (safe, caution, stay out) with the lifeguard flag that was flying. Only beaches with a posted flag count.

- Hours with a swim message and a known flag: 0. Status: collecting — 0 of 50 hours.

## Data health

- Beaches with rows in the last 7 days: 39.
- Extra data (the prediction blocks) is on 2.5% of rows in this report's window, 38.6% of the last 24 hours, and 100% of rows since the first one (2026-10-06 15Z).
- Share of the last 24 hours' extra rows with each block: window 98.3%, rain 0%, flags 0%, outlook 0%, safety 100%, rip 100%.
- Local hours missing on beaches that should archive all 24 (3 beaches, 18 beach-days): 15 (38.9% present), 16 (0% present), 17 (0% present), 18 (0% present), 19 (0% present). "Best time to go" cannot score these hours, and sunset forecasts close to the event are missing.
- Beaches under 12 rows a day (finished days, last 7 days), worst first. Auto-tier beaches archive daylight hours only, so their full count is the Expected column:

| Beach | Tier | Rows per day | Expected | Fewest in a day | Days counted |
| --- | ---: | ---: | ---: | ---: | ---: |
| south-padre-island | auto | 5 | 12 | 4 | 6 |
| tybee-island | auto | 5.4 | 12 | 5 | 5 |
| virginia-beach | auto | 5.2 | 11 | 5 | 5 |
| wrightsville-beach | auto | 5.2 | 11 | 5 | 5 |
| santa-monica | auto | 6.2 | 12 | 5 | 6 |
| seaside | auto | 5.7 | 11 | 5 | 6 |
| santa-cruz | auto | 6 | 11 | 5 | 6 |
| pismo-beach | auto | 6.5 | 11 | 6 | 6 |
| rehoboth-beach | auto | 6.5 | 11 | 6 | 6 |
| naples | auto | 7.2 | 12 | 7 | 5 |

  And 26 more (7.2 to 9.2 rows a day).

- Latest camera capture per beach (oldest first): fort-lauderdale 5.1 h ago, deerfield-beach 3.3 h ago, boca-raton 0.8 h ago.
- Sun camera readings: 1; latest event 2026-10-06T11:15:11.868Z, scored 2026-10-06T15:35:12.641Z.
- Sun-color forecast rows in the last 24 hours: 240.

---

Made by `npx vite-node -c vitest.config.ts scripts/scorecard.ts`. Read-only: it never writes to the database.
