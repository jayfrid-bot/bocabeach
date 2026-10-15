# Sunrise/sunset color: forecast skill by lead time — first look (2026-10-15)

Question: at what lead time does the sun-color score become trustworthy?

Data: every archived prediction (`sun_event_predictions`) joined to the sun cams'
observed color (`sun_event_observations`) — 450 rows, 15 events, 2026-10-13 → 10-15.
Boca Raton and Deerfield Beach share the same two cams, so that is 5 distinct
skies at Deerfield plus 5 at Fort Lauderdale (Elbo Room). Far too few to set a
cutoff. Raw join: `predictions-vs-cam.json`.

| lead (min) | n | mean abs error | correlation |
|---|---|---|---|
| 0–90 | 20 | 29.9 | −0.25 |
| 90–180 | 20 | 31.2 | −0.24 |
| 180–360 | 34 | 32.6 | −0.23 |
| 360–720 | 65 | 31.4 | −0.18 |
| 720–1440 | 140 | 34.4 | −0.06 |

Lead time makes no difference on this sample: the score is about 30 points off
and uncorrelated at every lead. The reasons are in the inputs, not the clock.

## What the data shows

1. **The forecast cloud layers miss real cloud.** 2026-10-14 sunrise: the cam
   saw a golden sky with lit cloud bands (87–92); Open-Meteo said 0% low/mid/high
   at every lead, so the model said "plain" (29). 2026-10-15 sunrise: a solid low
   bank on the horizon (cam 54); the forecast at 18 minutes out said 2% low cloud,
   the reanalysis later said 100%.
2. **The satellite never counted.** 0 of the 709 predictions made inside the
   90-minute window were "verified" by the GOES horizon reading. The goes-cloud
   job runs 5:55 AM–8:35 PM, so it covers both events; the likely cause is the
   Clear Sky Mask's quality flags at low sun (no valid pixels → no reading).
   To confirm: sample the feed through a sunset (scheduled for 2026-10-15).
3. **The model is overconfident.** Over all 9,160 archived predictions: plain
   56% (29), dud 27% (~10), epic 12% (~97). Any forecast mid/high deck → 97.
4. **The cam truth needs work.** The scorer masks only the blown-out sun disc
   (V > 0.92, S < 0.25); the orange glow around it counts as warm sky, so a
   clear sunrise can score high. Every sun cam faces EAST, so for sunsets the
   cams see the pink afterglow behind them (antisolar), not the sunset.

## Recommendation

- Make the event-time observation the primary input: a night-capable GOES
  cloud read (IR cloud-top product or band-13 brightness temperature) that tells
  low deck from mid/high deck at T−60…T−0, day or night.
- Fix the truth: mask a radius around the sun's glow; add a west-facing cam
  (Naples pier) for real sunset truth; label east-cam sunset scores "afterglow".
- Then recalibrate the model (the 97 on any deck) and re-run this table.
- Until then, show the score as an outlook with low confidence at every lead.
