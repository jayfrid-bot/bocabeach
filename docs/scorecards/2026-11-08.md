# Prediction scorecard — 2026-11-08

Data as of 2026-11-08 15:30 UTC. Hourly rows cover the last 14 days. Sun-color events cover the last 90 days; lifetime counts are shown in that section. A system with too little data says "collecting" and shows counts only. That is expected early on. See docs/scorecards/README.md for definitions and minimums.

> Warning: Some hourly rows are missing. The given account is not valid or is not authorized to access this service [code: 7403]

## At a glance

- **Sunrise and sunset color:** Model 2026-11-05.1 (live now): 21 pairs; fair rank correlation collecting — 3 of 8 pairs on the best cam; Great calls in the cam's own top 25%: n=1, collecting. Model 2026-10-15.1: 63 pairs; fair rank correlation +0.04 (61 events on 3 cams); Great calls in the cam's own top 25%: 2 of 12. Model 2026-10-06.2: collecting — 6 of 10 pairs (397 events with a forecast 30–120 min out). A forecast 30–120 min out exists for 748 of 1820 past sunrises (41%) and 802 of 1795 past sunsets (45%).
- **Rain forecast:** Of 4542 "dry for the next 2+ hrs" calls, 893 (20%) saw radar rain within 2 hours.
- **Best time to go:** collecting — 0 of 10 days. (0 complete days; 732 days left out for missing hours.)
- **Safety message and flags:** collecting — 24 of 30 beach-days. (9 beach-days with a green or yellow flag.)
- **Data health:** 63 beaches archiving. Extra data on 100% of the last 24 hours' rows. 35 beaches under 12 rows a day (0 of them curated). Beaches that should archive all day miss local hours 9, 10, 11, 12, 13, 14, 15, 16, 17, 18 on most days. 1 camera silent for over 6 hours. 3 cameras offline and hidden on the page.

## Sunrise and sunset color

We forecast the color of each sunrise and sunset. Then we compare with what the beach cameras saw. One pair is one event (one beach, one sunrise or sunset) that has both a forecast and a camera reading.

- Events loaded (with a scored forecast row or a camera reading), last 90 days: 3731.
- Pairs: 238 (3895 forecast rows). Enough to score.
- Lifetime: 3731 events and 37830 forecast rows logged since 2026-10-06; 4005 rows paired; 798 camera readings.
- Camera readings in the window: 798; 394 are afterglow (the cam looked away from the sun), kept but never scored; 11 matched no forecast row, so they cannot be scored.

### The fair grade, by model version

Each camera has its own raw scale. On the same sunsets Holmes Beach averages 74 and White Sands 5, so a raw 70 means different skies on different cams. The fair grade asks only about order inside one cam. It uses the forecast people see: the one closest to 60 minutes before the event, made 30 to 120 minutes ahead. Each event has one truth cam, the one the server picked: a cam that looks at the sun, the nearest one, then by cam id. Rank correlation runs from −1 to +1. 0 means no skill; a plus means our higher forecasts went with better skies on that cam. A cam counts once it has 8 pairs. The pooled number is the average over cams, weighted by each cam's pairs. A real Great is in that cam's own top 25% for that event kind, and a real Amazing in its top 10%. A version needs 10 pairs before it shows any number. Newest version first.

| Model version | Forecast rows loaded | Past events with a 30–120 min forecast | Pairs | Fair rank correlation | Sunrises | Sunsets | Great calls in the cam's top 25% | Amazing calls in the cam's top 10% | Raw typical miss (pts) | Raw bias (pts) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-11-05.1 (live now) | 942 | 324 | 21 | collecting — 3 of 8 pairs on the best cam | — | — | 1 of 1 (n=1, collecting) | 1 of 1 (n=1, collecting) | 28.7 | -3.1 |
| 2026-10-15.1 | 7179 | 829 | 63 | +0.04 (61 events, 3 cams) | +0.04 (n=61) | — | 2 of 12 (17%) | 1 of 8 (n=8, collecting) | 35.9 | +0.1 |
| 2026-10-06.2 | 1838 | 397 | 6 | collecting — 6 of 10 pairs | — | — | 0 of 0 (n=0, collecting) | 0 of 0 (n=0, collecting) | collecting — 6 of 10 pairs | — |

In the top-tier columns, "3 of 8" means 3 of our 8 Great calls landed in the cam's top 25%. Chance alone gives 25% (Amazing: 10%). A rate needs 10 calls; until then it shows "n=<count>, collecting". Only cams with 8+ events of their own have a scale.

Cams with fewer than 8 events of their own, so no scale yet (left out of the top-tier counts): white-sands-ami-cam (sunset, 1).

### Coverage of the forecast people see

How many past events have a forecast made 30 to 120 minutes before them. An event without one cannot enter the fair grade.

| Event | Past events | With a 30–120 min forecast | Share | With a camera reading | Of those, with the forecast | Share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Sunrise | 1820 | 748 | 41% | 104 | 100 | 96% |
| Sunset | 1795 | 802 | 45% | 134 | 14 | 10% |

### Rank correlation per cam

Our forecast (30–120 min out) against the cam's own score, by rank. Each cam needs 8 pairs. Boca Raton and Deerfield Beach share the Deerfield cams. Each reading counts once, for the beach nearest the cam (Deerfield Beach).

| Model version | Cam | Event | Pairs | Rank correlation |
| --- | ---: | ---: | ---: | ---: |
| 2026-11-05.1 (live now) | deerfield-beach-cam | Sunrise | 3 | collecting — 3 of 8 pairs |
| 2026-11-05.1 (live now) | ftl-elbo-beach-cam | Sunrise | 3 | collecting — 3 of 8 pairs |
| 2026-11-05.1 (live now) | jax-beach-bw-cam | Sunrise | 3 | collecting — 3 of 8 pairs |
| 2026-11-05.1 (live now) | enco-shores-of-panama-cam | Sunset | 2 | collecting — 2 of 8 pairs |
| 2026-11-05.1 (live now) | fort-myers-beach-cam | Sunset | 2 | collecting — 2 of 8 pairs |
| 2026-11-05.1 (live now) | holmes-beach-cam | Sunset | 2 | collecting — 2 of 8 pairs |
| 2026-11-05.1 (live now) | pensacola-sria-west-cam | Sunset | 2 | collecting — 2 of 8 pairs |
| 2026-11-05.1 (live now) | siesta-beach-cam | Sunset | 2 | collecting — 2 of 8 pairs |
| 2026-11-05.1 (live now) | sunset-grille-marathon-cam | Sunset | 2 | collecting — 2 of 8 pairs |
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
| 2026-11-05.1 (live now) | Fair (20–44) | 4 | collecting — 4 of 10 pairs | — |
| 2026-11-05.1 (live now) | Good (45–69) | 16 | 25.3 | +1.4 |
| 2026-11-05.1 (live now) | Amazing (90+) | 1 | collecting — 1 of 10 pairs | — |
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
| All pairs | 238 | 3895 | 37.0 | -18.2 |
| Lead: After the event (golden window) | 3 | 3 | collecting — 3 of 10 pairs | — |
| Lead: 0–2 h before | 114 | 213 | 35.4 | +1.3 |
| Lead: 2–6 h before | 102 | 404 | 30.5 | -8.6 |
| Lead: 6–12 h before | 237 | 1262 | 36.5 | -19.2 |
| Lead: 12–24 h before | 237 | 2013 | 38.8 | -21.5 |
| We said: Poor (under 20) | 152 | 1194 | 36.2 | -31.6 |
| We said: Fair (20–44) | 201 | 1887 | 37.5 | -29.1 |
| We said: Good (45–69) | 64 | 360 | 24.7 | +3.5 |
| We said: Great (70–89) | 49 | 119 | 34.8 | +29.9 |
| We said: Amazing (90+) | 76 | 335 | 51.2 | +50.8 |
| Beach: boca-raton | 27 | 420 | 31.4 | -13.6 |
| Beach: deerfield-beach | 27 | 480 | 33.8 | -19.3 |
| Beach: fort-lauderdale | 27 | 480 | 26.3 | -9.4 |
| Beach: fort-myers-beach | 23 | 384 | 46.1 | -30.6 |
| Beach: jacksonville-beach | 23 | 356 | 38.1 | +8.6 |
| Beach: anna-maria-island | 21 | 350 | 52.1 | -43.9 |
| Beach: marathon | 21 | 333 | 24.1 | +19.1 |
| Beach: panama-city-beach | 21 | 332 | 22.6 | -6.8 |
| Beach: siesta-key | 21 | 332 | 50.1 | -42.5 |
| Beach: key-west | 17 | 271 | 49.6 | -43.5 |
| Beach: pensacola-beach | 10 | 157 | 44.4 | -35.2 |
| Model version: 2026-11-05.1 | 24 | 358 | 25.8 | -5.7 |
| Model version: 2026-10-15.1 | 209 | 3330 | 38.2 | -18.4 |
| Model version: 2026-10-06.2 | 12 | 207 | 37.4 | -35.7 |
| Camera view: afterglow (not scored) | 6 | 110 | afterglow, not used as truth | — |
| Camera view: solar | 238 | 3895 | 37.0 | -18.2 |

### Our call versus what happened (raw camera scale)

The call is our last forecast made at least 60 minutes before the event. Great means 70 or more, on the forecast and on the RAW camera score. Amazing means 90 or more. Some cams give 70+ to most clear skies, so the raw "it happened" and "miss" counts here are mostly a property of the cam. The fair top-tier table above is the grade. Each rate needs 10 cases in its own denominator; until then it shows "n=<count>, collecting". 

|  | Great (70+) | Amazing (90+) |
| --- | ---: | ---: |
| Events with a call | 238 | 238 |
| We called it, and it happened (hit) | 7 | 0 |
| We called it, and it did not (false alarm) | 15 | 15 |
| It happened, and we did not call it (miss) | 91 | 27 |
| Neither | 125 | 196 |
| Hit rate (share of our calls that happened) | 32% | 0% |
| False-alarm rate (share of our calls that did not) | 68% | 100% |
| Miss rate (share of real ones we did not call) | 93% | 100% |

### How often we say Great or Amazing (camera columns on the raw scale)

The model is built so about 20% of events are Great or better, and about 10% are Amazing. Shares wait for 10 events in a row.

|  | Events | Forecast Great+ | Forecast Amazing | Paired events | Forecast Great+ (paired) | Camera Great+ | Camera Amazing |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Design target |  | 20% | 10% |  |  | 20% | 10% |
| All beaches | 3614 | 13% | 10% | 238 | 9% | 41% | 11% |
| anna-maria-island | 43 | 9% | 9% | 21 | 5% | 76% | 62% |
| asbury-park | 66 | 18% | 15% | 0 | — | — | — |
| biloxi | 66 | 21% | 18% | 0 | — | — | — |
| boca-raton | 66 | 14% | 9% | 27 | 7% | 37% | 0% |
| cannon-beach | 66 | 12% | 12% | 0 | — | — | — |
| cape-may | 66 | 14% | 12% | 0 | — | — | — |
| cocoa-beach | 66 | 11% | 6% | 0 | — | — | — |
| coney-island | 66 | 14% | 14% | 0 | — | — | — |
| crescent-bay-park | 66 | 8% | 6% | 0 | — | — | — |
| dania-beach | 43 | 5% | 5% | 0 | — | — | — |
| daytona-beach | 66 | 12% | 11% | 0 | — | — | — |
| deerfield-beach | 66 | 15% | 11% | 27 | 15% | 37% | 0% |
| dunlawton-beach | 43 | 9% | 7% | 0 | — | — | — |
| folly-beach | 66 | 14% | 14% | 0 | — | — | — |
| fort-lauderdale | 66 | 12% | 11% | 27 | 11% | 0% | 0% |
| fort-myers-beach | 47 | 9% | 9% | 23 | 13% | 70% | 4% |
| galveston | 66 | 14% | 14% | 0 | — | — | — |
| grand-isle | 66 | 27% | 21% | 0 | — | — | — |
| gulf-shores | 66 | 20% | 17% | 0 | — | — | — |
| hammonasset-beach | 66 | 20% | 18% | 0 | — | — | — |
| hampton-beach | 66 | 12% | 11% | 0 | — | — | — |
| hobe-sound | 43 | 9% | 5% | 0 | — | — | — |
| hollywood-beach | 43 | 16% | 9% | 0 | — | — | — |
| huntington-beach | 66 | 9% | 8% | 0 | — | — | — |
| jacksonville-beach | 67 | 6% | 6% | 23 | 4% | 22% | 13% |
| jensen-beach | 43 | 9% | 9% | 0 | — | — | — |
| jupiter | 43 | 5% | 2% | 0 | — | — | — |
| key-west | 43 | 9% | 5% | 17 | 6% | 82% | 35% |
| key-west-south | 43 | 12% | 5% | 0 | — | — | — |
| la-jolla | 66 | 12% | 11% | 0 | — | — | — |
| long-beach | 66 | 5% | 5% | 0 | — | — | — |
| marathon | 43 | 7% | 2% | 21 | 10% | 0% | 0% |
| miami-beach | 66 | 17% | 12% | 0 | — | — | — |
| misquamicut | 66 | 21% | 17% | 0 | — | — | — |
| montauk | 66 | 18% | 14% | 0 | — | — | — |
| myrtle-beach | 66 | 12% | 9% | 0 | — | — | — |
| nags-head | 66 | 17% | 15% | 0 | — | — | — |
| naples | 66 | 18% | 14% | 0 | — | — | — |
| new-smyrna-beach | 43 | 7% | 2% | 0 | — | — | — |
| ocean-shores | 66 | 20% | 15% | 0 | — | — | — |
| old-orchard-beach | 66 | 12% | 11% | 0 | — | — | — |
| ormond-beach | 43 | 9% | 2% | 0 | — | — | — |
| panama-city-beach | 43 | 14% | 9% | 21 | 14% | 0% | 0% |
| pensacola-beach | 47 | 19% | 15% | 10 | 10% | 90% | 10% |
| pismo-beach | 66 | 11% | 9% | 0 | — | — | — |
| ponce-inlet | 43 | 9% | 5% | 0 | — | — | — |
| rehoboth-beach | 66 | 15% | 12% | 0 | — | — | — |
| santa-cruz | 66 | 17% | 14% | 0 | — | — | — |
| santa-monica | 66 | 8% | 6% | 0 | — | — | — |
| seaside | 66 | 15% | 11% | 0 | — | — | — |
| sebastian-inlet | 43 | 7% | 7% | 0 | — | — | — |
| siesta-key | 43 | 7% | 5% | 21 | 5% | 86% | 14% |
| singer-island | 43 | 7% | 7% | 0 | — | — | — |
| sombrero-beach | 43 | 5% | 0% | 0 | — | — | — |
| south-padre-island | 66 | 15% | 9% | 0 | — | — | — |
| st-augustine-beach | 43 | 5% | 0% | 0 | — | — | — |
| stuart-bathtub-beach | 43 | 7% | 5% | 0 | — | — | — |
| tybee-island | 66 | 17% | 9% | 0 | — | — | — |
| vilano-beach | 43 | 2% | 2% | 0 | — | — | — |
| virginia-beach | 66 | 12% | 5% | 0 | — | — | — |
| wabasso-beach | 43 | 12% | 9% | 0 | — | — | — |
| waikiki | 65 | 23% | 12% | 0 | — | — | — |
| wrightsville-beach | 66 | 12% | 11% | 0 | — | — | — |

### East-coast sunsets: the afterglow over the ocean

An east-facing cam looks away from the sun at sunset. It sees the afterglow on the clouds over the ocean. On an east-coast beach that afterglow is what a beachgoer sees at sunset. These readings are never the truth for the sunset's color, and they are not in any number above. Here each cam is graded by rank only (Spearman, 8+ events per cell). The satellite column is the mid and high cloud along the path away from the sun (breakdown_json.satellite.antiMidHighPct). The satellite is read only within 60 minutes of the event, so only some events have it. It is evidence for a future afterglow forecast, not a grade.

| Cam | Afterglow readings | Matched to a forecast event | Model version | Forecast 30–120 min out vs afterglow | Call (60+ min out) vs afterglow | Satellite cloud away from the sun vs afterglow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| deerfield-beach-cam | 26 | 26 | 2026-11-05.1 | collecting — 2 of 8 events | collecting — 2 of 8 events | collecting — 3 of 8 events |
|  |  |  | 2026-10-15.1 | collecting — 2 of 8 events | +0.25 (n=21) |  |
|  |  |  | 2026-10-06.2 | collecting — 3 of 8 events | collecting — 3 of 8 events |  |
| deerfield-pier-cam | 26 | 26 | 2026-11-05.1 | collecting — 2 of 8 events | collecting — 2 of 8 events | collecting — 3 of 8 events |
|  |  |  | 2026-10-15.1 | collecting — 2 of 8 events | +0.16 (n=21) |  |
|  |  |  | 2026-10-06.2 | collecting — 3 of 8 events | collecting — 3 of 8 events |  |
| ftl-elbo-beach-cam | 26 | 26 | 2026-11-05.1 | collecting — 2 of 8 events | collecting — 2 of 8 events | collecting — 3 of 8 events |
|  |  |  | 2026-10-15.1 | collecting — 2 of 8 events | +0.41 (n=21) |  |
|  |  |  | 2026-10-06.2 | collecting — 3 of 8 events | collecting — 3 of 8 events |  |
| jax-beach-bw-cam | 21 | 21 | 2026-11-05.1 | collecting — 1 of 8 events | collecting — 1 of 8 events | collecting — 1 of 8 events |
|  |  |  | 2026-10-15.1 | collecting — 1 of 8 events | -0.03 (n=20) |  |

### Gulf sunrises: the afterglow over the Gulf

The same check for west-facing Gulf cams at sunrise. The sun rises behind them, over the land, and they see the afterglow on the clouds over the Gulf.

| Cam | Afterglow readings | Matched to a forecast event | Model version | Forecast 30–120 min out vs afterglow | Call (60+ min out) vs afterglow | Satellite cloud away from the sun vs afterglow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fort-myers-beach-cam | 23 | 23 | 2026-11-05.1 | collecting — 2 of 8 events | collecting — 2 of 8 events | +0.15 (n=23) |
|  |  |  | 2026-10-15.1 | +0.05 (n=21) | +0.11 (n=21) |  |
| enco-shores-of-panama-cam | 22 | 22 | 2026-11-05.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | +0.31 (n=19) |
|  |  |  | 2026-10-15.1 | +0.18 (n=19) | -0.31 (n=19) |  |
| margaritaville-fmb-cam | 22 | 22 | 2026-11-05.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | +0.01 (n=22) |
|  |  |  | 2026-10-15.1 | +0.26 (n=19) | +0.34 (n=19) |  |
| sharkys-pcb-cam | 22 | 22 | 2026-11-05.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | -0.26 (n=19) |
|  |  |  | 2026-10-15.1 | -0.10 (n=19) | +0.35 (n=19) |  |
| siesta-beach-cam | 22 | 22 | 2026-11-05.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | -0.23 (n=22) |
|  |  |  | 2026-10-15.1 | +0.19 (n=19) | +0.19 (n=19) |  |
| sunset-grille-marathon-cam | 22 | 22 | 2026-11-05.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | +0.27 (n=21) |
|  |  |  | 2026-10-15.1 | -0.08 (n=19) | -0.06 (n=19) |  |
| white-sands-ami-cam | 22 | 22 | 2026-11-05.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | +0.64 (n=12) |
|  |  |  | 2026-10-15.1 | +0.14 (n=19) | +0.26 (n=19) |  |
| enco-sterling-reef-cam | 21 | 21 | 2026-11-05.1 | collecting — 2 of 8 events | collecting — 2 of 8 events | -0.28 (n=19) |
|  |  |  | 2026-10-15.1 | +0.03 (n=19) | +0.61 (n=19) |  |
| holmes-beach-cam | 21 | 21 | 2026-11-05.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | -0.10 (n=11) |
|  |  |  | 2026-10-15.1 | -0.13 (n=18) | -0.11 (n=18) |  |
| fort-zachary-taylor-cam | 19 | 19 | 2026-10-15.1 | +0.07 (n=19) | +0.07 (n=19) | +0.15 (n=19) |
| pink-shell-fmb-cam | 16 | 16 | 2026-11-05.1 | collecting — 1 of 8 events | collecting — 1 of 8 events | +0.52 (n=16) |
|  |  |  | 2026-10-15.1 | +0.44 (n=15) | +0.48 (n=15) |  |
| pensacola-sria-west-cam | 11 | 11 | 2026-11-05.1 | collecting — 2 of 8 events | collecting — 2 of 8 events | -0.11 (n=8) |
|  |  |  | 2026-10-15.1 | -0.11 (n=9) | -0.11 (n=9) |  |

### What to fix next

Made from the numbers above by fixed rules (see docs/scorecards/README.md).

- Model 2026-10-15.1 runs low when it says Poor: bias -21.9 points on 20 events (raw camera scale).
- Model 2026-10-15.1's Great calls land in the cam's own top 25% only 17% of the time (2 of 12); chance alone gives 25%.
- Sunrise coverage is low: 41% of 1820 past sunrises have a forecast 30–120 min before the event (748); of those with a camera reading, 100 of 104 (96%).
- Sunset coverage is low: 45% of 1795 past sunsets have a forecast 30–120 min before the event (802); of those with a camera reading, 14 of 134 (10%).
- Afterglow signal at enco-shores-of-panama-cam (sunrises): the satellite's mid/high cloud away from the sun has a rank correlation of +0.31 with the afterglow on 19 events. A candidate input for an afterglow forecast.
- Afterglow signal at pink-shell-fmb-cam (sunrises): the satellite's mid/high cloud away from the sun has a rank correlation of +0.52 with the afterglow on 16 events. A candidate input for an afterglow forecast.

## Rain forecast

The app says "dry" or "raining" from a weather model, with a note on when that changes. We turn that into a forecast for one hour ahead and two hours ahead. "Dry, rain in 25 min" is a rain forecast for both. "Raining, easing in 25 min" is a dry forecast for both. A change at or before the hour has happened by then. Then we check each forecast against the radar reading one and two hours later. Radar rain means a rate above 0 mm/hr, or a fresh frame that saw rain at or near the beach in the last 20 minutes. A radar frame older than 25 minutes is not used.

- Hours with a rain call: 7096.
- Scored (radar available one and two hours later): 5163. Enough to score.
- Each rate needs enough cases in its own denominator (10 for the matrices, 30 for the headline); until then it shows "n=<count>, collecting".

Headline, the promise "Dry for the next 2+ hrs" (dry now, no rain forecast for 2 hours): 4542 calls scored; 893 saw radar rain within 2 hours (20%).

**Forecast one hour ahead, against radar one hour later**

| Forecast said | Radar saw rain | Radar saw no rain |
| --- | ---: | ---: |
| Rain | 169 | 137 |
| Dry | 772 | 4085 |

When we forecast rain: radar confirmed it 55% of the time, and did not 45%. Of the times radar saw rain, we had forecast dry 82%. Of our dry forecasts, 16% got rained on.

**Forecast two hours ahead, against radar two hours later**

| Forecast said | Radar saw rain | Radar saw no rain |
| --- | ---: | ---: |
| Rain | 209 | 238 |
| Dry | 705 | 4011 |

When we forecast rain: radar confirmed it 47% of the time, and did not 53%. Of the times radar saw rain, we had forecast dry 77%. Of our dry forecasts, 15% got rained on.

## Best time to go

Each morning the app names a best window for the beach. We take the window it named by 10 AM local time. Then we compare it with the hourly scores we archived for that day. Only a complete day counts: it must be over, have at least 8 scored daylight hours, have 80% of the daylight hours between its first and last archived hour, start within 2 hours of sunrise, and reach 5 PM local (or the last daylight hour). A day that fails this is censored: its archived hours cover only part of the day, so it has no honest best hour.

- Complete days: 0.
- Of those, with a window named by 10 AM: 0. Status: collecting — 0 of 10 days.
- Left out: 732 censored days (missing hours), 0 scored by two model versions (a deploy day), 63 still in progress, 0 with no early window. Outlook forecasts skipped across a model change: 0.

Days ahead: no outlook rows with a finished target day yet.

## Safety message and lifeguard flags

We compare our swim message (safe, caution, stay out) with the lifeguard flag that was flying. The City posts one flag a beach a day, so we count beach-days, not hours. A beach-day's flag is its most common flag. Our message is its most common swim level; a tie goes to the more serious one. Only beaches with a posted flag count.

- Beach-days with a swim message and a known flag: 24 (from 115 hourly rows). Status: collecting — 24 of 30 beach-days.

### Swim message by flag (beach-days)

| Flag | Safe | Caution | Stay out |
| --- | ---: | ---: | ---: |
| double-red | 0 | 0 | 7 |
| red | 0 | 0 | 7 |
| yellow | 4 | 3 | 0 |
| green | 2 | 0 | 0 |
| purple | 0 | 1 | 0 |

A red or double-red flag sets "stay out" directly (lib/safetyLine.ts). Those rows say nothing about our own judgement. The next section leaves them out.

### Green and yellow flags only

- Beach-days: 9 (7 yellow, 2 green). Status: collecting — 9 of 30 beach-days.
- Agreement (yellow with caution or stay out, or green with safe): 5 of 9; rate n=9, collecting.
- Yellow flag, but we said safe: 4.
- Green flag, but we said caution or stay out: 0.

## Data health

- Beaches with rows in the last 7 days: 63.
- Extra data (the prediction blocks) is on 100% of rows in this report's window, 100% of the last 24 hours, and 100% of rows since the first one (2026-10-28 00Z).
- Share of the last 24 hours' extra rows with each block: window 74.4%, rain 100%, flags 100%, outlook 100%, safety 100%, rip 100%.
- Local hours missing on beaches that should archive all 24 (28 beaches, 168 beach-days): 9 (75% present), 10 (59.5% present), 11 (7.1% present), 12 (0% present), 13 (0% present), 14 (0% present), 15 (2.4% present), 16 (31% present), 17 (0% present), 18 (7.1% present). "Best time to go" cannot score these hours, and sunset forecasts close to the event are missing.
- Beaches under 12 rows a day (finished days, last 7 days), worst first. Auto-tier beaches archive daylight hours only, so their full count is the Expected column:

| Beach | Tier | Rows per day | Expected | Fewest in a day | Days counted |
| --- | ---: | ---: | ---: | ---: | ---: |
| pismo-beach | auto | 2.7 | 11 | 2 | 6 |
| santa-cruz | auto | 2.7 | 11 | 2 | 6 |
| seaside | auto | 2.7 | 11 | 2 | 6 |
| ocean-shores | auto | 2.3 | 9 | 2 | 6 |
| huntington-beach | auto | 3 | 10 | 3 | 6 |
| la-jolla | auto | 3 | 10 | 3 | 6 |
| long-beach | auto | 3 | 10 | 3 | 6 |
| santa-monica | auto | 3 | 10 | 3 | 6 |
| crescent-bay-park | auto | 3.3 | 10 | 3 | 6 |
| south-padre-island | auto | 4 | 11 | 4 | 5 |

  And 25 more (3.3 to 6 rows a day).

- Latest camera capture per beach (oldest first): key-west 65.2 h ago, jacksonville-beach 3 h ago, sombrero-beach 2.5 h ago, hollywood-beach 2.3 h ago, jensen-beach 2.3 h ago, and 22 more. Silent for over 6 hours: key-west.
- Cameras hidden as offline (they come back on their own with the first good frame): 3
  - deerfield-spinner-uw (deerfield-beach): no good frame stored, last try Nov 8, 10:13 AM ET (blank)
  - deerfield-surf-cam (deerfield-beach): no good frame stored, last try Nov 8, 10:13 AM ET (blank)
  - fort-zachary-taylor-cam (key-west): offline since Nov 6, 11:08 AM ET, last good frame Nov 5, 8:08 PM ET, last try Nov 5, 2:00 PM ET
- Sun camera readings: 798; latest event 2026-11-08T12:08:41.228Z, scored 2026-11-08T12:59:24.033Z.
- Sun-color forecast rows in the last 24 hours: 1170.

---

Made by `npx vite-node -c vitest.config.ts scripts/scorecard.ts`. Read-only: it never writes to the database.
