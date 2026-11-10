# Prediction scorecard — 2026-11-10

Data as of 2026-11-10 15:30 UTC. Hourly rows cover the last 14 days. Sun-color events cover the last 90 days; lifetime counts are shown in that section. A system with too little data says "collecting" and shows counts only. That is expected early on. See docs/scorecards/README.md for definitions and minimums.

## At a glance

- **Sunrise and sunset color:** Model 2026-11-05.1 (live now): 38 pairs; fair rank correlation collecting — 5 of 8 pairs on the best cam; Great calls in the cam's own top 25%: n=4, collecting. Model 2026-10-15.1: 63 pairs; fair rank correlation +0.04 (61 events on 3 cams); Great calls in the cam's own top 25%: 1 of 12. Model 2026-10-06.2: collecting — 6 of 10 pairs (397 events with a forecast 30–120 min out). A forecast 30–120 min out exists for 874 of 1946 past sunrises (45%) and 928 of 1921 past sunsets (48%).
- **Rain forecast:** Of 5710 "dry for the next 2+ hrs" calls, 992 (17%) saw radar rain within 2 hours.
- **Best time to go:** collecting — 0 of 10 days. (0 complete days; 921 days left out for missing hours.)
- **Safety message and flags:** 30 beach-days with a flag. Green/yellow agreement: collecting — 13 of 30 beach-days.
- **Data health:** 63 beaches archiving. Extra data on 100% of the last 24 hours' rows. 35 beaches under 12 rows a day (0 of them curated). Beaches that should archive all day miss local hours 9, 10, 11, 12, 13, 14, 15, 16, 17, 18 on most days. 27 cameras silent for over 6 hours. 3 cameras offline and hidden on the page.

## Sunrise and sunset color

We forecast the color of each sunrise and sunset. Then we compare with what the beach cameras saw. One pair is one event (one beach, one sunrise or sunset) that has both a forecast and a camera reading.

- Events loaded (with a scored forecast row or a camera reading), last 90 days: 3983.
- Pairs: 257 (4190 forecast rows). Enough to score.
- Lifetime: 3983 events and 40170 forecast rows logged since 2026-10-06; 4300 rows paired; 864 camera readings.
- Camera readings in the window: 864; 428 are afterglow (the cam looked away from the sun), kept but never scored; 11 matched no forecast row, so they cannot be scored.

### The fair grade, by model version

Each camera has its own raw scale. On the same sunsets Holmes Beach averages 74 and White Sands 5, so a raw 70 means different skies on different cams. The fair grade asks only about order inside one cam. It uses the forecast people see: the one closest to 60 minutes before the event, made 30 to 120 minutes ahead. Each event has one truth cam, the one the server picked: a cam that looks at the sun, the nearest one, then by cam id. Rank correlation runs from −1 to +1. 0 means no skill; a plus means our higher forecasts went with better skies on that cam. A cam counts once it has 8 pairs. The pooled number is the average over cams, weighted by each cam's pairs. A real Great is in that cam's own top 25% for that event kind, and a real Amazing in its top 10%. A version needs 10 pairs before it shows any number. Newest version first.

| Model version | Forecast rows loaded | Past events with a 30–120 min forecast | Pairs | Fair rank correlation | Sunrises | Sunsets | Great calls in the cam's top 25% | Amazing calls in the cam's top 10% | Raw typical miss (pts) | Raw bias (pts) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-11-05.1 (live now) | 1586 | 576 | 38 | collecting — 5 of 8 pairs on the best cam | — | — | 2 of 4 (n=4, collecting) | 1 of 2 (n=2, collecting) | 28.6 | -6.9 |
| 2026-10-15.1 | 7179 | 829 | 63 | +0.04 (61 events, 3 cams) | +0.04 (n=61) | — | 1 of 12 (8%) | 0 of 8 (n=8, collecting) | 35.9 | +0.1 |
| 2026-10-06.2 | 1838 | 397 | 6 | collecting — 6 of 10 pairs | — | — | 0 of 0 (n=0, collecting) | 0 of 0 (n=0, collecting) | collecting — 6 of 10 pairs | — |

In the top-tier columns, "3 of 8" means 3 of our 8 Great calls landed in the cam's top 25%. Chance alone gives 25% (Amazing: 10%). A rate needs 10 calls; until then it shows "n=<count>, collecting". Only cams with 8+ events of their own have a scale.

Cams with fewer than 8 events of their own, so no scale yet (left out of the top-tier counts): white-sands-ami-cam (sunset, 1).

### Coverage of the forecast people see

How many past events have a forecast made 30 to 120 minutes before them. An event without one cannot enter the fair grade.

| Event | Past events | With a 30–120 min forecast | Share | With a camera reading | Of those, with the forecast | Share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Sunrise | 1946 | 874 | 45% | 112 | 108 | 96% |
| Sunset | 1921 | 928 | 48% | 145 | 25 | 17% |

### Rank correlation per cam

Our forecast (30–120 min out) against the cam's own score, by rank. Each cam needs 8 pairs. Boca Raton and Deerfield Beach share the Deerfield cams. Each reading counts once, for the beach nearest the cam (Deerfield Beach).

| Model version | Cam | Event | Pairs | Rank correlation |
| --- | ---: | ---: | ---: | ---: |
| 2026-11-05.1 (live now) | deerfield-beach-cam | Sunrise | 5 | collecting — 5 of 8 pairs |
| 2026-11-05.1 (live now) | ftl-elbo-beach-cam | Sunrise | 5 | collecting — 5 of 8 pairs |
| 2026-11-05.1 (live now) | jax-beach-bw-cam | Sunrise | 5 | collecting — 5 of 8 pairs |
| 2026-11-05.1 (live now) | enco-shores-of-panama-cam | Sunset | 4 | collecting — 4 of 8 pairs |
| 2026-11-05.1 (live now) | fort-myers-beach-cam | Sunset | 4 | collecting — 4 of 8 pairs |
| 2026-11-05.1 (live now) | holmes-beach-cam | Sunset | 4 | collecting — 4 of 8 pairs |
| 2026-11-05.1 (live now) | siesta-beach-cam | Sunset | 4 | collecting — 4 of 8 pairs |
| 2026-11-05.1 (live now) | sunset-grille-marathon-cam | Sunset | 4 | collecting — 4 of 8 pairs |
| 2026-11-05.1 (live now) | pensacola-sria-west-cam | Sunset | 3 | collecting — 3 of 8 pairs |
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
| 2026-11-05.1 (live now) | Fair (20–44) | 9 | collecting — 9 of 10 pairs | — |
| 2026-11-05.1 (live now) | Good (45–69) | 25 | 26.7 | +1.4 |
| 2026-11-05.1 (live now) | Great (70–89) | 2 | collecting — 2 of 10 pairs | — |
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
| All pairs | 257 | 4190 | 36.7 | -18.2 |
| Lead: After the event (golden window) | 3 | 3 | collecting — 3 of 10 pairs | — |
| Lead: 0–2 h before | 133 | 240 | 34.4 | +0.1 |
| Lead: 2–6 h before | 110 | 436 | 30.6 | -9.7 |
| Lead: 6–12 h before | 256 | 1349 | 36.5 | -19.5 |
| Lead: 12–24 h before | 256 | 2162 | 38.3 | -21.1 |
| We said: Poor (under 20) | 152 | 1194 | 36.2 | -31.6 |
| We said: Fair (20–44) | 219 | 2016 | 37.8 | -29.9 |
| We said: Good (45–69) | 81 | 472 | 24.8 | +1.7 |
| We said: Great (70–89) | 59 | 155 | 33.3 | +25.7 |
| We said: Amazing (90+) | 79 | 353 | 49.4 | +48.5 |
| Beach: boca-raton | 29 | 452 | 31.0 | -14.0 |
| Beach: deerfield-beach | 29 | 512 | 33.5 | -19.1 |
| Beach: fort-lauderdale | 29 | 512 | 25.5 | -8.9 |
| Beach: fort-myers-beach | 25 | 416 | 45.1 | -30.8 |
| Beach: jacksonville-beach | 25 | 386 | 40.4 | +2.6 |
| Beach: anna-maria-island | 23 | 382 | 51.2 | -43.8 |
| Beach: marathon | 23 | 363 | 26.0 | +21.4 |
| Beach: panama-city-beach | 23 | 362 | 21.9 | -5.8 |
| Beach: siesta-key | 23 | 362 | 48.2 | -41.2 |
| Beach: key-west | 17 | 271 | 49.6 | -43.5 |
| Beach: pensacola-beach | 11 | 172 | 42.9 | -34.4 |
| Model version: 2026-11-05.1 | 43 | 653 | 29.0 | -11.3 |
| Model version: 2026-10-15.1 | 209 | 3330 | 38.2 | -18.4 |
| Model version: 2026-10-06.2 | 12 | 207 | 37.4 | -35.7 |
| Camera view: afterglow (not scored) | 6 | 110 | afterglow, not used as truth | — |
| Camera view: solar | 257 | 4190 | 36.7 | -18.2 |

### Our call versus what happened (raw camera scale)

The call is our last forecast made at least 60 minutes before the event. Great means 70 or more, on the forecast and on the RAW camera score. Amazing means 90 or more. Some cams give 70+ to most clear skies, so the raw "it happened" and "miss" counts here are mostly a property of the cam. The fair top-tier table above is the grade. Each rate needs 10 cases in its own denominator; until then it shows "n=<count>, collecting". 

|  | Great (70+) | Amazing (90+) |
| --- | ---: | ---: |
| Events with a call | 257 | 257 |
| We called it, and it happened (hit) | 10 | 1 |
| We called it, and it did not (false alarm) | 15 | 15 |
| It happened, and we did not call it (miss) | 99 | 34 |
| Neither | 133 | 207 |
| Hit rate (share of our calls that happened) | 40% | 6% |
| False-alarm rate (share of our calls that did not) | 60% | 94% |
| Miss rate (share of real ones we did not call) | 91% | 97% |

### How often we say Great or Amazing (camera columns on the raw scale)

The model is built so about 20% of events are Great or better, and about 10% are Amazing. Shares wait for 10 events in a row.

|  | Events | Forecast Great+ | Forecast Amazing | Paired events | Forecast Great+ (paired) | Camera Great+ | Camera Amazing |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Design target |  | 20% | 10% |  |  | 20% | 10% |
| All beaches | 3866 | 13% | 9% | 257 | 10% | 42% | 14% |
| anna-maria-island | 47 | 11% | 11% | 23 | 9% | 78% | 65% |
| asbury-park | 70 | 17% | 14% | 0 | — | — | — |
| biloxi | 70 | 20% | 17% | 0 | — | — | — |
| boca-raton | 70 | 13% | 9% | 29 | 7% | 38% | 3% |
| cannon-beach | 70 | 11% | 11% | 0 | — | — | — |
| cape-may | 70 | 13% | 11% | 0 | — | — | — |
| cocoa-beach | 70 | 10% | 6% | 0 | — | — | — |
| coney-island | 70 | 13% | 13% | 0 | — | — | — |
| crescent-bay-park | 70 | 7% | 6% | 0 | — | — | — |
| dania-beach | 47 | 4% | 4% | 0 | — | — | — |
| daytona-beach | 70 | 11% | 10% | 0 | — | — | — |
| deerfield-beach | 70 | 14% | 10% | 29 | 14% | 38% | 3% |
| dunlawton-beach | 47 | 11% | 6% | 0 | — | — | — |
| folly-beach | 70 | 14% | 13% | 0 | — | — | — |
| fort-lauderdale | 70 | 11% | 10% | 29 | 10% | 0% | 0% |
| fort-myers-beach | 51 | 10% | 8% | 25 | 12% | 72% | 12% |
| galveston | 70 | 13% | 13% | 0 | — | — | — |
| grand-isle | 70 | 26% | 20% | 0 | — | — | — |
| gulf-shores | 70 | 19% | 16% | 0 | — | — | — |
| hammonasset-beach | 70 | 20% | 19% | 0 | — | — | — |
| hampton-beach | 70 | 11% | 10% | 0 | — | — | — |
| hobe-sound | 47 | 11% | 4% | 0 | — | — | — |
| hollywood-beach | 47 | 15% | 9% | 0 | — | — | — |
| huntington-beach | 70 | 9% | 7% | 0 | — | — | — |
| jacksonville-beach | 71 | 6% | 6% | 25 | 4% | 28% | 20% |
| jensen-beach | 47 | 11% | 9% | 0 | — | — | — |
| jupiter | 47 | 6% | 4% | 0 | — | — | — |
| key-west | 47 | 11% | 4% | 17 | 6% | 82% | 35% |
| key-west-south | 47 | 13% | 4% | 0 | — | — | — |
| la-jolla | 70 | 11% | 10% | 0 | — | — | — |
| long-beach | 70 | 4% | 4% | 0 | — | — | — |
| marathon | 47 | 6% | 2% | 23 | 9% | 0% | 0% |
| miami-beach | 70 | 16% | 11% | 0 | — | — | — |
| misquamicut | 70 | 21% | 16% | 0 | — | — | — |
| montauk | 70 | 19% | 14% | 0 | — | — | — |
| myrtle-beach | 70 | 11% | 9% | 0 | — | — | — |
| nags-head | 70 | 16% | 14% | 0 | — | — | — |
| naples | 70 | 19% | 13% | 0 | — | — | — |
| new-smyrna-beach | 47 | 9% | 2% | 0 | — | — | — |
| ocean-shores | 70 | 19% | 14% | 0 | — | — | — |
| old-orchard-beach | 70 | 13% | 11% | 0 | — | — | — |
| ormond-beach | 47 | 11% | 4% | 0 | — | — | — |
| panama-city-beach | 47 | 15% | 9% | 23 | 13% | 0% | 0% |
| pensacola-beach | 51 | 22% | 16% | 11 | 18% | 91% | 9% |
| pismo-beach | 70 | 11% | 9% | 0 | — | — | — |
| ponce-inlet | 47 | 11% | 4% | 0 | — | — | — |
| rehoboth-beach | 70 | 14% | 11% | 0 | — | — | — |
| santa-cruz | 70 | 16% | 13% | 0 | — | — | — |
| santa-monica | 70 | 7% | 6% | 0 | — | — | — |
| seaside | 70 | 14% | 10% | 0 | — | — | — |
| sebastian-inlet | 47 | 9% | 6% | 0 | — | — | — |
| siesta-key | 47 | 11% | 6% | 23 | 9% | 87% | 13% |
| singer-island | 47 | 6% | 6% | 0 | — | — | — |
| sombrero-beach | 47 | 4% | 0% | 0 | — | — | — |
| south-padre-island | 70 | 16% | 9% | 0 | — | — | — |
| st-augustine-beach | 47 | 4% | 0% | 0 | — | — | — |
| stuart-bathtub-beach | 47 | 9% | 4% | 0 | — | — | — |
| tybee-island | 70 | 17% | 9% | 0 | — | — | — |
| vilano-beach | 47 | 4% | 2% | 0 | — | — | — |
| virginia-beach | 70 | 11% | 4% | 0 | — | — | — |
| wabasso-beach | 47 | 13% | 9% | 0 | — | — | — |
| waikiki | 69 | 26% | 12% | 0 | — | — | — |
| wrightsville-beach | 70 | 11% | 10% | 0 | — | — | — |

### East-coast sunsets: the afterglow over the ocean

An east-facing cam looks away from the sun at sunset. It sees the afterglow on the clouds over the ocean. On an east-coast beach that afterglow is what a beachgoer sees at sunset. These readings are never the truth for the sunset's color, and they are not in any number above. Here each cam is graded by rank only (Spearman, 8+ events per cell). The satellite column is the mid and high cloud along the path away from the sun (breakdown_json.satellite.antiMidHighPct). The satellite is read only within 60 minutes of the event, so only some events have it. It is evidence for a future afterglow forecast, not a grade.

| Cam | Afterglow readings | Matched to a forecast event | Model version | Forecast 30–120 min out vs afterglow | Call (60+ min out) vs afterglow | Satellite cloud away from the sun vs afterglow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| deerfield-beach-cam | 28 | 28 | 2026-11-05.1 | collecting — 4 of 8 events | collecting — 4 of 8 events | collecting — 3 of 8 events |
|  |  |  | 2026-10-15.1 | collecting — 2 of 8 events | +0.25 (n=21) |  |
|  |  |  | 2026-10-06.2 | collecting — 3 of 8 events | collecting — 3 of 8 events |  |
| deerfield-pier-cam | 28 | 28 | 2026-11-05.1 | collecting — 4 of 8 events | collecting — 4 of 8 events | collecting — 3 of 8 events |
|  |  |  | 2026-10-15.1 | collecting — 2 of 8 events | +0.16 (n=21) |  |
|  |  |  | 2026-10-06.2 | collecting — 3 of 8 events | collecting — 3 of 8 events |  |
| ftl-elbo-beach-cam | 28 | 28 | 2026-11-05.1 | collecting — 4 of 8 events | collecting — 4 of 8 events | collecting — 3 of 8 events |
|  |  |  | 2026-10-15.1 | collecting — 2 of 8 events | +0.41 (n=21) |  |
|  |  |  | 2026-10-06.2 | collecting — 3 of 8 events | collecting — 3 of 8 events |  |
| jax-beach-bw-cam | 23 | 23 | 2026-11-05.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | collecting — 1 of 8 events |
|  |  |  | 2026-10-15.1 | collecting — 1 of 8 events | -0.03 (n=20) |  |

### Gulf sunrises: the afterglow over the Gulf

The same check for west-facing Gulf cams at sunrise. The sun rises behind them, over the land, and they see the afterglow on the clouds over the Gulf.

| Cam | Afterglow readings | Matched to a forecast event | Model version | Forecast 30–120 min out vs afterglow | Call (60+ min out) vs afterglow | Satellite cloud away from the sun vs afterglow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fort-myers-beach-cam | 25 | 25 | 2026-11-05.1 | collecting — 4 of 8 events | collecting — 4 of 8 events | +0.19 (n=25) |
|  |  |  | 2026-10-15.1 | +0.05 (n=21) | +0.11 (n=21) |  |
| enco-shores-of-panama-cam | 24 | 24 | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events | +0.31 (n=19) |
|  |  |  | 2026-10-15.1 | +0.18 (n=19) | -0.31 (n=19) |  |
| margaritaville-fmb-cam | 24 | 24 | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events | +0.03 (n=24) |
|  |  |  | 2026-10-15.1 | +0.26 (n=19) | +0.34 (n=19) |  |
| sharkys-pcb-cam | 24 | 24 | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events | -0.26 (n=19) |
|  |  |  | 2026-10-15.1 | -0.10 (n=19) | +0.35 (n=19) |  |
| siesta-beach-cam | 24 | 24 | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events | -0.29 (n=24) |
|  |  |  | 2026-10-15.1 | +0.19 (n=19) | +0.19 (n=19) |  |
| sunset-grille-marathon-cam | 24 | 24 | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events | +0.14 (n=23) |
|  |  |  | 2026-10-15.1 | -0.08 (n=19) | -0.06 (n=19) |  |
| white-sands-ami-cam | 24 | 24 | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events | +0.66 (n=14) |
|  |  |  | 2026-10-15.1 | +0.14 (n=19) | +0.26 (n=19) |  |
| enco-sterling-reef-cam | 23 | 23 | 2026-11-05.1 | collecting — 4 of 8 events | collecting — 4 of 8 events | -0.28 (n=19) |
|  |  |  | 2026-10-15.1 | +0.03 (n=19) | +0.61 (n=19) |  |
| holmes-beach-cam | 23 | 23 | 2026-11-05.1 | collecting — 5 of 8 events | collecting — 5 of 8 events | -0.11 (n=13) |
|  |  |  | 2026-10-15.1 | -0.13 (n=18) | -0.11 (n=18) |  |
| fort-zachary-taylor-cam | 19 | 19 | 2026-10-15.1 | +0.07 (n=19) | +0.07 (n=19) | +0.15 (n=19) |
| pink-shell-fmb-cam | 18 | 18 | 2026-11-05.1 | collecting — 3 of 8 events | collecting — 3 of 8 events | +0.52 (n=18) |
|  |  |  | 2026-10-15.1 | +0.44 (n=15) | +0.48 (n=15) |  |
| pensacola-sria-west-cam | 13 | 13 | 2026-11-05.1 | collecting — 4 of 8 events | collecting — 4 of 8 events | -0.11 (n=8) |
|  |  |  | 2026-10-15.1 | -0.11 (n=9) | -0.11 (n=9) |  |

### What to fix next

Made from the numbers above by fixed rules (see docs/scorecards/README.md).

- Model 2026-10-15.1 runs low when it says Poor: bias -21.9 points on 20 events (raw camera scale).
- Model 2026-10-15.1's Great calls land in the cam's own top 25% only 8% of the time (1 of 12); chance alone gives 25%.
- Sunrise coverage is low: 45% of 1946 past sunrises have a forecast 30–120 min before the event (874); of those with a camera reading, 108 of 112 (96%).
- Sunset coverage is low: 48% of 1921 past sunsets have a forecast 30–120 min before the event (928); of those with a camera reading, 25 of 145 (17%).
- Afterglow signal at enco-shores-of-panama-cam (sunrises): the satellite's mid/high cloud away from the sun has a rank correlation of +0.31 with the afterglow on 19 events. A candidate input for an afterglow forecast.
- Afterglow signal at pink-shell-fmb-cam (sunrises): the satellite's mid/high cloud away from the sun has a rank correlation of +0.52 with the afterglow on 18 events. A candidate input for an afterglow forecast.

## Rain forecast

The app says "dry" or "raining" from a weather model, with a note on when that changes. We turn that into a forecast for one hour ahead and two hours ahead. "Dry, rain in 25 min" is a rain forecast for both. "Raining, easing in 25 min" is a dry forecast for both. A change at or before the hour has happened by then. Then we check each forecast against the radar reading one and two hours later. Radar rain means a rate above 0 mm/hr, or a fresh frame that saw rain at or near the beach in the last 20 minutes. A radar frame older than 25 minutes is not used.

- Hours with a rain call: 8866.
- Scored (radar available one and two hours later): 6387. Enough to score.
- Each rate needs enough cases in its own denominator (10 for the matrices, 30 for the headline); until then it shows "n=<count>, collecting".

Headline, the promise "Dry for the next 2+ hrs" (dry now, no rain forecast for 2 hours): 5710 calls scored; 992 saw radar rain within 2 hours (17%).

**Forecast one hour ahead, against radar one hour later**

| Forecast said | Radar saw rain | Radar saw no rain |
| --- | ---: | ---: |
| Rain | 171 | 162 |
| Dry | 839 | 5215 |

When we forecast rain: radar confirmed it 51% of the time, and did not 49%. Of the times radar saw rain, we had forecast dry 83%. Of our dry forecasts, 14% got rained on.

**Forecast two hours ahead, against radar two hours later**

| Forecast said | Radar saw rain | Radar saw no rain |
| --- | ---: | ---: |
| Rain | 216 | 270 |
| Dry | 771 | 5130 |

When we forecast rain: radar confirmed it 44% of the time, and did not 56%. Of the times radar saw rain, we had forecast dry 78%. Of our dry forecasts, 13% got rained on.

## Best time to go

Each morning the app names a best window for the beach. We take the window it named by 10 AM local time. Then we compare it with the hourly scores we archived for that day. Only a complete day counts: it must be over, have at least 8 scored daylight hours, have 80% of the daylight hours between its first and last archived hour, start within 2 hours of sunrise, and reach 5 PM local (or the last daylight hour). A day that fails this is censored: its archived hours cover only part of the day, so it has no honest best hour.

- Complete days: 0.
- Of those, with a window named by 10 AM: 0. Status: collecting — 0 of 10 days.
- Left out: 921 censored days (missing hours), 0 scored by two model versions (a deploy day), 63 still in progress, 0 with no early window. Outlook forecasts skipped across a model change: 0.

Days ahead: no outlook rows with a finished target day yet.

## Safety message and lifeguard flags

We compare our swim message (safe, caution, stay out) with the lifeguard flag that was flying. The City posts one flag a beach a day, so we count beach-days, not hours. A beach-day's flag is its most common flag. Our message is its most common swim level; a tie goes to the more serious one. Only beaches with a posted flag count.

- Beach-days with a swim message and a known flag: 30 (from 141 hourly rows). Enough to score.

### Swim message by flag (beach-days)

| Flag | Safe | Caution | Stay out |
| --- | ---: | ---: | ---: |
| double-red | 0 | 0 | 7 |
| red | 0 | 0 | 9 |
| yellow | 4 | 5 | 0 |
| green | 4 | 0 | 0 |
| purple | 0 | 1 | 0 |

A red or double-red flag sets "stay out" directly (lib/safetyLine.ts). Those rows say nothing about our own judgement. The next section leaves them out.

### Green and yellow flags only

- Beach-days: 13 (9 yellow, 4 green). Status: collecting — 13 of 30 beach-days.
- Agreement (yellow with caution or stay out, or green with safe): 9 of 13; rate n=13, collecting.
- Yellow flag, but we said safe: 4.
- Green flag, but we said caution or stay out: 0.

## Data health

- Beaches with rows in the last 7 days: 63.
- Extra data (the prediction blocks) is on 100% of rows in this report's window, 100% of the last 24 hours, and 100% of rows since the first one (2026-10-27 00Z).
- Share of the last 24 hours' extra rows with each block: window 74.4%, rain 100%, flags 100%, outlook 100%, safety 100%, rip 100%.
- Local hours missing on beaches that should archive all 24 (28 beaches, 168 beach-days): 9 (50% present), 10 (29.8% present), 11 (3.6% present), 12 (0% present), 13 (0% present), 14 (0% present), 15 (4.8% present), 16 (61.9% present), 17 (0% present), 18 (7.1% present). "Best time to go" cannot score these hours, and sunset forecasts close to the event are missing.
- Beaches under 12 rows a day (finished days, last 7 days), worst first. Auto-tier beaches archive daylight hours only, so their full count is the Expected column:

| Beach | Tier | Rows per day | Expected | Fewest in a day | Days counted |
| --- | ---: | ---: | ---: | ---: | ---: |
| pismo-beach | auto | 2.3 | 11 | 2 | 6 |
| santa-cruz | auto | 2.3 | 11 | 2 | 6 |
| seaside | auto | 2.3 | 11 | 2 | 6 |
| huntington-beach | auto | 3 | 10 | 3 | 6 |
| la-jolla | auto | 3 | 10 | 3 | 6 |
| long-beach | auto | 3 | 10 | 3 | 6 |
| santa-monica | auto | 3 | 10 | 3 | 6 |
| ocean-shores | auto | 2.7 | 9 | 2 | 6 |
| crescent-bay-park | auto | 3.3 | 10 | 3 | 6 |
| cannon-beach | auto | 3 | 9 | 3 | 6 |

  And 25 more (4 to 6 rows a day).

- Latest camera capture per beach (oldest first): key-west 113.2 h ago, jacksonville-beach 17.5 h ago, key-west-south 17.5 h ago, ormond-beach 17.5 h ago, sombrero-beach 17.5 h ago, and 22 more. Silent for over 6 hours: key-west, jacksonville-beach, key-west-south, ormond-beach, sombrero-beach, st-augustine-beach, vilano-beach, anna-maria-island, dania-beach, deerfield-beach, dunlawton-beach, fort-lauderdale, hobe-sound, hollywood-beach, jupiter, marathon, new-smyrna-beach, ponce-inlet, singer-island, stuart-bathtub-beach, fort-myers-beach, jensen-beach, siesta-key, pensacola-beach, panama-city-beach, sebastian-inlet, boca-raton.
- Cameras hidden as offline (they come back on their own with the first good frame): 3
  - deerfield-spinner-uw (deerfield-beach): no good frame stored, last try Nov 10, 10:13 AM ET (blank)
  - deerfield-surf-cam (deerfield-beach): no good frame stored, last try Nov 10, 10:13 AM ET (blank)
  - fort-zachary-taylor-cam (key-west): offline since Nov 6, 11:08 AM ET, last good frame Nov 5, 8:08 PM ET, last try Nov 5, 2:00 PM ET
- Sun camera readings: 864; latest event 2026-11-10T12:10:19.442Z, scored 2026-11-10T12:49:41.122Z.
- Sun-color forecast rows in the last 24 hours: 1170.

---

Made by `npx vite-node -c vitest.config.ts scripts/scorecard.ts`. Read-only: it never writes to the database.
