# Prediction scorecard — 2026-11-15

Data as of 2026-11-15 15:30 UTC. Hourly rows cover the last 14 days. Sun-color events cover the last 90 days; lifetime counts are shown in that section. A system with too little data says "collecting" and shows counts only. That is expected early on. See docs/scorecards/README.md for definitions and minimums.

## At a glance

- **Sunrise and sunset color:** Model 2026-11-11.1 (live now): 20 pairs; fair rank correlation collecting — 3 of 8 pairs on the best cam; Great calls in the cam's own top 25%: n=5, collecting. Model 2026-11-05.1: 53 pairs; fair rank correlation collecting — 6 of 8 pairs on the best cam; Great calls in the cam's own top 25%: n=8, collecting. Model 2026-10-15.1: 63 pairs; fair rank correlation +0.04 (61 events on 3 cams); Great calls in the cam's own top 25%: 1 of 12. Model 2026-10-06.2: collecting — 6 of 10 pairs (397 events with a forecast 30–120 min out). A forecast 30–120 min out exists for 1188 of 2261 past sunrises (53%) and 1243 of 2236 past sunsets (56%).
- **Rain forecast:** Of 5486 "dry for the next 2+ hrs" calls, 563 (10%) saw radar rain within 2 hours.
- **Best time to go:** collecting — 0 of 10 days. (0 complete days; 921 days left out for missing hours.)
- **Safety message and flags:** 30 beach-days with a flag. Green/yellow agreement: collecting — 21 of 30 beach-days.
- **Data health:** 63 beaches archiving. Extra data on 100% of the last 24 hours' rows. 35 beaches under 12 rows a day (0 of them curated). Beaches that should archive all day miss local hours 9, 10, 11, 12, 13, 14, 15, 17, 18 on most days. 1 camera silent for over 6 hours. 3 cameras offline and hidden on the page.

## Sunrise and sunset color

We forecast the color of each sunrise and sunset. Then we compare with what the beach cameras saw. One pair is one event (one beach, one sunrise or sunset) that has both a forecast and a camera reading.

- Events loaded (with a scored forecast row or a camera reading), last 90 days: 4613.
- Pairs: 296 (4793 forecast rows). Enough to score.
- Lifetime: 4613 events and 46010 forecast rows logged since 2026-10-06; 4903 rows paired; 998 camera readings.
- Camera readings in the window: 998; 495 are afterglow (the cam looked away from the sun), kept but never scored; 11 matched no forecast row, so they cannot be scored.

### The fair grade, by model version

Each camera has its own raw scale. On the same sunsets Holmes Beach averages 74 and White Sands 5, so a raw 70 means different skies on different cams. The fair grade asks only about order inside one cam. It uses the forecast people see: the one closest to 60 minutes before the event, made 30 to 120 minutes ahead. From model 2026-11-11.1 a forecast made 60 to 120 minutes ahead is the early look (satellite and hourly forecast averaged); in older versions it was the hourly forecast alone. Each event has one truth cam, the one the server picked: a cam that looks at the sun, the nearest one, then by cam id. Rank correlation runs from −1 to +1. 0 means no skill; a plus means our higher forecasts went with better skies on that cam. A cam counts once it has 8 pairs. The pooled number is the average over cams, weighted by each cam's pairs. A real Great is in that cam's own top 25% for that event kind, and a real Amazing in its top 10%. A version needs 10 pairs before it shows any number. Newest version first.

| Model version | Forecast rows loaded | Past events with a 30–120 min forecast | Pairs | Fair rank correlation | Sunrises | Sunsets | Great calls in the cam's top 25% | Amazing calls in the cam's top 10% | Raw typical miss (pts) | Raw bias (pts) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-11-11.1 (live now) | 1134 | 450 | 20 | collecting — 3 of 8 pairs on the best cam | — | — | 2 of 5 (n=5, collecting) | 0 of 0 (n=0, collecting) | 14.1 | +1.6 |
| 2026-11-05.1 | 1948 | 755 | 53 | collecting — 6 of 8 pairs on the best cam | — | — | 2 of 8 (n=8, collecting) | 1 of 4 (n=4, collecting) | 28.5 | -2.3 |
| 2026-10-15.1 | 7179 | 829 | 63 | +0.04 (61 events, 3 cams) | +0.04 (n=61) | — | 1 of 12 (8%) | 0 of 8 (n=8, collecting) | 35.9 | +0.1 |
| 2026-10-06.2 | 1838 | 397 | 6 | collecting — 6 of 10 pairs | — | — | 0 of 0 (n=0, collecting) | 0 of 0 (n=0, collecting) | collecting — 6 of 10 pairs | — |

In the top-tier columns, "3 of 8" means 3 of our 8 Great calls landed in the cam's top 25%. Chance alone gives 25% (Amazing: 10%). A rate needs 10 calls; until then it shows "n=<count>, collecting". Only cams with 8+ events of their own have a scale.

Cams with fewer than 8 events of their own, so no scale yet (left out of the top-tier counts): white-sands-ami-cam (sunset, 1).

### Coverage of the forecast people see

How many past events have a forecast made 30 to 120 minutes before them. An event without one cannot enter the fair grade.

| Event | Past events | With a 30–120 min forecast | Share | With a camera reading | Of those, with the forecast | Share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Sunrise | 2261 | 1188 | 53% | 127 | 123 | 97% |
| Sunset | 2236 | 1243 | 56% | 169 | 49 | 29% |

### Rank correlation per cam

Our forecast (30–120 min out) against the cam's own score, by rank. Each cam needs 8 pairs. Boca Raton and Deerfield Beach share the Deerfield cams. Each reading counts once, for the beach nearest the cam (Deerfield Beach).

| Model version | Cam | Event | Pairs | Rank correlation |
| --- | ---: | ---: | ---: | ---: |
| 2026-11-11.1 (live now) | deerfield-beach-cam | Sunrise | 3 | collecting — 3 of 8 pairs |
| 2026-11-11.1 (live now) | jax-beach-bw-cam | Sunrise | 3 | collecting — 3 of 8 pairs |
| 2026-11-11.1 (live now) | ftl-elbo-beach-cam | Sunrise | 2 | collecting — 2 of 8 pairs |
| 2026-11-11.1 (live now) | enco-shores-of-panama-cam | Sunset | 2 | collecting — 2 of 8 pairs |
| 2026-11-11.1 (live now) | fort-myers-beach-cam | Sunset | 2 | collecting — 2 of 8 pairs |
| 2026-11-11.1 (live now) | holmes-beach-cam | Sunset | 2 | collecting — 2 of 8 pairs |
| 2026-11-11.1 (live now) | pensacola-sria-west-cam | Sunset | 2 | collecting — 2 of 8 pairs |
| 2026-11-11.1 (live now) | siesta-beach-cam | Sunset | 2 | collecting — 2 of 8 pairs |
| 2026-11-11.1 (live now) | sunset-grille-marathon-cam | Sunset | 2 | collecting — 2 of 8 pairs |
| 2026-11-05.1 | deerfield-beach-cam | Sunrise | 6 | collecting — 6 of 8 pairs |
| 2026-11-05.1 | ftl-elbo-beach-cam | Sunrise | 6 | collecting — 6 of 8 pairs |
| 2026-11-05.1 | jax-beach-bw-cam | Sunrise | 6 | collecting — 6 of 8 pairs |
| 2026-11-05.1 | enco-shores-of-panama-cam | Sunset | 6 | collecting — 6 of 8 pairs |
| 2026-11-05.1 | fort-myers-beach-cam | Sunset | 6 | collecting — 6 of 8 pairs |
| 2026-11-05.1 | holmes-beach-cam | Sunset | 6 | collecting — 6 of 8 pairs |
| 2026-11-05.1 | siesta-beach-cam | Sunset | 6 | collecting — 6 of 8 pairs |
| 2026-11-05.1 | sunset-grille-marathon-cam | Sunset | 6 | collecting — 6 of 8 pairs |
| 2026-11-05.1 | pensacola-sria-west-cam | Sunset | 5 | collecting — 5 of 8 pairs |
| 2026-10-15.1 | deerfield-beach-cam | Sunrise | 21 | +0.13 |
| 2026-10-15.1 | ftl-elbo-beach-cam | Sunrise | 21 | -0.29 |
| 2026-10-15.1 | jax-beach-bw-cam | Sunrise | 19 | +0.32 |
| 2026-10-15.1 | fort-myers-beach-cam | Sunset | 2 | collecting — 2 of 8 pairs |
| 2026-10-06.2 | deerfield-beach-cam | Sunrise | 3 | collecting — 6 of 10 pairs |
| 2026-10-06.2 | ftl-elbo-beach-cam | Sunrise | 3 | collecting — 6 of 10 pairs |

### The forecast people see, by band (raw camera scale)

Each band needs 10 events. Bias is forecast minus the raw camera score.

| Model version | We said | Events | Typical miss (pts) | Bias (pts) |
| --- | ---: | ---: | ---: | ---: |
| 2026-11-11.1 (live now) | Fair (20–44) | 8 | collecting — 8 of 10 pairs | — |
| 2026-11-11.1 (live now) | Good (45–69) | 7 | collecting — 7 of 10 pairs | — |
| 2026-11-11.1 (live now) | Great (70–89) | 5 | collecting — 5 of 10 pairs | — |
| 2026-11-05.1 | Fair (20–44) | 19 | 30.9 | -20.5 |
| 2026-11-05.1 | Good (45–69) | 26 | 27.8 | +3.5 |
| 2026-11-05.1 | Great (70–89) | 4 | collecting — 4 of 10 pairs | — |
| 2026-11-05.1 | Amazing (90+) | 4 | collecting — 4 of 10 pairs | — |
| 2026-10-15.1 | Poor (under 20) | 20 | 27.8 | -21.9 |
| 2026-10-15.1 | Fair (20–44) | 30 | 28.7 | -13.4 |
| 2026-10-15.1 | Good (45–69) | 1 | collecting — 1 of 10 pairs | — |
| 2026-10-15.1 | Great (70–89) | 4 | collecting — 4 of 10 pairs | — |
| 2026-10-15.1 | Amazing (90+) | 8 | collecting — 8 of 10 pairs | — |
| 2026-10-06.2 | Fair (20–44) | 6 | collecting — 6 of 10 pairs | — |

### Error overall and by group (raw camera scale)

These tables use each cam's raw score, every lead time and every model version mixed. Raw scales differ by cam, so read them as a rough guide, not a grade. Bias is forecast minus camera, so a plus means we ran high. Typical miss is the average size of the error.

|  | Events | Forecasts | Typical miss (pts) | Bias (pts) |
| --- | ---: | ---: | ---: | ---: |
| All pairs | 296 | 4793 | 35.3 | -15.6 |
| Lead: After the event (golden window) | 3 | 3 | collecting — 3 of 10 pairs | — |
| Lead: 0–2 h before | 172 | 294 | 32.0 | +0.8 |
| Lead: 2–6 h before | 125 | 496 | 29.7 | -8.0 |
| Lead: 6–12 h before | 295 | 1525 | 35.0 | -17.5 |
| Lead: 12–24 h before | 295 | 2475 | 37.0 | -17.9 |
| We said: Poor (under 20) | 152 | 1194 | 36.2 | -31.6 |
| We said: Fair (20–44) | 251 | 2371 | 35.5 | -27.4 |
| We said: Good (45–69) | 105 | 637 | 23.8 | +5.2 |
| We said: Great (70–89) | 73 | 195 | 35.9 | +28.7 |
| We said: Amazing (90+) | 92 | 396 | 49.5 | +48.3 |
| Beach: boca-raton | 33 | 516 | 30.3 | -12.0 |
| Beach: deerfield-beach | 33 | 576 | 32.5 | -17.2 |
| Beach: fort-lauderdale | 32 | 560 | 25.0 | -7.5 |
| Beach: fort-myers-beach | 29 | 480 | 42.7 | -29.4 |
| Beach: jacksonville-beach | 29 | 446 | 37.8 | +2.0 |
| Beach: anna-maria-island | 27 | 446 | 47.6 | -36.5 |
| Beach: marathon | 27 | 423 | 27.0 | +22.3 |
| Beach: panama-city-beach | 27 | 422 | 23.3 | -0.6 |
| Beach: siesta-key | 27 | 421 | 45.7 | -38.9 |
| Beach: key-west | 17 | 271 | 49.6 | -43.5 |
| Beach: pensacola-beach | 15 | 232 | 35.3 | -25.8 |
| Model version: 2026-11-11.1 | 23 | 345 | 19.2 | -1.6 |
| Model version: 2026-11-05.1 | 62 | 911 | 30.3 | -5.9 |
| Model version: 2026-10-15.1 | 209 | 3330 | 38.2 | -18.4 |
| Model version: 2026-10-06.2 | 12 | 207 | 37.4 | -35.7 |
| Camera view: afterglow (not scored) | 6 | 110 | afterglow, not used as truth | — |
| Camera view: solar | 296 | 4793 | 35.3 | -15.6 |

### Our call versus what happened (raw camera scale)

The call is our last forecast made at least 60 minutes before the event. Great means 70 or more, on the forecast and on the RAW camera score. Amazing means 90 or more. Some cams give 70+ to most clear skies, so the raw "it happened" and "miss" counts here are mostly a property of the cam. The fair top-tier table above is the grade. Each rate needs 10 cases in its own denominator; until then it shows "n=<count>, collecting". 

|  | Great (70+) | Amazing (90+) |
| --- | ---: | ---: |
| Events with a call | 296 | 296 |
| We called it, and it happened (hit) | 13 | 1 |
| We called it, and it did not (false alarm) | 21 | 17 |
| It happened, and we did not call it (miss) | 101 | 36 |
| Neither | 161 | 242 |
| Hit rate (share of our calls that happened) | 38% | 6% |
| False-alarm rate (share of our calls that did not) | 62% | 94% |
| Miss rate (share of real ones we did not call) | 89% | 97% |

### How often we say Great or Amazing (camera columns on the raw scale)

The model is built so about 20% of events are Great or better, and about 10% are Amazing. Shares wait for 10 events in a row.

|  | Events | Forecast Great+ | Forecast Amazing | Paired events | Forecast Great+ (paired) | Camera Great+ | Camera Amazing |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Design target |  | 20% | 10% |  |  | 20% | 10% |
| All beaches | 4496 | 12% | 8% | 296 | 11% | 39% | 13% |
| anna-maria-island | 57 | 12% | 9% | 27 | 15% | 70% | 59% |
| asbury-park | 80 | 16% | 14% | 0 | — | — | — |
| biloxi | 80 | 20% | 18% | 0 | — | — | — |
| boca-raton | 80 | 13% | 8% | 33 | 6% | 33% | 3% |
| cannon-beach | 80 | 10% | 10% | 0 | — | — | — |
| cape-may | 80 | 11% | 10% | 0 | — | — | — |
| cocoa-beach | 80 | 9% | 5% | 0 | — | — | — |
| coney-island | 80 | 11% | 11% | 0 | — | — | — |
| crescent-bay-park | 80 | 10% | 5% | 0 | — | — | — |
| dania-beach | 57 | 7% | 4% | 0 | — | — | — |
| daytona-beach | 80 | 10% | 9% | 0 | — | — | — |
| deerfield-beach | 80 | 13% | 9% | 33 | 12% | 33% | 3% |
| dunlawton-beach | 57 | 9% | 5% | 0 | — | — | — |
| folly-beach | 80 | 14% | 11% | 0 | — | — | — |
| fort-lauderdale | 80 | 13% | 9% | 32 | 13% | 0% | 0% |
| fort-myers-beach | 61 | 11% | 8% | 29 | 17% | 66% | 10% |
| galveston | 80 | 13% | 11% | 0 | — | — | — |
| grand-isle | 80 | 24% | 18% | 0 | — | — | — |
| gulf-shores | 80 | 18% | 14% | 0 | — | — | — |
| hammonasset-beach | 80 | 19% | 16% | 0 | — | — | — |
| hampton-beach | 80 | 11% | 9% | 0 | — | — | — |
| hobe-sound | 57 | 11% | 4% | 0 | — | — | — |
| hollywood-beach | 57 | 16% | 7% | 0 | — | — | — |
| huntington-beach | 80 | 11% | 6% | 0 | — | — | — |
| jacksonville-beach | 81 | 6% | 5% | 29 | 7% | 28% | 17% |
| jensen-beach | 57 | 11% | 7% | 0 | — | — | — |
| jupiter | 57 | 12% | 4% | 0 | — | — | — |
| key-west | 57 | 11% | 4% | 17 | 6% | 82% | 35% |
| key-west-south | 57 | 12% | 5% | 0 | — | — | — |
| la-jolla | 80 | 10% | 9% | 0 | — | — | — |
| long-beach | 80 | 4% | 4% | 0 | — | — | — |
| marathon | 57 | 5% | 2% | 27 | 7% | 0% | 0% |
| miami-beach | 80 | 14% | 10% | 0 | — | — | — |
| misquamicut | 80 | 20% | 14% | 0 | — | — | — |
| montauk | 80 | 18% | 13% | 0 | — | — | — |
| myrtle-beach | 80 | 11% | 8% | 0 | — | — | — |
| nags-head | 80 | 15% | 14% | 0 | — | — | — |
| naples | 80 | 16% | 11% | 0 | — | — | — |
| new-smyrna-beach | 57 | 7% | 2% | 0 | — | — | — |
| ocean-shores | 80 | 16% | 13% | 0 | — | — | — |
| old-orchard-beach | 80 | 14% | 10% | 0 | — | — | — |
| ormond-beach | 57 | 9% | 4% | 0 | — | — | — |
| panama-city-beach | 57 | 18% | 11% | 27 | 11% | 0% | 0% |
| pensacola-beach | 61 | 21% | 13% | 15 | 27% | 73% | 7% |
| pismo-beach | 80 | 10% | 8% | 0 | — | — | — |
| ponce-inlet | 57 | 9% | 4% | 0 | — | — | — |
| rehoboth-beach | 80 | 13% | 10% | 0 | — | — | — |
| santa-cruz | 80 | 14% | 11% | 0 | — | — | — |
| santa-monica | 80 | 9% | 5% | 0 | — | — | — |
| seaside | 80 | 13% | 9% | 0 | — | — | — |
| sebastian-inlet | 57 | 9% | 5% | 0 | — | — | — |
| siesta-key | 57 | 12% | 7% | 27 | 11% | 78% | 15% |
| singer-island | 57 | 5% | 5% | 0 | — | — | — |
| sombrero-beach | 57 | 4% | 0% | 0 | — | — | — |
| south-padre-island | 80 | 14% | 8% | 0 | — | — | — |
| st-augustine-beach | 57 | 5% | 0% | 0 | — | — | — |
| stuart-bathtub-beach | 57 | 11% | 4% | 0 | — | — | — |
| tybee-island | 80 | 16% | 9% | 0 | — | — | — |
| vilano-beach | 57 | 5% | 2% | 0 | — | — | — |
| virginia-beach | 80 | 10% | 4% | 0 | — | — | — |
| wabasso-beach | 57 | 12% | 7% | 0 | — | — | — |
| waikiki | 79 | 23% | 10% | 0 | — | — | — |
| wrightsville-beach | 80 | 10% | 9% | 0 | — | — | — |

### East-coast sunsets: the afterglow over the ocean

An east-facing cam looks away from the sun at sunset. It sees the afterglow on the clouds over the ocean. On an east-coast beach that afterglow is what a beachgoer sees at sunset. These readings are never the truth for the sunset's color, and they are not in any number above. Here each cam is graded by rank only (Spearman, 8+ events per cell). The satellite column is the mid and high cloud along the path away from the sun (breakdown_json.satellite.antiMidHighPct). The satellite is read only within 60 minutes of the event, so only some events have it. It is evidence for a future afterglow forecast, not a grade.

| Cam | Afterglow readings | Matched to a forecast event | Model version | Forecast 30–120 min out vs afterglow | Call (60+ min out) vs afterglow | Satellite cloud away from the sun vs afterglow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| deerfield-beach-cam | 32 | 32 | 2026-11-11.1 | collecting — 2 of 8 events | collecting — 2 of 8 events | collecting — 4 of 8 events |
|  |  |  | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events |  |
|  |  |  | 2026-10-15.1 | collecting — 2 of 8 events | +0.25 (n=21) |  |
|  |  |  | 2026-10-06.2 | collecting — 3 of 8 events | collecting — 3 of 8 events |  |
| deerfield-pier-cam | 32 | 32 | 2026-11-11.1 | collecting — 2 of 8 events | collecting — 2 of 8 events | collecting — 4 of 8 events |
|  |  |  | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events |  |
|  |  |  | 2026-10-15.1 | collecting — 2 of 8 events | +0.16 (n=21) |  |
|  |  |  | 2026-10-06.2 | collecting — 3 of 8 events | collecting — 3 of 8 events |  |
| ftl-elbo-beach-cam | 32 | 32 | 2026-11-11.1 | collecting — 2 of 8 events | collecting — 2 of 8 events | collecting — 5 of 8 events |
|  |  |  | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events |  |
|  |  |  | 2026-10-15.1 | collecting — 2 of 8 events | +0.41 (n=21) |  |
|  |  |  | 2026-10-06.2 | collecting — 3 of 8 events | collecting — 3 of 8 events |  |
| jax-beach-bw-cam | 27 | 27 | 2026-11-11.1 | collecting — 2 of 8 events | collecting — 2 of 8 events | collecting — 3 of 8 events |
|  |  |  | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events |  |
|  |  |  | 2026-10-15.1 | collecting — 1 of 8 events | -0.03 (n=20) |  |

### Gulf sunrises: the afterglow over the Gulf

The same check for west-facing Gulf cams at sunrise. The sun rises behind them, over the land, and they see the afterglow on the clouds over the Gulf.

| Cam | Afterglow readings | Matched to a forecast event | Model version | Forecast 30–120 min out vs afterglow | Call (60+ min out) vs afterglow | Satellite cloud away from the sun vs afterglow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fort-myers-beach-cam | 29 | 29 | 2026-11-11.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | +0.23 (n=29) |
|  |  |  | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events |  |
|  |  |  | 2026-10-15.1 | +0.05 (n=21) | +0.11 (n=21) |  |
| enco-shores-of-panama-cam | 28 | 28 | 2026-11-11.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | +0.09 (n=22) |
|  |  |  | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events |  |
|  |  |  | 2026-10-15.1 | +0.18 (n=19) | -0.31 (n=19) |  |
| margaritaville-fmb-cam | 28 | 28 | 2026-11-11.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | +0.24 (n=28) |
|  |  |  | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events |  |
|  |  |  | 2026-10-15.1 | +0.26 (n=19) | +0.34 (n=19) |  |
| sharkys-pcb-cam | 28 | 28 | 2026-11-11.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | -0.31 (n=22) |
|  |  |  | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events |  |
|  |  |  | 2026-10-15.1 | -0.10 (n=19) | +0.35 (n=19) |  |
| sunset-grille-marathon-cam | 28 | 28 | 2026-11-11.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | +0.17 (n=27) |
|  |  |  | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events |  |
|  |  |  | 2026-10-15.1 | -0.08 (n=19) | -0.06 (n=19) |  |
| white-sands-ami-cam | 28 | 28 | 2026-11-11.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | +0.56 (n=18) |
|  |  |  | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events |  |
|  |  |  | 2026-10-15.1 | +0.14 (n=19) | +0.26 (n=19) |  |
| enco-sterling-reef-cam | 27 | 27 | 2026-11-11.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | -0.33 (n=22) |
|  |  |  | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events |  |
|  |  |  | 2026-10-15.1 | +0.03 (n=19) | +0.61 (n=19) |  |
| holmes-beach-cam | 27 | 27 | 2026-11-11.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | -0.17 (n=17) |
|  |  |  | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events |  |
|  |  |  | 2026-10-15.1 | -0.13 (n=18) | -0.11 (n=18) |  |
| siesta-beach-cam | 27 | 27 | 2026-11-11.1 | collecting — 1 of 8 events | collecting — 2 of 8 events | -0.21 (n=27) |
|  |  |  | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events |  |
|  |  |  | 2026-10-15.1 | +0.19 (n=19) | +0.19 (n=19) |  |
| pink-shell-fmb-cam | 22 | 22 | 2026-11-11.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | +0.66 (n=22) |
|  |  |  | 2026-11-05.1 | collecting — 4 of 8 events | collecting — 4 of 8 events |  |
|  |  |  | 2026-10-15.1 | +0.44 (n=15) | +0.48 (n=15) |  |
| fort-zachary-taylor-cam | 19 | 19 | 2026-10-15.1 | +0.07 (n=19) | +0.07 (n=19) | +0.15 (n=19) |
| pensacola-sria-west-cam | 17 | 17 | 2026-11-11.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | +0.11 (n=11) |
|  |  |  | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events |  |
|  |  |  | 2026-10-15.1 | -0.11 (n=9) | -0.11 (n=9) |  |

### What to fix next

Made from the numbers above by fixed rules (see docs/scorecards/README.md).

- Model 2026-11-05.1 runs low when it says Fair: bias -20.5 points on 19 events (raw camera scale).
- Model 2026-10-15.1 runs low when it says Poor: bias -21.9 points on 20 events (raw camera scale).
- Model 2026-10-15.1's Great calls land in the cam's own top 25% only 8% of the time (1 of 12); chance alone gives 25%.
- Afterglow signal at sharkys-pcb-cam (sunrises): the satellite's mid/high cloud away from the sun has a rank correlation of -0.31 with the afterglow on 22 events. A candidate input for an afterglow forecast.
- Afterglow signal at white-sands-ami-cam (sunrises): the satellite's mid/high cloud away from the sun has a rank correlation of +0.56 with the afterglow on 18 events. A candidate input for an afterglow forecast.
- Afterglow signal at enco-sterling-reef-cam (sunrises): the satellite's mid/high cloud away from the sun has a rank correlation of -0.33 with the afterglow on 22 events. A candidate input for an afterglow forecast.
- Afterglow signal at pink-shell-fmb-cam (sunrises): the satellite's mid/high cloud away from the sun has a rank correlation of +0.66 with the afterglow on 22 events. A candidate input for an afterglow forecast.

## Rain forecast

The app says "dry" or "raining" from a weather model, with a note on when that changes. We turn that into a forecast for one hour ahead and two hours ahead. "Dry, rain in 25 min" is a rain forecast for both. "Raining, easing in 25 min" is a dry forecast for both. A change at or before the hour has happened by then. Then we check each forecast against the radar reading one and two hours later. Radar rain means a rate above 0 mm/hr, or a fresh frame that saw rain at or near the beach in the last 20 minutes. A radar frame older than 25 minutes is not used.

- Hours with a rain call: 8787.
- Scored (radar available one and two hours later): 6052. Enough to score.
- Each rate needs enough cases in its own denominator (10 for the matrices, 30 for the headline); until then it shows "n=<count>, collecting".

Headline, the promise "Dry for the next 2+ hrs" (dry now, no rain forecast for 2 hours): 5486 calls scored; 563 saw radar rain within 2 hours (10%).

**Forecast one hour ahead, against radar one hour later**

| Forecast said | Radar saw rain | Radar saw no rain |
| --- | ---: | ---: |
| Rain | 161 | 126 |
| Dry | 511 | 5254 |

When we forecast rain: radar confirmed it 56% of the time, and did not 44%. Of the times radar saw rain, we had forecast dry 76%. Of our dry forecasts, 9% got rained on.

**Forecast two hours ahead, against radar two hours later**

| Forecast said | Radar saw rain | Radar saw no rain |
| --- | ---: | ---: |
| Rain | 184 | 219 |
| Dry | 480 | 5169 |

When we forecast rain: radar confirmed it 46% of the time, and did not 54%. Of the times radar saw rain, we had forecast dry 72%. Of our dry forecasts, 8% got rained on.

## Best time to go

Each morning the app names a best window for the beach. We take the window it named by 10 AM local time. Then we compare it with the hourly scores we archived for that day. Only a complete day counts: it must be over, have at least 8 scored daylight hours, have 80% of the daylight hours between its first and last archived hour, start within 2 hours of sunrise, and reach 5 PM local (or the last daylight hour). A day that fails this is censored: its archived hours cover only part of the day, so it has no honest best hour.

- Complete days: 0.
- Of those, with a window named by 10 AM: 0. Status: collecting — 0 of 10 days.
- Left out: 921 censored days (missing hours), 0 scored by two model versions (a deploy day), 63 still in progress, 0 with no early window. Outlook forecasts skipped across a model change: 0.

Days ahead: no outlook rows with a finished target day yet.

## Safety message and lifeguard flags

We compare our swim message (safe, caution, stay out) with the lifeguard flag that was flying. The City posts one flag a beach a day, so we count beach-days, not hours. A beach-day's flag is its most common flag. Our message is its most common swim level; a tie goes to the more serious one. Only beaches with a posted flag count.

- Beach-days with a swim message and a known flag: 30 (from 130 hourly rows). Enough to score.

### Swim message by flag (beach-days)

| Flag | Safe | Caution | Stay out |
| --- | ---: | ---: | ---: |
| double-red | 0 | 0 | 3 |
| red | 0 | 0 | 6 |
| yellow | 5 | 7 | 0 |
| green | 9 | 0 | 0 |

A red or double-red flag sets "stay out" directly (lib/safetyLine.ts). Those rows say nothing about our own judgement. The next section leaves them out.

### Green and yellow flags only

- Beach-days: 21 (12 yellow, 9 green). Status: collecting — 21 of 30 beach-days.
- Agreement (yellow with caution or stay out, or green with safe): 16 of 21; rate n=21, collecting.
- Yellow flag, but we said safe: 5.
- Green flag, but we said caution or stay out: 0.

## Data health

- Beaches with rows in the last 7 days: 63.
- Extra data (the prediction blocks) is on 100% of rows in this report's window, 100% of the last 24 hours, and 100% of rows since the first one (2026-11-01 00Z).
- Share of the last 24 hours' extra rows with each block: window 73.8%, rain 100%, flags 100%, outlook 100%, safety 100%, rip 100%.
- Local hours missing on beaches that should archive all 24 (28 beaches, 168 beach-days): 9 (25% present), 10 (0% present), 11 (0% present), 12 (0% present), 13 (0% present), 14 (0% present), 15 (7.1% present), 17 (0% present), 18 (7.1% present). "Best time to go" cannot score these hours, and sunset forecasts close to the event are missing.
- Beaches under 12 rows a day (finished days, last 7 days), worst first. Auto-tier beaches archive daylight hours only, so their full count is the Expected column:

| Beach | Tier | Rows per day | Expected | Fewest in a day | Days counted |
| --- | ---: | ---: | ---: | ---: | ---: |
| santa-cruz | auto | 2.3 | 10 | 2 | 6 |
| seaside | auto | 2.3 | 10 | 2 | 6 |
| pismo-beach | auto | 2.7 | 10 | 2 | 6 |
| crescent-bay-park | auto | 3 | 10 | 3 | 6 |
| huntington-beach | auto | 3 | 10 | 3 | 6 |
| la-jolla | auto | 3 | 10 | 3 | 6 |
| long-beach | auto | 3 | 10 | 3 | 6 |
| santa-monica | auto | 3 | 10 | 3 | 6 |
| cannon-beach | auto | 3 | 9 | 3 | 6 |
| ocean-shores | auto | 3 | 9 | 3 | 6 |

  And 25 more (4 to 6 rows a day).

- Latest camera capture per beach (oldest first): key-west 233.2 h ago, jacksonville-beach 2.7 h ago, jensen-beach 2.7 h ago, hollywood-beach 2.5 h ago, jupiter 2.3 h ago, and 22 more. Silent for over 6 hours: key-west.
- Cameras hidden as offline (they come back on their own with the first good frame): 3
  - deerfield-surf-cam (deerfield-beach): no good frame stored, last try Nov 15, 10:13 AM ET (blank)
  - fort-zachary-taylor-cam (key-west): offline since Nov 6, 11:08 AM ET, last good frame Nov 5, 8:08 PM ET, last try Nov 5, 2:00 PM ET
  - deerfield-spinner-uw (deerfield-beach): offline since Nov 12, 8:00 PM ET, last good frame Nov 12, 2:00 PM ET, last try Nov 15, 10:13 AM ET (blank)
- Sun camera readings: 998; latest event 2026-11-15T12:14:28.828Z, scored 2026-11-15T12:53:46.730Z.
- Sun-color forecast rows in the last 24 hours: 1170.

---

Made by `npx vite-node -c vitest.config.ts scripts/scorecard.ts`. Read-only: it never writes to the database.
