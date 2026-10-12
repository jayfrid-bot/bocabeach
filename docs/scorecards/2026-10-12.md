# Prediction scorecard — 2026-10-12

Data as of 2026-10-12 17:30 UTC. Hourly rows cover the last 14 days. Sun-color events cover the last 90 days; lifetime counts are shown in that section. A system with too little data says "collecting" and shows counts only. That is expected early on. See docs/scorecards/README.md for definitions and minimums.

## At a glance

- **Sunrise and sunset color:** collecting — 0 of 10 pairs. (545 events forecast, 1 camera reading so far.)
- **Rain forecast:** Of 1880 "dry for the next 2+ hrs" calls, 159 (8%) saw radar rain within 2 hours.
- **Best time to go:** 154 complete days (328 days left out for missing hours). Inside our window the archived hours averaged 59.8; the best 3 hours in a row averaged 66.8 (gap 7.0). The best hour fell inside our window on 82% of those days.
- **Safety message and flags:** collecting — 21 of 30 beach-days. (21 beach-days with a green or yellow flag.)
- **Data health:** 39 beaches archiving. Extra data on 100% of the last 24 hours' rows. 13 beaches under 12 rows a day (0 of them curated). Beaches that should archive all day miss local hours 0, 1, 2, 3, 4, 5, 6, 22, 23 on most days.

## Sunrise and sunset color

We forecast the color of each sunrise and sunset. Then we compare with what the beach cameras saw. One pair is one event (one beach, one sunrise or sunset) that has both a forecast and a camera reading.

- Events loaded (a forecast made 60+ minutes ahead, or a camera reading), last 90 days: 545.
- Pairs: 0 (0 forecast rows). Status: collecting — 0 of 10 pairs.
- Lifetime: 546 events and 6198 forecast rows logged since 2026-10-06; 0 rows paired; 1 camera reading.
- Camera readings in the window: 1; 1 of them matched no forecast row, so they cannot be scored.

### How often we say Great or Amazing

The model is built so about 20% of events are Great or better, and about 10% are Amazing. Shares wait for 10 events in a row.

|  | Events | Forecast Great+ | Forecast Amazing | Paired events | Forecast Great+ (paired) | Camera Great+ | Camera Amazing |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Design target |  | 20% | 10% |  |  | 20% | 10% |
| All beaches | 468 | 17% | 15% | 0 | — | — | — |
| asbury-park | 12 | 17% | 17% | 0 | — | — | — |
| biloxi | 12 | 25% | 25% | 0 | — | — | — |
| boca-raton | 12 | 0% | 0% | 0 | — | — | — |
| cannon-beach | 12 | 0% | 0% | 0 | — | — | — |
| cape-may | 12 | 25% | 25% | 0 | — | — | — |
| cocoa-beach | 12 | 25% | 17% | 0 | — | — | — |
| coney-island | 12 | 17% | 17% | 0 | — | — | — |
| crescent-bay-park | 12 | 0% | 0% | 0 | — | — | — |
| daytona-beach | 12 | 25% | 25% | 0 | — | — | — |
| deerfield-beach | 12 | 17% | 17% | 0 | — | — | — |
| folly-beach | 12 | 33% | 33% | 0 | — | — | — |
| fort-lauderdale | 12 | 25% | 25% | 0 | — | — | — |
| galveston | 12 | 8% | 8% | 0 | — | — | — |
| grand-isle | 12 | 33% | 25% | 0 | — | — | — |
| gulf-shores | 12 | 25% | 25% | 0 | — | — | — |
| hammonasset-beach | 12 | 17% | 17% | 0 | — | — | — |
| hampton-beach | 12 | 17% | 17% | 0 | — | — | — |
| huntington-beach | 12 | 8% | 0% | 0 | — | — | — |
| jacksonville-beach | 12 | 8% | 8% | 0 | — | — | — |
| la-jolla | 12 | 0% | 0% | 0 | — | — | — |
| long-beach | 12 | 0% | 0% | 0 | — | — | — |
| miami-beach | 12 | 17% | 17% | 0 | — | — | — |
| misquamicut | 12 | 25% | 17% | 0 | — | — | — |
| montauk | 12 | 17% | 17% | 0 | — | — | — |
| myrtle-beach | 12 | 25% | 25% | 0 | — | — | — |
| nags-head | 12 | 42% | 42% | 0 | — | — | — |
| naples | 12 | 50% | 42% | 0 | — | — | — |
| ocean-shores | 12 | 17% | 17% | 0 | — | — | — |
| old-orchard-beach | 12 | 8% | 8% | 0 | — | — | — |
| pismo-beach | 12 | 0% | 0% | 0 | — | — | — |
| rehoboth-beach | 12 | 25% | 17% | 0 | — | — | — |
| santa-cruz | 12 | 0% | 0% | 0 | — | — | — |
| santa-monica | 12 | 0% | 0% | 0 | — | — | — |
| seaside | 12 | 0% | 0% | 0 | — | — | — |
| south-padre-island | 12 | 8% | 8% | 0 | — | — | — |
| tybee-island | 12 | 33% | 25% | 0 | — | — | — |
| virginia-beach | 12 | 17% | 8% | 0 | — | — | — |
| waikiki | 12 | 17% | 8% | 0 | — | — | — |
| wrightsville-beach | 12 | 25% | 17% | 0 | — | — | — |

## Rain forecast

The app says "dry" or "raining" from a weather model, with a note on when that changes. We turn that into a forecast for one hour ahead and two hours ahead. "Dry, rain in 25 min" is a rain forecast for both. "Raining, easing in 25 min" is a dry forecast for both. A change at or before the hour has happened by then. Then we check each forecast against the radar reading one and two hours later. Radar rain means a rate above 0 mm/hr, or a fresh frame that saw rain at or near the beach in the last 20 minutes. A radar frame older than 25 minutes is not used.

- Hours with a rain call: 2919.
- Scored (radar available one and two hours later): 2189. Enough to score.
- Each rate needs enough cases in its own denominator (10 for the matrices, 30 for the headline); until then it shows "n=<count>, collecting".

Headline, the promise "Dry for the next 2+ hrs" (dry now, no rain forecast for 2 hours): 1880 calls scored; 159 saw radar rain within 2 hours (8%).

**Forecast one hour ahead, against radar one hour later**

| Forecast said | Radar saw rain | Radar saw no rain |
| --- | ---: | ---: |
| Rain | 94 | 64 |
| Dry | 177 | 1854 |

When we forecast rain: radar confirmed it 59% of the time, and did not 41%. Of the times radar saw rain, we had forecast dry 65%. Of our dry forecasts, 9% got rained on.

**Forecast two hours ahead, against radar two hours later**

| Forecast said | Radar saw rain | Radar saw no rain |
| --- | ---: | ---: |
| Rain | 100 | 112 |
| Dry | 166 | 1811 |

When we forecast rain: radar confirmed it 47% of the time, and did not 53%. Of the times radar saw rain, we had forecast dry 62%. Of our dry forecasts, 8% got rained on.

## Best time to go

Each morning the app names a best window for the beach. We take the window it named by 10 AM local time. Then we compare it with the hourly scores we archived for that day. Only a complete day counts: it must be over, have at least 8 scored daylight hours, have 80% of the daylight hours between its first and last archived hour, start within 2 hours of sunrise, and reach 5 PM local (or the last daylight hour). A day that fails this is censored: its archived hours cover only part of the day, so it has no honest best hour.

- Complete days: 154.
- Of those, with a window named by 10 AM: 154. Enough to score.
- Left out: 328 censored days (missing hours), 78 scored by two model versions (a deploy day), 39 still in progress, 0 with no early window. Outlook forecasts skipped across a model change: 235.

|  | Value |
| --- | ---: |
| Days scored | 154 |
| Average window length (hours) | 7.6 |
| Local hour the window was named (average) | 6.3 |
| Average archived score inside our window | 59.8 |
| Average of the best 3 archived hours in a row | 66.8 |
| Gap (points we left on the table) | 7.0 |
| Days the best hour fell inside our window | 82% |
| Days our window score was within 10 points of the archived average inside it | 76% |
| Window score minus archived average inside it (pts) | +7.7 |

The window score is the window's peak hour, so it runs a little above the window's average by design.

### Days ahead

The peak score we promised some days ahead, against the best archived hour of that day. Only complete days count. Bias is promised minus archived.

| Days ahead | Days scored | Typical miss (pts) | Bias (pts) |
| --- | ---: | ---: | ---: |
| 1 | 77 | 7.0 | +0.8 |

## Safety message and lifeguard flags

We compare our swim message (safe, caution, stay out) with the lifeguard flag that was flying. The City posts one flag a beach a day, so we count beach-days, not hours. A beach-day's flag is its most common flag. Our message is its most common swim level; a tie goes to the more serious one. Only beaches with a posted flag count.

- Beach-days with a swim message and a known flag: 21 (from 176 hourly rows). Status: collecting — 21 of 30 beach-days.

### Swim message by flag (beach-days)

| Flag | Safe | Caution | Stay out |
| --- | ---: | ---: | ---: |
| yellow | 1 | 7 | 0 |
| green | 12 | 1 | 0 |

A red or double-red flag sets "stay out" directly (lib/safetyLine.ts). Those rows say nothing about our own judgement. The next section leaves them out.

### Green and yellow flags only

- Beach-days: 21 (8 yellow, 13 green). Status: collecting — 21 of 30 beach-days.
- Agreement (yellow with caution or stay out, or green with safe): 19 of 21; rate n=21, collecting.
- Yellow flag, but we said safe: 1.
- Green flag, but we said caution or stay out: 1.

Why we cautioned under a green flag:

- moderate rip risk: 1 beach-day

## Data health

- Beaches with rows in the last 7 days: 39.
- Extra data (the prediction blocks) is on 52% of rows in this report's window, 100% of the last 24 hours, and 100% of rows since the first one (2026-10-06 15Z).
- Share of the last 24 hours' extra rows with each block: window 90.9%, rain 100%, flags 100%, outlook 100%, safety 100%, rip 100%.
- Local hours missing on beaches that should archive all 24 (3 beaches, 18 beach-days): 0 (72.2% present), 1 (72.2% present), 2 (72.2% present), 3 (72.2% present), 4 (72.2% present), 5 (72.2% present), 6 (72.2% present), 22 (66.7% present), 23 (66.7% present). "Best time to go" cannot score these hours, and sunset forecasts close to the event are missing.
- Beaches under 12 rows a day (finished days, last 7 days), worst first. Auto-tier beaches archive daylight hours only, so their full count is the Expected column:

| Beach | Tier | Rows per day | Expected | Fewest in a day | Days counted |
| --- | ---: | ---: | ---: | ---: | ---: |
| old-orchard-beach | auto | 11.7 | 12 | 10 | 6 |
| south-padre-island | auto | 11.7 | 12 | 10 | 6 |
| naples | auto | 11.8 | 12 | 11 | 6 |
| rehoboth-beach | auto | 11.7 | 11 | 10 | 6 |
| tybee-island | auto | 11.7 | 11 | 10 | 6 |
| virginia-beach | auto | 11.7 | 11 | 10 | 6 |
| wrightsville-beach | auto | 11.7 | 11 | 10 | 6 |
| myrtle-beach | auto | 11.8 | 11 | 11 | 6 |
| nags-head | auto | 11.8 | 11 | 11 | 6 |
| ocean-shores | auto | 11.8 | 11 | 11 | 6 |

  And 3 more (11.8 to 11.8 rows a day).

- Latest camera capture per beach (oldest first): fort-lauderdale 1.2 h ago, boca-raton 1 h ago, deerfield-beach 0.8 h ago.
- Sun camera readings: 1; latest event 2026-10-06T11:15:11.868Z, scored 2026-10-06T15:35:12.641Z.
- Sun-color forecast rows in the last 24 hours: 1008.

---

Made by `npx vite-node -c vitest.config.ts scripts/scorecard.ts`. Read-only: it never writes to the database.
