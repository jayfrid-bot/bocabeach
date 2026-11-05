# Sunrise/sunset forecast recalibration (2026-11-05)

Trigger: the owner, 2026-11-05: "the sunrise predictions say it's amazing, but
it's really not." The archive agreed. For Boca sunrises from 10/15 to 11/05 the
last forecast before the event had a correlation of −0.43 with the sun cams.

Result: `SUN_QUALITY_VERSION` 2026-11-05.1. On 148 events the correlation goes
from −0.51 to +0.49 and the mean error from 45 to 21 points. The new rules are
in `lib/sunQuality.ts`.

## 1. What was wrong

The old score was `0.85 × canvas × clearPath / 100 + 0.15 × 55`, times air.

- **A solid high deck scored 98.** The canvas took `0.5 × mid + 0.7 × high`.
  A 100% high deck gives 70, inside the full-marks plateau (35–80). Only a
  solid MID deck had a penalty. The satellite read a clear path (0% low), so
  clearPath was 100. That gives 0.85 × 100 + 8.25 = 93.25, × 1.05 for clean
  air = **98 "Amazing"**. On the cams these skies were gray: 11/01, 11/03 and
  11/04 are in `frames/east-sunrises-solid-deck-vs-clear.jpg`.
- **A clear sky scored 29.** The canvas amount was 0, 35 below the plateau, so
  canvas = 100 − 35 × 2.2 = 23. That gives 0.85 × 23 + 8.25 = 27.8, × 1.05 =
  **29 "Fair"**. The cams rate clear skies well: the median clear-sky event is 76.
- **Low cloud in the sun's path was a near-total blocker.** At 90% it took the
  score down to the 8-point prior. The cams show a mean of 43 (median 57) for
  these events: lit low cloud often glows.

The old model was built on the idea that "any deck is a canvas". Against the
cams it was upside down: it ranked the worst skies highest.

## 2. The dataset

`dataset.csv`, one row per beach, event and cam (346 rows). The fit uses 148
beach-events: 44 sunrises (Deerfield Beach, Fort Lauderdale) and 104 sunsets
(6 Gulf and Keys beaches), 22 days from 2026-10-15 to 11-05. Boca Raton shares
the Deerfield cams, so it is kept out of the fit and scored on its own (4.2).

**Inputs: rebuilt from the satellite, not taken from the archive.** The live
archive has almost no sunset predictions near the event. The history archiver
has a budget of 600 builds a day, and it is spent by about 16:00 UTC every day
(`history_budget` = 600 on every day checked). So no beach is archived from
noon to 8 PM Eastern, and no west-coast sunset has a prediction inside 6 hours.
The inputs therefore come from the same GOES-19 cloud-top read the app uses,
taken from the last scan at least 20 minutes before each event
(`scripts/backfill_ir.py` calls `scripts/goes_cloud.py`'s own functions on the
NOAA archive; `ir_backfill.json`). Check: on the 75 sunrises that do have a live
satellite prediction, the rebuilt read matches it (correlation 0.97 low, 0.98
mid, 0.99 high, 0.96 low cloud along the sun's path; mean difference 2.5–3.7
points). Aerosol and humidity come from the latest archived row for that
event. The Python port of the old model reproduces all 671 archived
2026-10-15.1 scores exactly, and the TypeScript model reproduces the Python fit
on all 346 rows.

**Truth: the sun cams, solar view only, cleaned.** Every saved frame (about
7,500, from the home server's `~/Projects/bocabeach-sunframes`) was re-scored
with `scripts/sun_cam_check.py`'s own `score_image`. The re-score matches the
stored series (median difference 0.1). Then:

- Frames where the sky is still dark (median sky brightness under 0.30) in the
  outer part of the window (15+ minutes from the event) are dropped, and the
  robust peak is taken again. This removes the lamp problem in section 3.
- The beach-event truth is the mean over the trusted cams for that beach.

## 3. How far to trust the cam truth

Good enough to show the direction. Not good enough for fine tuning.

- **The ordering is real.** I looked at the frames for the worst misses. The
  "Amazing" mornings of 11/01, 11/03 and 11/04 were a gray overcast. The
  "Fair" mornings of 10/25 and 11/05 had scattered lit cloud and gold light. On
  almost every cam a solid deck is the lowest sky type and a clear sky is high.
- **Pre-dawn lamps.** The Deerfield pier cam and the Elbo Room cam see sodium
  and red lights at −35 minutes. In a dark frame those are "warm" pixels. Eight
  pier-cam events and one Elbo event took their peak from such a frame
  (10/18 pier: 80, really about 18; 10/24 Elbo: 70 from a −35 min dark frame).
  The cleaning step fixes this here. The live scorer still has the problem.
- **Monochrome night mode.** The Deerfield beach cam stays in black and white
  for up to half the window on dim mornings (11 of 25 frames on 10/26, 12 on
  11/03). Those frames score 0. The robust peak uses the best frames, so the
  effect is small, and those mornings were gray anyway.
- **FTL's 0s are real.** On 11/01 and 11/04 the Elbo Room cam shows a gray
  overcast at the event, so 0 is right for the sky. (On 11/01 the stored peak
  frame is a dark, rain-streaked frame with a red light; the score is still 0.)
- **Each cam has its own scale.** For the same Anna Maria sunsets, Holmes
  Beach averages 74 and White Sands averages 5. A cam whose sky region is a
  thin strip near the horizon scores the warm twilight band of a CLEAR sky at
  70–97 (`frames/west-sunsets-2026-10-25-clear.jpg`). So the cams overrate
  clear skies a little. I set the clear-sky value to 62 ("Good"), below the
  fitted 66–73.
- **Cams left out of the fit:** White Sands (mean 5, almost always blank),
  Sterling Reef and Marathon (spread under 10 points), Jacksonville Beach (all
  0 or 100 on a thin hazy strip). The new model still improves the rank order
  on all four (4.3), so leaving them out does not drive the result.

## 4. Method and results

The new score keeps the factor structure, with three plain factors:

```
score = canvas(mid/high cover) × overcast(total cover) × path(low cloud toward the sun) × air × humidity
canvas:   62 at 0% → 86 from 20% to 70% → 60 at 100%   (mid/high = screen blend)
overcast: 1.0 up to 60% total cover → 0.45 at 100%
path:     0.75 + 0.25 × clearPath/100  (clearPath = 100 up to 20% low cloud, 0 at 90%)
air, humidity: unchanged (clean air +5%, haze −25% cap, smoke −35% cap)
```

Fitted (mean absolute error, random search, 1,500 steps): the clear-sky value,
where the overcast fade starts, its floor, and the path floor. Set by physics,
not fitted: the sweet-spot edges (20/70) and the peak (86). The archive holds
only 11 partial-cloud events, too few to fit them. Fixing the peak at 75, 85 or
90 changes the error by 0.5 points. The tail past 70% is not resolved by the
data either (0.1 points). It is set so that the 2026-10-06 sunrise (forecast
67% mid, 48% high, about 95 on the cam) reads "Great" (71). The seasonal prior
is not scored any more. Amazing (90+) needs the sweet spot, a clear path and
clean air.

### 4.1 Before and after (148 events, trusted cams)

| | n | correlation | mean error | ≥85 calls | of those, ≥70 on the cam | ≥70 calls | of those, ≥70 on the cam |
|---|---|---|---|---|---|---|---|
| Old model | 148 | −0.51 | 45.0 | 35 | 14% | 42 | 17% |
| New model | 148 | +0.49 | 20.9 | 5 | 60% | 20 | 50% |
| New, refit leaving each day out | 148 | +0.44 | 22.6 | 3 | 67% | 77 | 51% |
| Old, on 10/27–11/05 | 64 | −0.46 | 44.7 | 20 | 15% | 25 | 16% |
| New, fitted on 10/15–10/26 only, scored on 10/27–11/05 | 64 | +0.48 | 24.3 | 5 | 60% | 36 | 42% |

By event: sunrises (east) −0.24 → +0.37, error 37 → 22. Sunsets (west)
−0.62 → +0.48, error 48 → 20.

### 4.2 What the app actually said (live archive, last forecast 0–60 min out)

Same archived inputs, new formula:

| Beach | n | old correlation | new correlation | old error | new error |
|---|---|---|---|---|---|
| Boca Raton (sunrise) | 20 | −0.43 | +0.46 | 43.4 | 21.6 |
| Deerfield Beach (sunrise) | 22 | −0.37 | +0.43 | 42.8 | 21.9 |
| Fort Lauderdale (sunrise) | 21 | −0.09 | +0.36 | 31.5 | 22.0 |

Boca, the days in the owner's message (old → new, cams):
11/04 98 → 34 (cams 14). 11/03 89 → 26 (6). 11/01 92 → 29 (30).
10/26 87 → 35 (15). 11/05 29 → 65 (82). 10/25 28 → 65 (76). 10/19 29 → 65 (72).
10/28 30 → 69 (50).

### 4.3 Rank order inside each cam (Spearman, old → new)

Better on all 16 cams, including the four left out of the fit:
Fort Myers Beach −0.59 → 0.39, Fort Zachary Taylor −0.76 → 0.45, Siesta
−0.46 → 0.23, Deerfield beach cam −0.39 → 0.46, Elbo Room 0.17 → 0.21, Sterling
Reef −0.13 → 0.55, Marathon −0.08 → 0.37. Pensacola (9 events, spread 7
points) stays negative, −0.38 → −0.32. All values are in `eval.json`.

### 4.4 By sky type (fit set)

| Sky at the event (satellite) | n | cam mean | old mean | new mean |
|---|---|---|---|---|
| Solid mid/high deck (total ≥ 90%) | 38 | 34 | 90 | 32 |
| Overcast, mostly low cloud | 4 | 40 | 42 | 47 |
| Low cloud in the sun's path (≥ 50%) | 3 | 43 | 18 | 46 |
| Partial mid/high, clear path | 11 | 56 | 70 | 76 |
| Clear (total < 15%) | 58 | 72 | 28 | 65 |
| Scattered low cloud only | 34 | 63 | 27 | 68 |

Bands on the fit set. Old: 33 Amazing, 9 Great, 5 Good, 97 Fair, 4 Poor.
New: 2 Amazing, 18 Great, 90 Good, 38 Fair, 0 Poor. Cams: 19, 39, 48, 20, 22.

## 5. Limits

- The skill is modest (correlation about 0.45). The satellite cannot see
  everything the cam sees. Worst remaining miss: 10/24, a "100% high" read
  that was broken low cloud under thin cirrus, lit gold (cams 76, new 29).
  The cloud-top product gives one top per pixel, so thin cirrus over broken
  cloud reads as a solid high deck.
- The new model says "Good" most of the time (90 of 148). It calls Great or
  Amazing only for partial cloud, and the period had few such events. The
  Great and Amazing hit rates rest on 5 to 20 calls.
- 22 days in October and November. No summer storms or winter fronts.
- The partial-cloud "sweet spot" is the physics prior, not a fitted result:
  the cams scored these 11 events lower (56) than clear skies (72).
- The cams overrate clear skies a little (section 3).

## 6. Reproduce

```
# inputs + truth (read-only D1, NOAA S3, frames copied from the home server)
npx wrangler d1 execute isitbeachday-plus --remote --json --command "<the three queries in scripts/build.py's header>"
python3 scripts/build.py <dir>                 # predictions joined to observations
python3 scripts/backfill_ir.py <repo> <dir> 20 # needs h5py + numpy
python3 scripts/rescore.py <repo> <dir>        # needs Pillow; frames in <dir>/frames
python3 scripts/assemble.py <dir>              # -> dataset.csv
cd <dir> && python3 scripts/evaluate.py        # -> eval.json, final_params.json
```

`scripts/models.py` holds the Python ports of both models.
`final_params.json` is the shipped parameter set.

## 7. Review fixes (2026-11-05, same version)

An independent review found these problems. All are fixed in the same `SUN_QUALITY_VERSION`.

- **Forecast total below its layers.** Open-Meteo can report a total cover below the blend of its own layers. The model now uses the larger of the two. None of the 346 fit rows is affected (satellite totals are always at or above the blend), so every number above stands. The 10/06 Boca forecast-only sunrise now reads Good (54), not Great (71). That is a known miss of the forecast-only fallback.
- **Notes.** Heavy low cloud with nothing up high no longer says "Near-clear sky". The total-only notes now follow the cover, not the band (they were reversed after the curve changed). A Good score under a heavy deck no longer says "expect little color".
- **Copy.** The card no longer says we check every sunrise and sunset against the cams. Many beaches have no cam, and the archive budget runs out before sunset. It also no longer says "leave-one-day-out checked".
- **NaN.** A non-finite reading now counts as missing.

Open, and not fixed by this change:

- **The shipped values were tuned by hand on all the data.** The leave-one-day-out and time-split refits move clear sky to about 73, and they start their search from the final values. So no clean out-of-sample number exists for the shipped model. The Deerfield and Boca cams see nearly the same sky, so Boca is not a true hold-out. The 148 events fall on 22 days, so the effective sample is about 40 to 60.
- **The partial-cloud sweet spot is a prior, not a finding.** In this data, partial-cloud events average 56 on the cams and clear skies average 72, which is the reverse of the model's order. East-coast Great calls hit 0 of 8. **Do not turn on sun alerts (`SUN_ALERTS_ENABLED`) with this model until the weekly scorecard backs the sweet spot.**
- The live sun-cam scorer still counts pre-dawn lamp frames (`docs/SUN_CAM_CHECK.md`), and the archive budget leaves almost no sunsets for the scorecard.
