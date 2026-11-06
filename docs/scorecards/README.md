# Prediction scorecard

The scorecard compares what the app predicted with what happened. It covers
five systems. It is the "score" step of the loop: predict, measure, score,
recalibrate.

A report goes here as `YYYY-MM-DD.md`. The newest copy is always `latest.md`.

## Run it

Run it from the repo root:

```
npx vite-node -c vitest.config.ts scripts/scorecard.ts
```

The run takes about 15 seconds. It reads production D1 with
`wrangler d1 execute isitbeachday-plus --remote`. Wrangler must be logged in.
The script runs only `SELECT` statements. It never writes to the database.

| Flag | Meaning |
| --- | --- |
| `--days N` | Days of hourly rows to score. Default 14. |
| `--out DIR` | Where to write the report. Default `docs/scorecards`. |
| `--json` | Also print the computed metrics as JSON after the Markdown. |
| `--from-json FILE` | Score saved query results. Do not query D1. |
| `--save-raw FILE` | Save the query results, for `--from-json`. |

The Markdown also goes to stdout. Progress messages go to stderr.

If a query fails, the run goes on.

- A dataset that fails completely makes its sections say
  `Not available — <first line of the error>`.
- The hourly rows load in chunks of 3 days. If only some chunks fail, the
  report still scores the rows it has. It adds a warning at the top
  (`Warning: Some hourly rows are missing. <error>`). The metrics are partial,
  not "Not available". Read them with that in mind.
- If both the hourly rows and the sun-color forecasts fail, the run exits with
  code 1 and leaves `latest.md` alone, so a bad run never replaces the last
  good report.

## The minimums

A system with too little data shows its counts and the words
`collecting — N of M ...`. It shows no error numbers. This is on purpose.
A first-week report must not look like a verdict.

| System | Unit that counts | Minimum |
| --- | --- | --- |
| Sunrise and sunset color | Pairs (events) | 10 |
| Rain forecast | Scored calls | 50 |
| Best time to go | Days | 10 |
| Safety message and flags | Beach-days with a known flag | 30 |

The sun section has more gates of its own:

| Sun number | Unit that counts | Minimum |
| --- | --- | --- |
| Any number for one model version | Pairs with a forecast 30–120 min out | 10 |
| Rank correlation for one cam | That cam's pairs | 8 |
| A cam's own scale (top 25% and top 10%) | Events that cam is the truth for | 8 |
| Top-tier hit rate | Calls at the cutoff | 10 |
| One afterglow correlation | Matched afterglow readings for that cam | 8 |

Sun color counts events, not forecast rows. One sunrise at one beach has
dozens of hourly forecast rows. They all share one camera reading. So they
are one pair. Each group in a table (one lead time, one beach) needs 10
events of its own.

Safety counts beach-days, not hours. The City posts one flag per beach per
day. So 24 hourly rows are one observation.

Every published rate also needs enough cases in its own denominator. Below
that it shows `n=<count>, collecting`. The gates are:

| Rate | Its own denominator | Minimum |
| --- | --- | --- |
| Sun call hit rate and false-alarm rate | Calls at the cutoff | 10 |
| Sun call miss rate | Events that reached the cutoff | 10 |
| Rain hit rate and false-alarm rate | Rain forecasts | 10 |
| Rain miss rate | Times radar saw rain | 10 |
| Rain "dry calls rained on" and the headline | Dry forecasts, or "Dry for 2+ hrs" calls | 30 |
| Safety agreement rate | Green and yellow beach-days | 30 |

## What each section means

### Sunrise and sunset color

The model forecasts the color of each sunrise and sunset every hour. A beach
camera later scores what the sky really did (0 to 100). A pair is one event
that has both.

- **Typical miss.** The average size of the error, in points.
- **Bias.** Forecast minus camera. A plus means the model runs high.
- **Lead.** How long before the event the forecast was made. "After the event"
  is the golden window just after the event.
- **We said.** The forecast band. Poor is under 20. Fair is 20 to 44. Good is
  45 to 69. Great is 70 to 89. Amazing is 90 and up.
- **Camera view.** `solar` cams look at the sun. `antisolar` cams look away
  and see only the afterglow. The report calls these afterglow readings. They
  are never the truth for an event's color and never enter an error number.
- **Our call.** The last forecast made at least 60 minutes before the event.
  This table grades "it happened" on the raw camera score (70 or more), so
  it is raw-scale. See "Raw scale and the fair grade" below.
  - Hit rate: of our Great (or Amazing) calls, the share that happened.
  - False-alarm rate: of our calls, the share that did not happen.
  - Miss rate: of the real Great (or Amazing) events, the share we did not call.
  - Each rate shows `n=<count>, collecting` until its own denominator reaches 10.
- **Lead buckets.** Half-open. `0–2h` is 0 up to 120 minutes. `12–24h` is 720
  up to 1,440 minutes. `24h+` starts at exactly 1,440 minutes.
- **Window.** Pairs and calls use events from the last 90 days. The report
  also shows lifetime counts (all events, forecast rows, camera readings). If
  the row cap is reached, the oldest events in the window are the ones dropped.
- **How often we say Great or Amazing.** The model aims for about 20% Great or
  better and about 10% Amazing. The table shows that target next to our
  forecasts and the camera readings. Events that have not happened yet are
  left out.

#### Raw scale and the fair grade

Each cam has its own raw scale. On the same Anna Maria sunsets Holmes Beach
averages 74 and White Sands 5. A thin sky strip near the horizon scores the
warm band of a clear sky at 70 to 97
(`docs/benchmarks/2026-11-05-sun-recalibration/REPORT.md`). So a raw score of
70 on the camera does not mean the same sky on every cam. The tables marked
"raw camera scale" are a rough guide only. The fair grade is the main grade.

- **The forecast people see.** The sun card opens 60 minutes before the event.
  So the headline uses, for each event, the scored forecast row closest to 60
  minutes before it, with a lead from 30 to 120 minutes (both ends count). A
  tie goes to the shorter lead. An event with no such row is not graded. It
  counts in the coverage table instead.
- **One truth cam per event.** The server already picked it when it filled the
  forecast rows: a cam that looks at the sun, the smallest `distance_mi`, then
  `cam_id` (`docs/SUN_CAM_CHECK.md`, "Filling the predictions"). The report
  reads the cam from `observed_source` (`sun-cam:<cam_id>:solar`). A row
  labeled by hand, or from an afterglow cam, has no truth cam here.
- **By model version.** Every headline number is split by `algo_version`,
  newest first. The event's version is the version of its 30–120 min row. The
  version live in the app (`SUN_QUALITY_VERSION`) is always listed, even with
  no rows, so a new model shows "collecting — 0 of 10 pairs" and its counts
  while it fills in.
- **Rank correlation.** Spearman (Pearson on average ranks, ties shared)
  between our forecast and the cam's score, inside one cam and one event
  kind. +1 means our order matched the cam's order exactly. 0 means no skill.
  A cam needs 8 pairs. The pooled number is the average of the cam numbers,
  weighted by each cam's pairs. Cams under 8 pairs are left out of it. A cam
  whose forecasts or scores never changed shows "no spread". Boca Raton and
  Deerfield Beach share the Deerfield cams, so those cams count both beaches.
- **Top tier.** Each cam's scale is the mid-rank percentile of every event it is
  the truth for (all versions, same event kind). A real Great is in the cam's
  top 25% (percentile 0.75 or more). A real Amazing is in its top 10% (0.90 or
  more). Our Great call is still a forecast of 70 or more, and Amazing 90 or
  more. Chance alone puts 25% of Great calls in the top 25%. A cam with fewer
  than 8 events has no scale yet, and its events are left out of these counts.
- **Coverage.** Per event kind: past events loaded, and how many have a
  forecast 30–120 min before them. The same for events with a camera reading.

#### Afterglow

An east-facing cam looks away from the sun at sunset. It sees the afterglow
on the clouds over the ocean. On an east-coast beach that is what a
beachgoer sees at sunset. A west-facing Gulf cam sees the same kind of
afterglow, over the Gulf, at sunrise. The facing comes from
`config/sun-cams.json` (`facing`, else `facing_azimuth_deg` below 180 is east).

- These readings come from `sun_event_observations` with view `antisolar`. A
  reading belongs to a forecast event on the same beach and kind within 15
  minutes.
- Per cam, the report gives the Spearman between the afterglow and (a) our
  forecast 30–120 min out, (b) our call (latest forecast 60+ min out), each
  per model version, and (c) the satellite's mid and high cloud along the
  path away from the sun (`breakdown_json.satellite.antiMidHighPct`, from
  the row closest to the event that has one). The satellite is read only
  within 60 minutes of the event. Each correlation needs 8 events.
- This is evidence for a future afterglow forecast. It is not a grade, and it
  never enters the solar numbers.

#### What to fix next

A short list at the end of the sun section. Fixed rules make it from the
computed numbers. It adds no other text.

- The live model version has under 10 pairs: it is still collecting.
- A forecast band (Poor to Amazing) on the 30–120 min forecast has a raw bias
  beyond ±15 points, on 10 or more events.
- A version's pooled fair rank correlation is 0 or below.
- A cam's rank correlation is −0.3 or below (8+ pairs, version at its minimum).
- A version's Great calls land in the cam's top 25% less than 25% of the time
  (10+ calls).
- Fewer than 50% of past sunrises (or sunsets) have a forecast 30–120 min out.
- An afterglow correlation with the satellite cloud is ±0.3 or more, on 8+
  events.

If no rule trips, the list says so.

### Rain forecast

The app says "dry" or "raining" from the Open-Meteo nowcast. The scorecard
checks that call against the MRMS radar reading one and two hours later.

- The forecast is graded at two horizons, +1 h and +2 h. The nowcast gives a
  state now (dry or raining) and a note on when it changes (`changeInMin`).
  The forecast state at a horizon follows from both:
  - "Dry, rain in 25 min" is a rain forecast at +1 h and at +2 h.
  - "Raining, easing in 25 min" is a dry forecast at +1 h and at +2 h.
  - A change at or before the horizon has happened by then. `changeInMin` is
    the start of the first changed 15-minute bucket, so a change at exactly
    60 minutes applies at +1 h, and at exactly 120 minutes at +2 h.
  - A row with no `changeInMin` is a call but is not scored.
- `beach_hourly.rain_now` is not truth. The archiver builds it from the
  nowcast itself plus the weather code. The `rain` block in `extra_json` holds
  the radar reading, which is truth.
- A call is scored when the same beach has a radar reading at +1 h and at
  +2 h.
- Radar rain means a rate above 0 mm/hr, or a fresh frame that saw rain at or
  near the beach in the last 20 minutes. The freshness check comes first: a
  radar frame older than 25 minutes is unknown, whatever else it says. A beach
  the radar cannot see is not used.
- The headline is the user-facing promise "Dry for the next 2+ hrs": the
  nowcast says dry and expects no change for 2 hours or more (`changeInMin`
  empty, or 120 or more). The report asks how many of those got radar rain at
  +1 h or +2 h. A `dry` call that says "rain in 25 min" is not part of it. The
  headline needs 30 such calls.
- Archive rows are hourly snapshots. Rain that starts and stops between two
  snapshots is not seen. The scorecard can undercount rain, never overcount it.

### Best time to go

Each morning the app names a best window. The scorecard takes the window
named at the earliest archive hour at or before 10 AM local. It compares that
window with the hourly scores the day really had.

- Only complete days count. A day is complete when all of these hold:
  - It is finished: a later day exists in the archive for the same beach.
  - It has 8 or more scored daylight hours.
  - At least 80% of the daylight hours between its first and last archived
    hour are present.
  - Its first archived hour is within 2 hours of sunrise.
  - Its last archived hour reaches 5 PM local (or the last daylight hour, if
    sunset comes sooner).
- A finished day that fails the rule is censored. Its archived hours cover
  only part of the day, so it has no honest best hour. The report counts
  censored days and leaves them out of both the window check and "Days ahead".
  The archive loses most afternoons (see "Limits"), so many days are censored.
- Only daylight hours count.
- **Gap.** The average best 3 hours in a row, minus the average inside our
  window.
- **Best hour inside the window.** The share of days the highest-scoring hour
  fell inside the window.
- **Within 10 points.** The share of days the window's score was within 10
  points of the day's real average inside it. The window score is the peak
  hour of the window, so it runs a little above the average by design.
- **Days ahead.** The peak score the app promised 1 to 6 days ahead, against
  the best archived hour of that day. The promise comes from the `outlook`
  block. Only complete days count as the target.

### Safety message and lifeguard flags

The scorecard sets our swim message (safe, caution, stay out) beside the
lifeguard flag.

- The unit is the beach-day. A beach-day's flag is its most common flag. Our
  message is its most common swim level. A tie goes to the more serious one.
  The report uses daylight hours only, so a quiet night does not outvote the
  beach day.
- A red or double-red flag sets "stay out" directly (`lib/safetyLine.ts`).
  That is circular. So the report also shows the green and yellow days alone.
- Agreement means yellow with caution or stay out, or green with safe.
- When a green flag flew and we said caution or stay out, the report lists
  our reason, one per beach-day. It reads the archived `rip` block. "Other"
  means waves, thunder, or an advisory.

### Data health

- Rows per day for each beach, over finished days in the last 7 days. Curated
  beaches should have 24. Auto-tier beaches archive daylight hours only, so a
  full day for them is their daylight hours (about 11 or 12 in October). The
  list shows beaches under 12 rows a day, with the expected count beside each.
- The local hours that go missing on beaches meant to archive all 24 hours.
- How many rows carry `extra_json`, and how many carry each block.
- The latest camera capture for each beach.
- The number of sun-camera readings, and sun-color forecast rows in the last
  24 hours.

## Limits to remember

- `extra_json` began on 2026-10-06 at 15:00 UTC. The `rain`, `flags` and
  `outlook` blocks begin when the code that writes them is deployed. Before
  that, their sections say `collecting`.
- The archiver stops for the day at its build budget (600 builds per UTC
  day, `HISTORY_MAX_BUILDS_PER_DAY`). The budget ends in the evening. Late
  afternoon local hours are missing most days. So those days are censored in
  "Best time to go", and sunset forecasts made close to the event are rare.
  Data health shows the missing hours.
- Hourly rows are read for `--days` days. Sun-color events and camera readings
  are read for the last 90 days. Lifetime sun counts are shown apart.
- The sun forecasts are read in three sets: every row with a camera reading,
  each event's call, and every scored row made from 60 min after to 120 min
  before an event. So the coverage and the afterglow checks see events with
  no camera reading too.

## Files

- `scripts/scorecard.ts` — the runner. It queries D1 and writes the report.
- `lib/scorecard/metrics.ts` — the maths. Pure functions. Unit-tested.
- `lib/scorecard/report.ts` — turns the metrics into Markdown.
- `lib/scorecard/queries.ts` — the SQL the runner sends. Read-only `SELECT`s.
- `lib/scorecard/wrangler.ts` — reads wrangler's JSON output.
- `lib/history/extra.ts` — writes the `rain`, `flags` and `outlook` blocks.

## Model changes

Read each week's numbers against these dates. Archived rows carry `engine_version`, so a before/after split is possible.

- **2026-10-06 — scoring 2026-10-06.1:** comfort (dew point) curve retuned for the shore: free up to 65°F, −2.5 points per °F above (was free to 60°F, −5 per °F). Expected effect from history: average daytime score +1.9, Excellent hours roughly doubled.
- **2026-10-06 — sun color 2026-10-06.2:** satellite overhead cloud no longer scored as a horizon blocker; canvas plateau 35–80; humidity only without an aerosol reading.
- **2026-10-15 — sun color 2026-10-15.1:** the cloud mix and the horizon come from the GOES cloud-top-height read when its scan is at most 35 min old and the event at most 60 min away; the forecast is the fallback. Curves, weights and band cutoffs are unchanged. Rows carry `breakdown_json.source` (`satellite-ir` or `forecast`).
- **2026-11-05 — sun color 2026-11-05.1:** recalibrated on the sun cams: canvas × overcast × path; clear sky 62 (was ~29), a solid deck ~20-30 (a 100% high deck was 98); seasonal prior no longer scored. docs/benchmarks/2026-11-05-sun-recalibration.
