# How far ahead can we forecast sunrise and sunset color? (2026-11-11)

The owner asked three things. Open the forecast earlier than 60 minutes, with a
target of 2 hours. Use all the camera data to tune the model. Find how far
ahead the forecast is reliable.

## The short answer

1. **Yes, open at 2 hours, as an "early look" that firms up at 1 hour.** This
   branch does that. Two hours out, the app averages two scores: one from the
   satellite's view of the sky now, one from the hourly forecast. On 243
   camera-graded events that average sorts good skies from dull ones as well as
   today's one-hour score does (0.32 against 0.31, where 0 is no skill and 1 is
   perfect).
2. **It is honest to call it "early".** About 1 in 4 early looks moves to
   another band by the one-hour mark. For sunrises alone the early look is
   weaker than the one-hour score (0.26 against 0.45).
3. **Skill is modest at every lead.** The best number in this study is about
   0.3 to 0.45. The model can tell a dull sky from the rest. It cannot pick out
   the great ones: its 34 "Great" calls landed in the camera's best quarter 29%
   of the time, and chance is 25%.
4. **Beyond 2 hours, only a coarse signal is left.** From 3 to 24 hours ahead
   the forecast still beats chance when all cams are pooled (about 0.2 to 0.3).
   That is enough for words such as "clear sky expected" or "heavy cloud
   expected". It is not enough for a 0–100 number. This branch does not show
   anything past 2 hours.
5. **Tuning: one change is supported, and it is not shipped here.** The cams
   do not back the "sweet spot" (extra points for 20–70% mid or high cloud). A
   model without it ranks skies better out of sample (0.39 against 0.28). But
   without it the app can never say Great or Amazing. That is a product
   decision for the owner. Nothing else beat the shipped model by more than
   noise.

## Skill by lead

The grade is the scorecard's fair grade: rank correlation inside each camera,
averaged over cameras. Brackets are 90% intervals from a bootstrap by day. An
interval that reaches 0 means the skill cannot be told from zero.

**Table 1. What the app can show at each lead (243 events, 10 cams, 31 days).**
Inputs are rebuilt for every event, so sunrises and sunsets are both covered.

| Lead | Input | All | Sunrises (86) | Sunsets (157) |
|---|---|---|---|---|
| 5 min | satellite | 0.28 [0.12, 0.44] | 0.40 [0.19, 0.57] | 0.22 [0.00, 0.42] |
| 60 min (old opening) | satellite | 0.31 [0.16, 0.44] | 0.45 [0.27, 0.61] | 0.23 [0.02, 0.42] |
| 90 min | satellite | 0.29 [0.10, 0.46] | 0.39 [0.19, 0.56] | 0.23 [−0.02, 0.46] |
| 120 min | satellite alone | 0.19 [0.01, 0.36] | 0.31 [0.09, 0.50] | 0.13 [−0.10, 0.35] |
| 120 min | hourly forecast alone | 0.25 [0.10, 0.38] | 0.20 [−0.04, 0.41] | 0.28 [0.07, 0.46] |
| **120 min (new opening)** | **early look: mean of the two** | **0.32 [0.18, 0.45]** | 0.26 [0.03, 0.45] | 0.36 [0.14, 0.54] |
| 180 min | satellite alone | 0.19 [0.03, 0.34] | 0.27 [0.07, 0.46] | 0.15 [−0.06, 0.35] |
| 11–17 h | hourly forecast alone (older run) | 0.32 [0.19, 0.43] | 0.25 [0.07, 0.41] | 0.37 [0.21, 0.50] |

**Table 2. What the app stored, by lead (every archived row, re-scored with
today's model).** The archive has almost no sunset row inside 6 hours (the
archiver's daily budget ran out before sunset until 2026-11-05), so the short
leads are sunrises only.

| Lead | Events | Cams | Days | Skill | Source | Note |
|---|---|---|---|---|---|---|
| 0–30 min | 74 | 3 | 30 | 0.39 [0.15, 0.59] | satellite | sunrises only |
| 30–60 min | 9 | 1 | 11 | 0.18 [−0.51, 0.80] | satellite | too few to read |
| 60–90 min | 79 | 3 | 30 | 0.10 [−0.12, 0.35] | forecast | sunrises only; not above zero |
| 90–120 min | 11 rows | 0 | 9 | no number | forecast | no cam has 8 events |
| 2–3 h | 85 | 3 | 30 | 0.17 [−0.03, 0.36] | forecast | sunrises only; not above zero |
| 3–6 h | 85 | 3 | 30 | 0.13 [−0.07, 0.32] | forecast | sunrises only; not above zero |
| 6–12 h | 235 | 10 | 30 | 0.27 [0.11, 0.41] | forecast | sunrise 0.26 [0.06, 0.43]; sunset 0.27 [0.08, 0.45] |
| 12–24 h | 235 | 10 | 30 | 0.20 [0.07, 0.33] | forecast | sunrise 0.07 [−0.12, 0.27]; sunset 0.28 [0.09, 0.44] |
| over 24 h | 0 | | | no rows | | the archive keeps one sunrise and one sunset per beach, the next ones |

What the two tables say together:

- **The satellite is the better input, and it holds for 90 minutes.** Its skill
  is flat from 5 to 90 minutes out. At 120 minutes it is lower by 0.12
  [−0.21, −0.01]. The sky at T−2 h is not yet the sky at the event.
- **The hourly forecast has a small, steady skill that does not depend on the
  lead.** It is about the same 2 hours out as 17 hours out. So waiting does not
  make the forecast better; only the satellite does.
- **On the same 74 sunrises**, the satellite row (0–30 min) beats the forecast
  row made 60–90 minutes out by 0.27 [0.05, 0.49].
- **Where skill cannot be told from zero:** stored sunrise forecasts from 60
  minutes to 6 hours, sunrise forecasts 12–24 hours out, the satellite alone
  for sunsets at 2 and 3 hours, and the forecast alone for sunrises at 2 hours.
  The satellite for sunsets is at the edge of zero even at 5 and 90 minutes
  ([0.00, 0.42] and [−0.02, 0.46]).

## Can a 2-hour forecast use the satellite?

**What is stored cannot answer it.** The `cloud-data` branch is a single
commit that is replaced on every read, so it keeps no history. A stored row
carries a satellite read only inside 60 minutes. So this study rebuilt the
satellite read for all 274 graded events at five scan ages, from NOAA's public
archive, with the feed's own code (`scripts/backfill_ir.py`).

Three candidates for the 2-hour number, on the same 243 events:

| Candidate | Skill | Against the old 60-min score |
|---|---|---|
| (i) hourly forecast only | 0.25 [0.10, 0.38] | −0.06 [−0.18, +0.09] |
| (ii) satellite carried forward from T−2 h | 0.19 [0.01, 0.36] | −0.12 [−0.21, −0.01] |
| (iii) mean of the two scores | 0.32 [0.18, 0.45] | +0.01 [−0.09, +0.13] |

- The mean beats the forecast alone by 0.07 [0.00, 0.13] and the satellite
  alone by 0.13 [0.01, 0.26].
- The weight is a plain half. It was not fitted. A sweep (0, ¼, ½, ¾, 1 on
  the satellite) gives 0.25, 0.28, 0.32, 0.25, 0.19, so the half is also the
  best, but that sweep is in-sample.
- Averaging the two cloud readings and scoring once is worse (0.24). Clear
  plus overcast averages to "partial cloud", which the model rates highest.
- By kind the picture is uneven. Sunsets: the mean (0.36) is at least as good
  as the 60-minute satellite score (0.23). Sunrises: it is weaker (0.26 against
  0.45; difference −0.20 [−0.38, 0.00]). Two hours before sunrise is deep
  night and the sky still changes.
- Two checks give the same order. With every solar cam as its own truth (393
  readings, 16 cams): 0.28 for the early look, 0.29 for the 60-minute score,
  0.22 for the satellite alone at 2 hours. With the "no sweet spot" model of
  the tuning section: 0.37, 0.42 and 0.36.

## How much the number moves

A forecast that flips bands is a bad experience even when its rank skill is
fine. Share of events whose score changes band, and whose score moves 15
points or more:

| From → to | Events | Median move | Band changes | Moves ≥ 15 pts | Jumps 2+ bands |
|---|---|---|---|---|---|
| Old opening (60 min) → 5 min | 274 | 1 | 22% | 11% | 2% |
| **Early look (120 min) → 60 min** | 274 | 3 | **26%** | 22% | 3% |
| Early look (120 min) → 5 min | 274 | 4 | 32% | 20% | 3% |
| Satellite alone (120 min) → 60 min | 274 | 1 | 22% | 16% | 6% |
| Forecast alone (120 min) → 60 min | 274 | 4 | 34% | 31% | 8% |

In the app's own archive (all beaches, re-scored), the forecast row barely
moves from 2–3 h to 60–90 min (median 0, 12% band changes, 681 events): the
hourly forecast is the same forecast an hour later. The move comes when the
satellite takes over (30% band changes from 60–90 min to 0–30 min, 511 events).
The early look softens that jump by letting the satellite in sooner.

## What the tuning found

Input: the satellite read 20 minutes before the event, the same input the
2026-11-05 recalibration used. 244 events, 11 cams, 31 days (243 on the 10
cams with 8 events or more). The search is a full grid, so the shipped values
get no head start. Every candidate is graded two ways out of sample: fitted on
the first 16 days (to 10-27) and graded on the last 15; and leave one day out.

**The shipped model**: 0.28 [0.12, 0.44] on all days. First half 0.25, second
half 0.31. Sunrises 0.40 [0.20, 0.56], sunsets 0.22 [0.00, 0.42]. On the six
days after it shipped (47 events, too few for the per-cam grade) a pooled rank
gives 0.15 [−0.04, 0.39]: no clean confirmation yet.

| Candidate | Free numbers | In sample | Later days (fit on earlier days) | Leave one day out | Verdict |
|---|---|---|---|---|---|
| Shipped | 0 | 0.28 | 0.31 | 0.28 | |
| **No sweet spot** (clear = partial cloud) | 0 | 0.39 | 0.50; +0.19 [0.04, 0.37] over shipped | same as in sample; +0.11 [0.01, 0.21] | beats shipped |
| Clear-sky value only | 1 | 0.42 (value 92, above the 86 peak) | 0.51; +0.20 [0.03, 0.41] | 0.42; +0.14 [0.02, 0.26]; same fit on all 31 folds | beats shipped |
| Path cost only | 1 | 0.32 (floor 0.25) | 0.31; +0.00 [−0.03, 0.04] | 0.32; +0.04 [0.00, 0.09] | noise |
| Overcast fade only | 2 | 0.28 (the shipped values) | 0.30; −0.01 [−0.05, 0.01] | 0.26; −0.02 [−0.04, 0.00] | keep |
| All five numbers | 5 | 0.43 | 0.44; +0.13 [−0.01, 0.28] | 0.36; +0.08 [−0.06, 0.22] | overfits: 8 different fits in 31 folds |

The four questions:

1. **Is the 20–70% sweet spot supported? No. Clear ≥ partial still holds, more
   clearly than before.** On each cam's own scale (0 = its dullest sky, 1 = its
   best), clear skies average 0.62 (110 events, 25 days). Skies in the sweet
   spot average 0.29 (7 events, 4 days, all sunsets): −0.33 [−0.46, −0.23].
   Any partial mid or high cloud against clear: −0.19 [−0.28, −0.08]. The model
   rates those 7 events 87 on average. The "no sweet spot" model has no fitted
   number, so its grade is out of sample on any days: better on 8 of 10 cams,
   +0.11 [0.01, 0.21] overall, almost all from sunsets (+0.17 [0.04, 0.31];
   sunrises +0.01).
2. **Should sunrise and sunset, or the two coasts, differ? Not shown.** A fit
   on sunrises alone does worse out of sample than the shipped model (−0.20
   [−0.40, −0.01]). A fit on sunsets alone does better (+0.18 [0.01, 0.34]),
   but it finds the same thing as point 1 (no sweet spot), and the pooled fit
   is as good. Every sunrise cam is on the Atlantic and every sunset cam on the
   Gulf or the Keys, so kind and coast cannot be told apart in this data.
3. **Does low cloud in the sun's path matter more than the −25% cap? Maybe,
   not proven.** The cams do rank a blocked path lower: 0.52 under 20% low
   cloud in the path, 0.46 at 20–50%, 0.37 at 50–90% (13 events). A larger
   cost gains 0.04 in sample and nothing on the later days. No event had 90% or
   more. Keep 25%.
4. **Is the forecast-only total-cloud floor right? It does not matter.** In the
   488 rebuilt forecasts the total was never below its largest layer. In 4,238
   stored forecast rows it was 26 times, and 14 scores would change. The
   stronger floor that was dropped on 2026-11-05 (the screen blend) would
   change 227 stored scores and grades no better (0.00 and −0.01). Keep the
   rule.

**Why the sweet-spot change is proposed and not shipped.**

- It passes the bar set for this study (it beats the shipped model out of
  sample by more than noise), with zero or one free number.
- But the camera truth has a known lean in the same direction. A cam scores
  the share of warm pixels, and a clear sky gives a full warm band at the
  horizon (2026-11-05 report, section 3). A dramatic sky with lit cloud streaks
  can score lower than a plain clear one. So "clear ≥ partial" may be partly
  the scorer, not the sky.
- The strict sweet spot rests on 7 events on 4 days.
- Without the sweet spot the top score is about 65. On these 244 events the
  bands go from 2 Amazing, 32 Great, 155 Good, 55 Fair to 0, 0, 176 Good,
  56 Fair, 12 Poor. The app could never say "Great". The shipped model's 34
  Great and Amazing calls averaged the 51st percentile on their cam, and 10 of
  34 (29%) were in its best quarter. So the calls carry no information today,
  but removing them changes what the product promises.
- The exact change, if the owner wants it: in `lib/sunQuality.ts` make
  `SUN_CANVAS_CURVE` flat at 62 from 0% to 70% (then down to 43 at 100%), bump
  `SUN_QUALITY_VERSION`, and rewrite the card copy that names the sweet spot.
  A way to settle it first: have a person rate 40 to 50 saved sunset frames
  (clear against partial cloud) without seeing the scores.

## What changed on this branch

The forecast opens 120 minutes before the event as an early look and firms up
at 60 minutes. `SUN_QUALITY_VERSION` is 2026-11-11.1 because the score shown
from 120 to 60 minutes is new. No curve, weight or cutoff changed.

- `lib/sunForecastWindow.ts`: opens at 120 (`SUN_FORECAST_WINDOW_MINUTES`),
  firm at 60 (`SUN_FORECAST_FIRM_MINUTES`). The window now says `early` and
  `firmAtIso`. New copy: "Early look. Firms up at 5:52 PM".
- `lib/sunAlert.ts`: from 120 to 60 minutes, a fresh satellite read and the
  hourly forecast are each scored and averaged (source `satellite+forecast`;
  both halves are stored in `breakdown_json.early`). With no fresh satellite
  read the forecast stands alone, as before. Inside 60 minutes nothing changed.
- `components/SunQualityCard.tsx`: the score shows from 2 hours out with the
  early-look line under it; the back explains it. Pending copy says "2 hours
  before sunset".
- `lib/shareCard.ts`: "Early: Good color · 58/100" during the early look; the
  card's cache ends at the firm mark.
- `lib/watchView.ts`, `lib/agent/openapi.ts`, `lib/watchViewCache.ts`: the
  payload field gains `early` and `firmAt`. It still never carries a score.
- `lib/alerts/sunColor.ts`: push alerts stay at the firm mark (60 minutes). An
  early look is never pushed. `SUN_ALERTS_ENABLED` is untouched and off.
- `lib/history/dayView.ts`: the Plus day view also waits for the firm mark.
- `lib/history/archive.ts`: the sun-hour build stays in the hour that holds
  event − 60 min. A build in that hour is 0–120 minutes ahead, so it is always
  inside the shown window; the hour that holds the 120-minute opening would
  put builds up to 180 minutes ahead, before anything is shown. Sun builds run
  first in the hour, so most rows land 60–120 minutes ahead: the early look.
  No extra builds, so the 600-a-day budget is unchanged.
- `lib/scorecard`: the headline window (30–120 minutes, closest to 60) is
  unchanged, so old and new versions are graded on the same leads. The report
  says that a 60–120 minute row is the early look from 2026-11-11.1.
- `scripts/goes_cloud.py`, `.github/workflows/goes-cloud.yml`: the feed starts
  150 minutes before sunrise (was 75), so a scan exists when a sunrise early
  look opens. The sun-path read reaches 180 minutes (was 120). About 5 more
  reads a day.
- `lib/changelog.ts`, `docs/architecture.md`, `docs/SUN_CAM_CHECK.md`,
  `docs/scorecards/README.md`.

## What to watch after it ships

- **The early look is graded from day one.** The sun-hour rows are the early
  look, and the scorecard's headline grades them. Expect a fair rank
  correlation near 0.3. About three weeks give every cam 8 events.
- **Sunrise early looks.** They rest on the feed change. Until the workflow
  runs with the new window, a sunrise early look falls back to the forecast
  alone for its first 45 minutes.
- **A coarse outlook past 2 hours** is the next thing the data can support.
  When a forecast 6–12 hours out scores under 45, the event lands at the 43rd
  percentile on its cam; when it scores 45 or more, at the 57th (difference
  0.14 [0.05, 0.23], 235 events). At 12–24 hours: 0.11 [0.03, 0.17]. That
  supports two or three words, not a number. To grade a real long-lead number
  we would need a stored row at fixed leads (3, 6, 12 hours) for sunsets, which
  the archive only started to get on 2026-11-05. Two months of those rows on 10
  cams would give about 500 events.
- **More sweet-spot days.** Only 27 of 244 events had 20–70% mid or high cloud
  at the event. Winter fronts should bring more.

## Method

- **Events.** Every sunrise and sunset that a camera facing the sun graded,
  2026-10-06 to 2026-11-11: 274 beach-events on 31 days. One truth cam per
  event, the server's pick (nearest, then cam id). A cam shared by two beaches
  counts once (`nearestBeachPerCamEvent`): 244 events on 11 cams, 86 sunrises
  and 158 sunsets. A cam needs 8 events to count, which leaves 243 on 10 cams.
- **Grade.** `lib/scorecard/metrics.ts`: Spearman rank correlation inside each
  cam, ties shared, averaged by each cam's events. Each cam has its own scale,
  so nothing is compared across cams.
- **Model.** Every input is scored with today's `sunEventQuality`. The live
  model returns the stored score for all 808 rows of version 2026-11-05.1.
- **Intervals.** Whole days are drawn with replacement, 2,000 times (1,000 in
  the tuning tables); the interval is the 5th to 95th percentile. All events on
  one day share a sky, so the real sample is days (31), not events.
- **Rebuilt satellite reads.** For each event, the newest GOES-19 scan that
  started at least 20, 75, 105, 135 or 195 minutes before it. The app sees a
  scan 5 to 30 minutes after it starts, so those stand for 5, 60, 90, 120 and
  180 minutes of lead. 1,370 reads; 4 were dropped by the app's own quality
  rule.
- **Rebuilt forecasts.** The archive has a sunset forecast inside 6 hours for
  about 30 events. So the hourly forecast was rebuilt from Open-Meteo's
  single-run archive (the model family the app uses): the newest 6-hourly run
  that started at least 4.5 hours before the event (5 hours before, on the
  median), and the run 6 hours earlier. Check: on 113 sunrises that also have
  a stored 2–3 hour forecast row, the rebuilt score matches it (correlation
  0.76, mean difference 6 points, same band 84%).
- **Bands.** Poor under 20, Fair 20–44, Good 45–69, Great 70–89, Amazing 90+.

## Limits

- **Small sample.** 31 days in October and November, one season, Florida only.
  The 90% intervals are about ±0.15 wide. Several per-kind results sit at the
  edge of noise.
- **Many comparisons.** This report makes about forty. One in ten 90%
  intervals misses by chance. The three 2-hour candidates came from the task
  brief, and the "no sweet spot" model was named in the 2026-11-05 report as
  the open question; the blend weight and the sweet-spot edges were not
  searched.
- **The camera is not the eye.** It scores warm pixels in a fixed sky region.
  It leans toward clear skies, and thin-strip cams are weak truth. Twelve
  events before the lamp fix were re-scored.
- **The 2-hour forecast is a stand-in.** The rebuilt run is a little older
  than what the app holds 2 hours out (the hourly model runs land faster), so
  the real forecast half may be slightly better than graded here.
- **A rank grade cannot see scale.** It says whether higher scores go with
  better skies. It does not say whether "62" is the right number for a clear
  sky.

## Reproduce

```
B=docs/benchmarks/2026-11-11-sun-lead-time
# 1. Exports (read-only D1). The committed raw/*.json.gz are these files.
#    obs:   SELECT slug,event_kind,event_date_local,cam_id,event_iso,view,distance_mi,observed_score,warm_frac,
#           colorfulness,peak_frame_iso,score_version,scored_at FROM sun_event_observations
#           WHERE event_date_local >= '2026-10-01' ORDER BY event_iso, slug, cam_id
#    preds: every sun_event_predictions row WHERE observed_score IS NOT NULL, in date chunks
#    near:  every row WHERE lead_minutes BETWEEN 0 AND 200 AND event_iso >= '2026-10-15', in date chunks
#    (columns: see scripts/lib.ts PredRow, plus json_extract(breakdown_json,'$.source') AS source)
# 2. Rebuilt inputs (public NOAA and Open-Meteo archives; needs h5py + numpy)
python3 $B/scripts/backfill_ir.py . $B/raw 20,75,105,135,195   # optional 4th argument: shard i/n
python3 $B/scripts/fetch_runs.py . $B/raw
python3 $B/scripts/merge.py $B                                # -> ir_backfill.json, om_runs.json
# 3. Analysis (reads only the committed files)
npx vite-node -c vitest.config.ts $B/scripts/lead_skill.ts     # -> eval.json "lead", dataset.csv, predictions.csv
npx vite-node -c vitest.config.ts $B/scripts/tune.ts           # -> eval.json "tune"
```

Files: `eval.json` (every number in this report), `dataset.csv` (one row per
graded event with every rebuilt input and score), `predictions.csv` (every
stored row with its re-score), `ir_backfill.json` and `om_runs.json` (the
rebuilt inputs), `raw/` (the D1 exports), `scripts/`.
