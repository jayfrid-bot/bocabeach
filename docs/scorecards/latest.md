# Prediction scorecard — 2026-11-11

Data as of 2026-11-11 15:30 UTC. Hourly rows cover the last 14 days. Sun-color events cover the last 90 days; lifetime counts are shown in that section. A system with too little data says "collecting" and shows counts only. That is expected early on. See docs/scorecards/README.md for definitions and minimums.

## At a glance

- **Sunrise and sunset color:** Model 2026-11-05.1 (live now): 47 pairs; fair rank correlation collecting — 6 of 8 pairs on the best cam; Great calls in the cam's own top 25%: n=5, collecting. Model 2026-10-15.1: 63 pairs; fair rank correlation +0.04 (61 events on 3 cams); Great calls in the cam's own top 25%: 1 of 12. Model 2026-10-06.2: collecting — 6 of 10 pairs (397 events with a forecast 30–120 min out). A forecast 30–120 min out exists for 937 of 2009 past sunrises (47%) and 991 of 1984 past sunsets (50%).
- **Rain forecast:** Of 5631 "dry for the next 2+ hrs" calls, 942 (17%) saw radar rain within 2 hours.
- **Best time to go:** collecting — 0 of 10 days. (0 complete days; 921 days left out for missing hours.)
- **Safety message and flags:** 30 beach-days with a flag. Green/yellow agreement: collecting — 15 of 30 beach-days.
- **Data health:** 63 beaches archiving. Extra data on 100% of the last 24 hours' rows. 35 beaches under 12 rows a day (0 of them curated). Beaches that should archive all day miss local hours 9, 10, 11, 12, 13, 14, 15, 16, 17, 18 on most days. 1 camera silent for over 6 hours. 3 cameras offline and hidden on the page.

## Sunrise and sunset color

We forecast the color of each sunrise and sunset. Then we compare with what the beach cameras saw. One pair is one event (one beach, one sunrise or sunset) that has both a forecast and a camera reading.

- Events loaded (with a scored forecast row or a camera reading), last 90 days: 4109.
- Pairs: 267 (4345 forecast rows). Enough to score.
- Lifetime: 4109 events and 41336 forecast rows logged since 2026-10-06; 4455 rows paired; 898 camera readings.
- Camera readings in the window: 898; 445 are afterglow (the cam looked away from the sun), kept but never scored; 11 matched no forecast row, so they cannot be scored.

### The fair grade, by model version

Each camera has its own raw scale. On the same sunsets Holmes Beach averages 74 and White Sands 5, so a raw 70 means different skies on different cams. The fair grade asks only about order inside one cam. It uses the forecast people see: the one closest to 60 minutes before the event, made 30 to 120 minutes ahead. Each event has one truth cam, the one the server picked: a cam that looks at the sun, the nearest one, then by cam id. Rank correlation runs from −1 to +1. 0 means no skill; a plus means our higher forecasts went with better skies on that cam. A cam counts once it has 8 pairs. The pooled number is the average over cams, weighted by each cam's pairs. A real Great is in that cam's own top 25% for that event kind, and a real Amazing in its top 10%. A version needs 10 pairs before it shows any number. Newest version first.

| Model version | Forecast rows loaded | Past events with a 30–120 min forecast | Pairs | Fair rank correlation | Sunrises | Sunsets | Great calls in the cam's top 25% | Amazing calls in the cam's top 10% | Raw typical miss (pts) | Raw bias (pts) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-11-05.1 (live now) | 1914 | 702 | 47 | collecting — 6 of 8 pairs on the best cam | — | — | 2 of 5 (n=5, collecting) | 1 of 2 (n=2, collecting) | 27.7 | -6.8 |
| 2026-10-15.1 | 7179 | 829 | 63 | +0.04 (61 events, 3 cams) | +0.04 (n=61) | — | 1 of 12 (8%) | 0 of 8 (n=8, collecting) | 35.9 | +0.1 |
| 2026-10-06.2 | 1838 | 397 | 6 | collecting — 6 of 10 pairs | — | — | 0 of 0 (n=0, collecting) | 0 of 0 (n=0, collecting) | collecting — 6 of 10 pairs | — |

In the top-tier columns, "3 of 8" means 3 of our 8 Great calls landed in the cam's top 25%. Chance alone gives 25% (Amazing: 10%). A rate needs 10 calls; until then it shows "n=<count>, collecting". Only cams with 8+ events of their own have a scale.

Cams with fewer than 8 events of their own, so no scale yet (left out of the top-tier counts): white-sands-ami-cam (sunset, 1).

### Coverage of the forecast people see

How many past events have a forecast made 30 to 120 minutes before them. An event without one cannot enter the fair grade.

| Event | Past events | With a 30–120 min forecast | Share | With a camera reading | Of those, with the forecast | Share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Sunrise | 2009 | 937 | 47% | 116 | 112 | 97% |
| Sunset | 1984 | 991 | 50% | 151 | 31 | 21% |

### Rank correlation per cam

Our forecast (30–120 min out) against the cam's own score, by rank. Each cam needs 8 pairs. Boca Raton and Deerfield Beach share the Deerfield cams. Each reading counts once, for the beach nearest the cam (Deerfield Beach).

| Model version | Cam | Event | Pairs | Rank correlation |
| --- | ---: | ---: | ---: | ---: |
| 2026-11-05.1 (live now) | deerfield-beach-cam | Sunrise | 6 | collecting — 6 of 8 pairs |
| 2026-11-05.1 (live now) | ftl-elbo-beach-cam | Sunrise | 6 | collecting — 6 of 8 pairs |
| 2026-11-05.1 (live now) | jax-beach-bw-cam | Sunrise | 6 | collecting — 6 of 8 pairs |
| 2026-11-05.1 (live now) | enco-shores-of-panama-cam | Sunset | 5 | collecting — 5 of 8 pairs |
| 2026-11-05.1 (live now) | fort-myers-beach-cam | Sunset | 5 | collecting — 5 of 8 pairs |
| 2026-11-05.1 (live now) | holmes-beach-cam | Sunset | 5 | collecting — 5 of 8 pairs |
| 2026-11-05.1 (live now) | siesta-beach-cam | Sunset | 5 | collecting — 5 of 8 pairs |
| 2026-11-05.1 (live now) | sunset-grille-marathon-cam | Sunset | 5 | collecting — 5 of 8 pairs |
| 2026-11-05.1 (live now) | pensacola-sria-west-cam | Sunset | 4 | collecting — 4 of 8 pairs |
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
| 2026-11-05.1 (live now) | Fair (20–44) | 17 | 33.4 | -23.4 |
| 2026-11-05.1 (live now) | Good (45–69) | 25 | 26.7 | +1.4 |
| 2026-11-05.1 (live now) | Great (70–89) | 3 | collecting — 3 of 10 pairs | — |
| 2026-11-05.1 (live now) | Amazing (90+) | 2 | collecting — 2 of 10 pairs | — |
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
| All pairs | 267 | 4345 | 36.4 | -17.5 |
| Lead: After the event (golden window) | 3 | 3 | collecting — 3 of 10 pairs | — |
| Lead: 0–2 h before | 143 | 254 | 33.9 | +0.3 |
| Lead: 2–6 h before | 114 | 452 | 30.3 | -8.9 |
| Lead: 6–12 h before | 266 | 1394 | 36.1 | -18.9 |
| Lead: 12–24 h before | 266 | 2242 | 38.2 | -20.4 |
| We said: Poor (under 20) | 152 | 1194 | 36.2 | -31.6 |
| We said: Fair (20–44) | 229 | 2140 | 37.2 | -28.7 |
| We said: Good (45–69) | 86 | 490 | 25.2 | +3.0 |
| We said: Great (70–89) | 61 | 159 | 33.3 | +25.8 |
| We said: Amazing (90+) | 81 | 362 | 49.4 | +48.4 |
| Beach: boca-raton | 30 | 468 | 30.8 | -12.7 |
| Beach: deerfield-beach | 30 | 528 | 33.2 | -17.8 |
| Beach: fort-lauderdale | 30 | 528 | 25.2 | -9.2 |
| Beach: fort-myers-beach | 26 | 432 | 45.6 | -31.8 |
| Beach: jacksonville-beach | 26 | 401 | 39.9 | +3.5 |
| Beach: anna-maria-island | 24 | 398 | 49.9 | -41.2 |
| Beach: marathon | 24 | 378 | 25.6 | +20.8 |
| Beach: panama-city-beach | 24 | 377 | 22.5 | -4.2 |
| Beach: siesta-key | 24 | 377 | 47.9 | -41.2 |
| Beach: key-west | 17 | 271 | 49.6 | -43.5 |
| Beach: pensacola-beach | 12 | 187 | 41.4 | -32.4 |
| Model version: 2026-11-05.1 | 53 | 808 | 29.0 | -9.0 |
| Model version: 2026-10-15.1 | 209 | 3330 | 38.2 | -18.4 |
| Model version: 2026-10-06.2 | 12 | 207 | 37.4 | -35.7 |
| Camera view: afterglow (not scored) | 6 | 110 | afterglow, not used as truth | — |
| Camera view: solar | 267 | 4345 | 36.4 | -17.5 |

### Our call versus what happened (raw camera scale)

The call is our last forecast made at least 60 minutes before the event. Great means 70 or more, on the forecast and on the RAW camera score. Amazing means 90 or more. Some cams give 70+ to most clear skies, so the raw "it happened" and "miss" counts here are mostly a property of the cam. The fair top-tier table above is the grade. Each rate needs 10 cases in its own denominator; until then it shows "n=<count>, collecting". 

|  | Great (70+) | Amazing (90+) |
| --- | ---: | ---: |
| Events with a call | 267 | 267 |
| We called it, and it happened (hit) | 10 | 1 |
| We called it, and it did not (false alarm) | 16 | 15 |
| It happened, and we did not call it (miss) | 100 | 34 |
| Neither | 141 | 217 |
| Hit rate (share of our calls that happened) | 38% | 6% |
| False-alarm rate (share of our calls that did not) | 62% | 94% |
| Miss rate (share of real ones we did not call) | 91% | 97% |

### How often we say Great or Amazing (camera columns on the raw scale)

The model is built so about 20% of events are Great or better, and about 10% are Amazing. Shares wait for 10 events in a row.

|  | Events | Forecast Great+ | Forecast Amazing | Paired events | Forecast Great+ (paired) | Camera Great+ | Camera Amazing |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Design target |  | 20% | 10% |  |  | 20% | 10% |
| All beaches | 3992 | 13% | 9% | 267 | 10% | 41% | 13% |
| anna-maria-island | 49 | 10% | 10% | 24 | 8% | 75% | 63% |
| asbury-park | 72 | 18% | 15% | 0 | — | — | — |
| biloxi | 72 | 19% | 17% | 0 | — | — | — |
| boca-raton | 72 | 13% | 8% | 30 | 7% | 37% | 3% |
| cannon-beach | 72 | 11% | 11% | 0 | — | — | — |
| cape-may | 72 | 13% | 11% | 0 | — | — | — |
| cocoa-beach | 72 | 10% | 6% | 0 | — | — | — |
| coney-island | 72 | 13% | 13% | 0 | — | — | — |
| crescent-bay-park | 72 | 7% | 6% | 0 | — | — | — |
| dania-beach | 49 | 4% | 4% | 0 | — | — | — |
| daytona-beach | 72 | 11% | 10% | 0 | — | — | — |
| deerfield-beach | 72 | 14% | 10% | 30 | 13% | 37% | 3% |
| dunlawton-beach | 49 | 10% | 6% | 0 | — | — | — |
| folly-beach | 72 | 15% | 13% | 0 | — | — | — |
| fort-lauderdale | 72 | 11% | 10% | 30 | 10% | 0% | 0% |
| fort-myers-beach | 53 | 9% | 8% | 26 | 12% | 73% | 12% |
| galveston | 72 | 13% | 13% | 0 | — | — | — |
| grand-isle | 72 | 25% | 19% | 0 | — | — | — |
| gulf-shores | 72 | 18% | 15% | 0 | — | — | — |
| hammonasset-beach | 72 | 19% | 18% | 0 | — | — | — |
| hampton-beach | 72 | 11% | 10% | 0 | — | — | — |
| hobe-sound | 49 | 10% | 4% | 0 | — | — | — |
| hollywood-beach | 49 | 14% | 8% | 0 | — | — | — |
| huntington-beach | 72 | 8% | 7% | 0 | — | — | — |
| jacksonville-beach | 73 | 5% | 5% | 26 | 4% | 27% | 19% |
| jensen-beach | 49 | 10% | 8% | 0 | — | — | — |
| jupiter | 49 | 6% | 4% | 0 | — | — | — |
| key-west | 49 | 12% | 4% | 17 | 6% | 82% | 35% |
| key-west-south | 49 | 14% | 6% | 0 | — | — | — |
| la-jolla | 72 | 11% | 10% | 0 | — | — | — |
| long-beach | 72 | 4% | 4% | 0 | — | — | — |
| marathon | 49 | 6% | 2% | 24 | 8% | 0% | 0% |
| miami-beach | 72 | 15% | 11% | 0 | — | — | — |
| misquamicut | 72 | 21% | 15% | 0 | — | — | — |
| montauk | 72 | 19% | 14% | 0 | — | — | — |
| myrtle-beach | 72 | 13% | 8% | 0 | — | — | — |
| nags-head | 72 | 17% | 15% | 0 | — | — | — |
| naples | 72 | 18% | 13% | 0 | — | — | — |
| new-smyrna-beach | 49 | 8% | 2% | 0 | — | — | — |
| ocean-shores | 72 | 18% | 14% | 0 | — | — | — |
| old-orchard-beach | 72 | 13% | 11% | 0 | — | — | — |
| ormond-beach | 49 | 10% | 4% | 0 | — | — | — |
| panama-city-beach | 49 | 16% | 10% | 24 | 13% | 0% | 0% |
| pensacola-beach | 53 | 23% | 15% | 12 | 25% | 83% | 8% |
| pismo-beach | 72 | 11% | 8% | 0 | — | — | — |
| ponce-inlet | 49 | 10% | 4% | 0 | — | — | — |
| rehoboth-beach | 72 | 14% | 11% | 0 | — | — | — |
| santa-cruz | 72 | 15% | 13% | 0 | — | — | — |
| santa-monica | 72 | 7% | 6% | 0 | — | — | — |
| seaside | 72 | 14% | 10% | 0 | — | — | — |
| sebastian-inlet | 49 | 8% | 6% | 0 | — | — | — |
| siesta-key | 49 | 10% | 6% | 24 | 8% | 83% | 13% |
| singer-island | 49 | 6% | 6% | 0 | — | — | — |
| sombrero-beach | 49 | 4% | 0% | 0 | — | — | — |
| south-padre-island | 72 | 15% | 8% | 0 | — | — | — |
| st-augustine-beach | 49 | 4% | 0% | 0 | — | — | — |
| stuart-bathtub-beach | 49 | 8% | 4% | 0 | — | — | — |
| tybee-island | 72 | 18% | 10% | 0 | — | — | — |
| vilano-beach | 49 | 4% | 2% | 0 | — | — | — |
| virginia-beach | 72 | 11% | 4% | 0 | — | — | — |
| wabasso-beach | 49 | 12% | 8% | 0 | — | — | — |
| waikiki | 71 | 25% | 11% | 0 | — | — | — |
| wrightsville-beach | 72 | 11% | 10% | 0 | — | — | — |

### East-coast sunsets: the afterglow over the ocean

An east-facing cam looks away from the sun at sunset. It sees the afterglow on the clouds over the ocean. On an east-coast beach that afterglow is what a beachgoer sees at sunset. These readings are never the truth for the sunset's color, and they are not in any number above. Here each cam is graded by rank only (Spearman, 8+ events per cell). The satellite column is the mid and high cloud along the path away from the sun (breakdown_json.satellite.antiMidHighPct). The satellite is read only within 60 minutes of the event, so only some events have it. It is evidence for a future afterglow forecast, not a grade.

| Cam | Afterglow readings | Matched to a forecast event | Model version | Forecast 30–120 min out vs afterglow | Call (60+ min out) vs afterglow | Satellite cloud away from the sun vs afterglow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| deerfield-beach-cam | 29 | 29 | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events | collecting — 3 of 8 events |
|  |  |  | 2026-10-15.1 | collecting — 2 of 8 events | +0.25 (n=21) |  |
|  |  |  | 2026-10-06.2 | collecting — 3 of 8 events | collecting — 3 of 8 events |  |
| deerfield-pier-cam | 29 | 29 | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events | collecting — 3 of 8 events |
|  |  |  | 2026-10-15.1 | collecting — 2 of 8 events | +0.16 (n=21) |  |
|  |  |  | 2026-10-06.2 | collecting — 3 of 8 events | collecting — 3 of 8 events |  |
| ftl-elbo-beach-cam | 29 | 29 | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events | collecting — 3 of 8 events |
|  |  |  | 2026-10-15.1 | collecting — 2 of 8 events | +0.41 (n=21) |  |
|  |  |  | 2026-10-06.2 | collecting — 3 of 8 events | collecting — 3 of 8 events |  |
| jax-beach-bw-cam | 24 | 24 | 2026-11-05.1 | collecting — 4 of 8 events | collecting — 4 of 8 events | collecting — 1 of 8 events |
|  |  |  | 2026-10-15.1 | collecting — 1 of 8 events | -0.03 (n=20) |  |

### Gulf sunrises: the afterglow over the Gulf

The same check for west-facing Gulf cams at sunrise. The sun rises behind them, over the land, and they see the afterglow on the clouds over the Gulf.

| Cam | Afterglow readings | Matched to a forecast event | Model version | Forecast 30–120 min out vs afterglow | Call (60+ min out) vs afterglow | Satellite cloud away from the sun vs afterglow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fort-myers-beach-cam | 26 | 26 | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events | +0.21 (n=26) |
|  |  |  | 2026-10-15.1 | +0.05 (n=21) | +0.11 (n=21) |  |
| enco-shores-of-panama-cam | 25 | 25 | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events | +0.31 (n=19) |
|  |  |  | 2026-10-15.1 | +0.18 (n=19) | -0.31 (n=19) |  |
| margaritaville-fmb-cam | 25 | 25 | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events | +0.10 (n=25) |
|  |  |  | 2026-10-15.1 | +0.26 (n=19) | +0.34 (n=19) |  |
| sharkys-pcb-cam | 25 | 25 | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events | -0.26 (n=19) |
|  |  |  | 2026-10-15.1 | -0.10 (n=19) | +0.35 (n=19) |  |
| siesta-beach-cam | 25 | 25 | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events | -0.18 (n=25) |
|  |  |  | 2026-10-15.1 | +0.19 (n=19) | +0.19 (n=19) |  |
| sunset-grille-marathon-cam | 25 | 25 | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events | +0.15 (n=24) |
|  |  |  | 2026-10-15.1 | -0.08 (n=19) | -0.06 (n=19) |  |
| white-sands-ami-cam | 25 | 25 | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events | +0.66 (n=15) |
|  |  |  | 2026-10-15.1 | +0.14 (n=19) | +0.26 (n=19) |  |
| enco-sterling-reef-cam | 24 | 24 | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events | -0.28 (n=19) |
|  |  |  | 2026-10-15.1 | +0.03 (n=19) | +0.61 (n=19) |  |
| holmes-beach-cam | 24 | 24 | 2026-11-05.1 | collecting — 6 of 8 events | collecting — 6 of 8 events | -0.20 (n=14) |
|  |  |  | 2026-10-15.1 | -0.13 (n=18) | -0.11 (n=18) |  |
| fort-zachary-taylor-cam | 19 | 19 | 2026-10-15.1 | +0.07 (n=19) | +0.07 (n=19) | +0.15 (n=19) |
| pink-shell-fmb-cam | 19 | 19 | 2026-11-05.1 | collecting — 4 of 8 events | collecting — 4 of 8 events | +0.55 (n=19) |
|  |  |  | 2026-10-15.1 | +0.44 (n=15) | +0.48 (n=15) |  |
| pensacola-sria-west-cam | 14 | 14 | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events | -0.11 (n=8) |
|  |  |  | 2026-10-15.1 | -0.11 (n=9) | -0.11 (n=9) |  |

### What to fix next

Made from the numbers above by fixed rules (see docs/scorecards/README.md).

- Model 2026-11-05.1 runs low when it says Fair: bias -23.4 points on 17 events (raw camera scale).
- Model 2026-10-15.1 runs low when it says Poor: bias -21.9 points on 20 events (raw camera scale).
- Model 2026-10-15.1's Great calls land in the cam's own top 25% only 8% of the time (1 of 12); chance alone gives 25%.
- Sunrise coverage is low: 47% of 2009 past sunrises have a forecast 30–120 min before the event (937); of those with a camera reading, 112 of 116 (97%).
- Sunset coverage is low: 50% of 1984 past sunsets have a forecast 30–120 min before the event (991); of those with a camera reading, 31 of 151 (21%).
- Afterglow signal at enco-shores-of-panama-cam (sunrises): the satellite's mid/high cloud away from the sun has a rank correlation of +0.31 with the afterglow on 19 events. A candidate input for an afterglow forecast.
- Afterglow signal at white-sands-ami-cam (sunrises): the satellite's mid/high cloud away from the sun has a rank correlation of +0.66 with the afterglow on 15 events. A candidate input for an afterglow forecast.
- Afterglow signal at pink-shell-fmb-cam (sunrises): the satellite's mid/high cloud away from the sun has a rank correlation of +0.55 with the afterglow on 19 events. A candidate input for an afterglow forecast.

## Rain forecast

The app says "dry" or "raining" from a weather model, with a note on when that changes. We turn that into a forecast for one hour ahead and two hours ahead. "Dry, rain in 25 min" is a rain forecast for both. "Raining, easing in 25 min" is a dry forecast for both. A change at or before the hour has happened by then. Then we check each forecast against the radar reading one and two hours later. Radar rain means a rate above 0 mm/hr, or a fresh frame that saw rain at or near the beach in the last 20 minutes. A radar frame older than 25 minutes is not used.

- Hours with a rain call: 8849.
- Scored (radar available one and two hours later): 6287. Enough to score.
- Each rate needs enough cases in its own denominator (10 for the matrices, 30 for the headline); until then it shows "n=<count>, collecting".

Headline, the promise "Dry for the next 2+ hrs" (dry now, no rain forecast for 2 hours): 5631 calls scored; 942 saw radar rain within 2 hours (17%).

**Forecast one hour ahead, against radar one hour later**

| Forecast said | Radar saw rain | Radar saw no rain |
| --- | ---: | ---: |
| Rain | 171 | 152 |
| Dry | 804 | 5160 |

When we forecast rain: radar confirmed it 53% of the time, and did not 47%. Of the times radar saw rain, we had forecast dry 82%. Of our dry forecasts, 13% got rained on.

**Forecast two hours ahead, against radar two hours later**

| Forecast said | Radar saw rain | Radar saw no rain |
| --- | ---: | ---: |
| Rain | 211 | 261 |
| Dry | 741 | 5074 |

When we forecast rain: radar confirmed it 45% of the time, and did not 55%. Of the times radar saw rain, we had forecast dry 78%. Of our dry forecasts, 13% got rained on.

## Best time to go

Each morning the app names a best window for the beach. We take the window it named by 10 AM local time. Then we compare it with the hourly scores we archived for that day. Only a complete day counts: it must be over, have at least 8 scored daylight hours, have 80% of the daylight hours between its first and last archived hour, start within 2 hours of sunrise, and reach 5 PM local (or the last daylight hour). A day that fails this is censored: its archived hours cover only part of the day, so it has no honest best hour.

- Complete days: 0.
- Of those, with a window named by 10 AM: 0. Status: collecting — 0 of 10 days.
- Left out: 921 censored days (missing hours), 0 scored by two model versions (a deploy day), 63 still in progress, 0 with no early window. Outlook forecasts skipped across a model change: 0.

Days ahead: no outlook rows with a finished target day yet.

## Safety message and lifeguard flags

We compare our swim message (safe, caution, stay out) with the lifeguard flag that was flying. The City posts one flag a beach a day, so we count beach-days, not hours. A beach-day's flag is its most common flag. Our message is its most common swim level; a tie goes to the more serious one. Only beaches with a posted flag count.

- Beach-days with a swim message and a known flag: 30 (from 139 hourly rows). Enough to score.

### Swim message by flag (beach-days)

| Flag | Safe | Caution | Stay out |
| --- | ---: | ---: | ---: |
| double-red | 0 | 0 | 7 |
| red | 0 | 0 | 7 |
| yellow | 4 | 6 | 0 |
| green | 5 | 0 | 0 |
| purple | 0 | 1 | 0 |

A red or double-red flag sets "stay out" directly (lib/safetyLine.ts). Those rows say nothing about our own judgement. The next section leaves them out.

### Green and yellow flags only

- Beach-days: 15 (10 yellow, 5 green). Status: collecting — 15 of 30 beach-days.
- Agreement (yellow with caution or stay out, or green with safe): 11 of 15; rate n=15, collecting.
- Yellow flag, but we said safe: 4.
- Green flag, but we said caution or stay out: 0.

## Data health

- Beaches with rows in the last 7 days: 63.
- Extra data (the prediction blocks) is on 100% of rows in this report's window, 100% of the last 24 hours, and 100% of rows since the first one (2026-10-28 00Z).
- Share of the last 24 hours' extra rows with each block: window 74.3%, rain 100%, flags 100%, outlook 100%, safety 100%, rip 100%.
- Local hours missing on beaches that should archive all 24 (28 beaches, 168 beach-days): 9 (37.5% present), 10 (14.9% present), 11 (1.8% present), 12 (0% present), 13 (0% present), 14 (0% present), 15 (6% present), 16 (77.4% present), 17 (0% present), 18 (7.1% present). "Best time to go" cannot score these hours, and sunset forecasts close to the event are missing.
- Beaches under 12 rows a day (finished days, last 7 days), worst first. Auto-tier beaches archive daylight hours only, so their full count is the Expected column:

| Beach | Tier | Rows per day | Expected | Fewest in a day | Days counted |
| --- | ---: | ---: | ---: | ---: | ---: |
| santa-cruz | auto | 2.2 | 11 | 2 | 6 |
| seaside | auto | 2.2 | 11 | 2 | 6 |
| pismo-beach | auto | 2.2 | 10 | 2 | 6 |
| huntington-beach | auto | 3 | 10 | 3 | 6 |
| la-jolla | auto | 3 | 10 | 3 | 6 |
| long-beach | auto | 3 | 10 | 3 | 6 |
| santa-monica | auto | 3 | 10 | 3 | 6 |
| ocean-shores | auto | 2.8 | 9 | 2 | 6 |
| crescent-bay-park | auto | 3.3 | 10 | 3 | 6 |
| cannon-beach | auto | 3 | 9 | 3 | 6 |

  And 25 more (4 to 6 rows a day).

- Latest camera capture per beach (oldest first): key-west 137.2 h ago, jacksonville-beach 3 h ago, hobe-sound 2.7 h ago, hollywood-beach 2.3 h ago, jupiter 2.3 h ago, and 22 more. Silent for over 6 hours: key-west.
- Cameras hidden as offline (they come back on their own with the first good frame): 3
  - deerfield-spinner-uw (deerfield-beach): no good frame stored, last try Nov 11, 10:13 AM ET (blank)
  - deerfield-surf-cam (deerfield-beach): no good frame stored, last try Nov 11, 10:13 AM ET (blank)
  - fort-zachary-taylor-cam (key-west): offline since Nov 6, 11:08 AM ET, last good frame Nov 5, 8:08 PM ET, last try Nov 5, 2:00 PM ET
- Sun camera readings: 898; latest event 2026-11-11T12:11:08.924Z, scored 2026-11-11T12:57:56.218Z.
- Sun-color forecast rows in the last 24 hours: 1166.

---

Made by `npx vite-node -c vitest.config.ts scripts/scorecard.ts`. Read-only: it never writes to the database.
