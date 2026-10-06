# Sun color model recalibration (2026-10-06, version 2026-10-06.2)

## What happened

The Boca Raton sunrise on 2026-10-06 (07:15 EDT) was spectacular. The app rated it "Good".

Ground truth: `elbo-sunrise-sheet.jpg` holds frames from the Elbo Room cam (Fort Lauderdale, faces east; used with permission and credit). They were pulled from the YouTube stream's 4-hour DVR window, every 5 minutes from 06:45 to 07:55 EDT. A mid/high cloud deck lit pink and red from about 07:05 to 07:10, before sunrise.

The forecast inputs at the 07:00 hour were: low cloud 0%, mid 67%, high 48%, RH 87%, AOD 0.14, PM2.5 13.6.

## Three faults in version 2026-10-06.1

1. **Overhead cloud scored as a horizon blocker.** Below 5° sun elevation the GOES feed has no beam-path reading. `resolveSunHorizon` then fell back to cloud straight overhead and scored it as cloud blocking the horizon. That overhead cloud is the canvas that lights up. The clear-sky mask cannot tell cloud heights apart.
2. **The canvas peaked at one point.** It peaked at a high-weighted amount of 50 and fell 2.2 points per point either side. This morning's large deck scored 62 out of 100 for canvas.
3. **Humidity docked every coastal dawn.** The humidity penalty started at 60% RH. Florida dawns sit at 85–95% RH, so nearly every sunrise lost about 10%. AOD already measures the haze that humidity stood in for.

## Changes

- The satellite reading is recorded (`sun_event_predictions`), not scored. The clear path comes from the forecast low cloud.
- The canvas is a plateau over a high-weighted amount of 35–80. A solid mid deck (over 85% mid) is a gray lid, scaled 1.0 → 0.6. A full high veil is not penalized.
- The clear path now scales the canvas instead of adding to it: `0.85·canvas·clearPath/100 + 0.15·prior`. A cloudless sky reads "Fair", not "Good".
- Humidity counts only without an AOD reading, and then only above 92% RH (−8% cap).

## Calibration

`scripts/sun_calibrate.ts` scores every Boca sunrise and sunset from 2026-07-01 to 2026-10-05 (n = 184). It uses the Open-Meteo historical-forecast cloud split and RH (`hf.json`), CAMS AOD/PM2.5 (`aq.json`), and the event times (`sun.json`).

```
npx vite-node scripts/sun_calibrate.ts
```

| Model | p50 | p80 | p90 | Max | Great+ (≥70) | Amazing (≥90) |
|---|---|---|---|---|---|---|
| 2026-10-06.1, no satellite | 46 | 62 | 73 | 92 | 13% | 1% |
| 2026-10-06.1, overhead cloud as horizon (live behaviour) | 43 | 50 | 52 | 62 | 0% | 0% |
| 2026-10-06.2 | 28 | 66 | 84 | 98 | 18% | 8% |

The target was the owner's framing: "Great" ≈ the top 20% of events, "Amazing" ≈ the top 10%.

The live version 2026-10-06.1 could not rate any satellite-fresh event above 62. So whenever the GOES feed was fresh, the "Great or better" sun alert could not fire.

The 2026-10-06 sunrise scores 98 ("Amazing") in 2026-10-06.2. The test is in `lib/history/sunPredictions.test.ts`.

## Limits

- The calibration covers one beach and one season (the wet season, July to October).
- The forecast cloud split is a model, not an observation.
- The ground truth is one morning so far.

The sunrise/sunset cam check (`docs/SUN_CAM_CHECK.md`) fills `observed_score` for every event, so the next recalibration can fit against real skies.
