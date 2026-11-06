# Prediction scorecard — 2026-11-06

Data as of 2026-11-06 01:35 UTC. Hourly rows cover the last 14 days. Sun-color events cover the last 90 days; lifetime counts are shown in that section. A system with too little data says "collecting" and shows counts only. That is expected early on. See docs/scorecards/README.md for definitions and minimums.

## At a glance

- **Sunrise and sunset color:** Model 2026-11-05.1 (live now): collecting — 0 of 10 pairs (9 events with a forecast 30–120 min out). Model 2026-10-15.1: 63 pairs; fair rank correlation +0.04 (61 events on 3 cams); Great calls in the cam's own top 25%: 2 of 12. Model 2026-10-06.2: collecting — 6 of 10 pairs (397 events with a forecast 30–120 min out). A forecast 30–120 min out exists for 560 of 1632 past sunrises (34%) and 675 of 1668 past sunsets (40%).
- **Rain forecast:** Of 5312 "dry for the next 2+ hrs" calls, 1216 (23%) saw radar rain within 2 hours.
- **Best time to go:** collecting — 0 of 10 days. (0 complete days; 858 days left out for missing hours.)
- **Safety message and flags:** collecting — 28 of 30 beach-days. (5 beach-days with a green or yellow flag.)
- **Data health:** 63 beaches archiving. Extra data on 100% of the last 24 hours' rows. 35 beaches under 12 rows a day (0 of them curated). Beaches that should archive all day miss local hours 11, 12, 13, 14, 15, 16, 17, 18, 19 on most days. 1 camera silent for over 6 hours.

## Sunrise and sunset color

We forecast the color of each sunrise and sunset. Then we compare with what the beach cameras saw. One pair is one event (one beach, one sunrise or sunset) that has both a forecast and a camera reading.

- Events loaded (with a scored forecast row or a camera reading), last 90 days: 3392.
- Pairs: 214 (3520 forecast rows). Enough to score.
- Lifetime: 3392 events and 34574 forecast rows logged since 2026-10-06; 3630 rows paired; 721 camera readings.
- Camera readings in the window: 721; 355 are afterglow (the cam looked away from the sun), kept but never scored; 11 matched no forecast row, so they cannot be scored.

### The fair grade, by model version

Each camera has its own raw scale. On the same sunsets Holmes Beach averages 74 and White Sands 5, so a raw 70 means different skies on different cams. The fair grade asks only about order inside one cam. It uses the forecast people see: the one closest to 60 minutes before the event, made 30 to 120 minutes ahead. Each event has one truth cam, the one the server picked: a cam that looks at the sun, the nearest one, then by cam id. Rank correlation runs from −1 to +1. 0 means no skill; a plus means our higher forecasts went with better skies on that cam. A cam counts once it has 8 pairs. The pooled number is the average over cams, weighted by each cam's pairs. A real Great is in that cam's own top 25% for that event kind, and a real Amazing in its top 10%. A version needs 10 pairs before it shows any number. Newest version first.

| Model version | Forecast rows loaded | Past events with a 30–120 min forecast | Pairs | Fair rank correlation | Sunrises | Sunsets | Great calls in the cam's top 25% | Amazing calls in the cam's top 10% | Raw typical miss (pts) | Raw bias (pts) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-11-05.1 (live now) | 78 | 9 | 0 | collecting — 0 of 10 pairs | — | — | 0 of 0 (n=0, collecting) | 0 of 0 (n=0, collecting) | collecting — 0 of 10 pairs | — |
| 2026-10-15.1 | 7186 | 829 | 63 | +0.04 (61 events, 3 cams) | +0.04 (n=61) | — | 2 of 12 (17%) | 0 of 8 (n=8, collecting) | 35.9 | +0.1 |
| 2026-10-06.2 | 1838 | 397 | 6 | collecting — 6 of 10 pairs | — | — | 0 of 0 (n=0, collecting) | 0 of 0 (n=0, collecting) | collecting — 6 of 10 pairs | — |

In the top-tier columns, "3 of 8" means 3 of our 8 Great calls landed in the cam's top 25%. Chance alone gives 25% (Amazing: 10%). A rate needs 10 calls; until then it shows "n=<count>, collecting". Only cams with 8+ events of their own have a scale.

Cams with fewer than 8 events of their own, so no scale yet (left out of the top-tier counts): white-sands-ami-cam (sunset, 1).

### Coverage of the forecast people see

How many past events have a forecast made 30 to 120 minutes before them. An event without one cannot enter the fair grade.

| Event | Past events | With a 30–120 min forecast | Share | With a camera reading | Of those, with the forecast | Share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Sunrise | 1632 | 560 | 34% | 92 | 88 | 96% |
| Sunset | 1668 | 675 | 40% | 122 | 2 | 2% |

### Rank correlation per cam

Our forecast (30–120 min out) against the cam's own score, by rank. Each cam needs 8 pairs. Boca Raton and Deerfield Beach share the Deerfield cams. Each reading counts once, for the beach nearest the cam (Deerfield Beach).

| Model version | Cam | Event | Pairs | Rank correlation |
| --- | ---: | ---: | ---: | ---: |
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
| All pairs | 214 | 3520 | 38.1 | -19.4 |
| Lead: After the event (golden window) | 3 | 3 | collecting — 3 of 10 pairs | — |
| Lead: 0–2 h before | 90 | 177 | 37.7 | +1.7 |
| Lead: 2–6 h before | 90 | 356 | 32.1 | -10.4 |
| Lead: 6–12 h before | 213 | 1148 | 37.7 | -20.8 |
| Lead: 12–24 h before | 213 | 1836 | 39.6 | -22.3 |
| We said: Poor (under 20) | 151 | 1190 | 36.2 | -31.6 |
| We said: Fair (20–44) | 192 | 1799 | 37.3 | -29.2 |
| We said: Good (45–69) | 43 | 116 | 27.3 | +10.1 |
| We said: Great (70–89) | 44 | 91 | 41.7 | +38.2 |
| We said: Amazing (90+) | 73 | 324 | 52.6 | +52.5 |
| Beach: boca-raton | 24 | 371 | 33.6 | -13.5 |
| Beach: deerfield-beach | 24 | 432 | 36.3 | -20.2 |
| Beach: fort-lauderdale | 24 | 432 | 27.1 | -11.9 |
| Beach: fort-myers-beach | 21 | 352 | 48.5 | -31.7 |
| Beach: jacksonville-beach | 20 | 310 | 38.6 | +6.7 |
| Beach: anna-maria-island | 19 | 318 | 54.4 | -45.4 |
| Beach: marathon | 19 | 303 | 21.3 | +15.8 |
| Beach: panama-city-beach | 19 | 302 | 22.2 | -4.9 |
| Beach: siesta-key | 19 | 302 | 53.8 | -45.4 |
| Beach: key-west | 17 | 271 | 49.6 | -43.5 |
| Beach: pensacola-beach | 8 | 127 | collecting — 8 of 10 pairs | — |
| Model version: 2026-10-15.1 | 205 | 3313 | 38.2 | -18.4 |
| Model version: 2026-10-06.2 | 12 | 207 | 37.4 | -35.7 |
| Camera view: afterglow (not scored) | 6 | 110 | afterglow, not used as truth | — |
| Camera view: solar | 214 | 3520 | 38.1 | -19.4 |

### Our call versus what happened (raw camera scale)

The call is our last forecast made at least 60 minutes before the event. Great means 70 or more, on the forecast and on the RAW camera score. Amazing means 90 or more. Some cams give 70+ to most clear skies, so the raw "it happened" and "miss" counts here are mostly a property of the cam. The fair top-tier table above is the grade. Each rate needs 10 cases in its own denominator; until then it shows "n=<count>, collecting". 

|  | Great (70+) | Amazing (90+) |
| --- | ---: | ---: |
| Events with a call | 214 | 214 |
| We called it, and it happened (hit) | 7 | 0 |
| We called it, and it did not (false alarm) | 14 | 14 |
| It happened, and we did not call it (miss) | 76 | 24 |
| Neither | 117 | 176 |
| Hit rate (share of our calls that happened) | 33% | 0% |
| False-alarm rate (share of our calls that did not) | 67% | 100% |
| Miss rate (share of real ones we did not call) | 92% | 100% |

### How often we say Great or Amazing (camera columns on the raw scale)

The model is built so about 20% of events are Great or better, and about 10% are Amazing. Shares wait for 10 events in a row.

|  | Events | Forecast Great+ | Forecast Amazing | Paired events | Forecast Great+ (paired) | Camera Great+ | Camera Amazing |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Design target |  | 20% | 10% |  |  | 20% | 10% |
| All beaches | 3299 | 13% | 11% | 214 | 10% | 39% | 11% |
| anna-maria-island | 38 | 11% | 11% | 19 | 5% | 74% | 58% |
| asbury-park | 61 | 20% | 16% | 0 | — | — | — |
| biloxi | 61 | 21% | 18% | 0 | — | — | — |
| boca-raton | 61 | 15% | 10% | 24 | 8% | 29% | 0% |
| cannon-beach | 61 | 13% | 13% | 0 | — | — | — |
| cape-may | 61 | 15% | 13% | 0 | — | — | — |
| cocoa-beach | 61 | 11% | 7% | 0 | — | — | — |
| coney-island | 61 | 15% | 15% | 0 | — | — | — |
| crescent-bay-park | 61 | 8% | 7% | 0 | — | — | — |
| dania-beach | 38 | 5% | 5% | 0 | — | — | — |
| daytona-beach | 61 | 13% | 11% | 0 | — | — | — |
| deerfield-beach | 61 | 16% | 11% | 24 | 17% | 29% | 0% |
| dunlawton-beach | 38 | 8% | 8% | 0 | — | — | — |
| folly-beach | 61 | 15% | 15% | 0 | — | — | — |
| fort-lauderdale | 61 | 13% | 11% | 24 | 13% | 0% | 0% |
| fort-myers-beach | 42 | 10% | 10% | 21 | 14% | 67% | 5% |
| galveston | 61 | 15% | 15% | 0 | — | — | — |
| grand-isle | 61 | 28% | 21% | 0 | — | — | — |
| gulf-shores | 61 | 18% | 16% | 0 | — | — | — |
| hammonasset-beach | 61 | 21% | 20% | 0 | — | — | — |
| hampton-beach | 61 | 13% | 11% | 0 | — | — | — |
| hobe-sound | 38 | 11% | 5% | 0 | — | — | — |
| hollywood-beach | 38 | 16% | 11% | 0 | — | — | — |
| huntington-beach | 61 | 10% | 8% | 0 | — | — | — |
| jacksonville-beach | 62 | 6% | 6% | 20 | 5% | 20% | 15% |
| jensen-beach | 38 | 11% | 11% | 0 | — | — | — |
| jupiter | 38 | 5% | 3% | 0 | — | — | — |
| key-west | 38 | 8% | 5% | 17 | 6% | 82% | 35% |
| key-west-south | 38 | 11% | 5% | 0 | — | — | — |
| la-jolla | 61 | 13% | 11% | 0 | — | — | — |
| long-beach | 61 | 5% | 5% | 0 | — | — | — |
| marathon | 38 | 8% | 3% | 19 | 11% | 0% | 0% |
| miami-beach | 61 | 16% | 13% | 0 | — | — | — |
| misquamicut | 61 | 23% | 18% | 0 | — | — | — |
| montauk | 61 | 20% | 15% | 0 | — | — | — |
| myrtle-beach | 61 | 11% | 10% | 0 | — | — | — |
| nags-head | 61 | 18% | 16% | 0 | — | — | — |
| naples | 61 | 20% | 15% | 0 | — | — | — |
| new-smyrna-beach | 38 | 5% | 0% | 0 | — | — | — |
| ocean-shores | 61 | 21% | 16% | 0 | — | — | — |
| old-orchard-beach | 61 | 13% | 11% | 0 | — | — | — |
| ormond-beach | 38 | 5% | 3% | 0 | — | — | — |
| panama-city-beach | 38 | 11% | 8% | 19 | 11% | 0% | 0% |
| pensacola-beach | 42 | 21% | 17% | 8 | — | — | — |
| pismo-beach | 61 | 11% | 10% | 0 | — | — | — |
| ponce-inlet | 38 | 8% | 3% | 0 | — | — | — |
| rehoboth-beach | 61 | 16% | 13% | 0 | — | — | — |
| santa-cruz | 61 | 16% | 15% | 0 | — | — | — |
| santa-monica | 61 | 8% | 7% | 0 | — | — | — |
| seaside | 61 | 13% | 10% | 0 | — | — | — |
| sebastian-inlet | 38 | 8% | 8% | 0 | — | — | — |
| siesta-key | 38 | 8% | 5% | 19 | 5% | 84% | 16% |
| singer-island | 38 | 8% | 8% | 0 | — | — | — |
| sombrero-beach | 38 | 5% | 0% | 0 | — | — | — |
| south-padre-island | 61 | 13% | 10% | 0 | — | — | — |
| st-augustine-beach | 38 | 5% | 0% | 0 | — | — | — |
| stuart-bathtub-beach | 38 | 8% | 5% | 0 | — | — | — |
| tybee-island | 61 | 16% | 10% | 0 | — | — | — |
| vilano-beach | 38 | 3% | 3% | 0 | — | — | — |
| virginia-beach | 61 | 11% | 5% | 0 | — | — | — |
| wabasso-beach | 38 | 13% | 11% | 0 | — | — | — |
| waikiki | 60 | 22% | 13% | 0 | — | — | — |
| wrightsville-beach | 61 | 11% | 10% | 0 | — | — | — |

### East-coast sunsets: the afterglow over the ocean

An east-facing cam looks away from the sun at sunset. It sees the afterglow on the clouds over the ocean. On an east-coast beach that afterglow is what a beachgoer sees at sunset. These readings are never the truth for the sunset's color, and they are not in any number above. Here each cam is graded by rank only (Spearman, 8+ events per cell). The satellite column is the mid and high cloud along the path away from the sun (breakdown_json.satellite.antiMidHighPct). The satellite is read only within 60 minutes of the event, so only some events have it. It is evidence for a future afterglow forecast, not a grade.

| Cam | Afterglow readings | Matched to a forecast event | Model version | Forecast 30–120 min out vs afterglow | Call (60+ min out) vs afterglow | Satellite cloud away from the sun vs afterglow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| deerfield-beach-cam | 24 | 24 | 2026-10-15.1 | collecting — 2 of 8 events | +0.25 (n=21) | collecting — 3 of 8 events |
|  |  |  | 2026-10-06.2 | collecting — 3 of 8 events | collecting — 3 of 8 events |  |
| deerfield-pier-cam | 24 | 24 | 2026-10-15.1 | collecting — 2 of 8 events | +0.16 (n=21) | collecting — 3 of 8 events |
|  |  |  | 2026-10-06.2 | collecting — 3 of 8 events | collecting — 3 of 8 events |  |
| ftl-elbo-beach-cam | 24 | 24 | 2026-10-15.1 | collecting — 2 of 8 events | +0.41 (n=21) | collecting — 3 of 8 events |
|  |  |  | 2026-10-06.2 | collecting — 3 of 8 events | collecting — 3 of 8 events |  |
| jax-beach-bw-cam | 20 | 20 | 2026-10-15.1 | collecting — 1 of 8 events | -0.03 (n=20) | collecting — 1 of 8 events |

### Gulf sunrises: the afterglow over the Gulf

The same check for west-facing Gulf cams at sunrise. The sun rises behind them, over the land, and they see the afterglow on the clouds over the Gulf.

| Cam | Afterglow readings | Matched to a forecast event | Model version | Forecast 30–120 min out vs afterglow | Call (60+ min out) vs afterglow | Satellite cloud away from the sun vs afterglow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fort-myers-beach-cam | 21 | 21 | 2026-10-15.1 | +0.05 (n=21) | +0.11 (n=21) | +0.21 (n=21) |
| enco-shores-of-panama-cam | 19 | 19 | 2026-10-15.1 | +0.18 (n=19) | -0.31 (n=19) | +0.31 (n=19) |
| enco-sterling-reef-cam | 19 | 19 | 2026-10-15.1 | +0.03 (n=19) | +0.61 (n=19) | -0.28 (n=19) |
| fort-zachary-taylor-cam | 19 | 19 | 2026-10-15.1 | +0.07 (n=19) | +0.07 (n=19) | +0.15 (n=19) |
| margaritaville-fmb-cam | 19 | 19 | 2026-10-15.1 | +0.26 (n=19) | +0.34 (n=19) | +0.06 (n=19) |
| sharkys-pcb-cam | 19 | 19 | 2026-10-15.1 | -0.10 (n=19) | +0.35 (n=19) | -0.26 (n=19) |
| siesta-beach-cam | 19 | 19 | 2026-10-15.1 | +0.19 (n=19) | +0.19 (n=19) | -0.42 (n=19) |
| sunset-grille-marathon-cam | 19 | 19 | 2026-10-15.1 | -0.08 (n=19) | -0.06 (n=19) | +0.29 (n=18) |
| white-sands-ami-cam | 19 | 19 | 2026-10-15.1 | +0.14 (n=19) | +0.26 (n=19) | +0.52 (n=9) |
| holmes-beach-cam | 18 | 18 | 2026-10-15.1 | -0.13 (n=18) | -0.11 (n=18) | -0.07 (n=8) |
| pink-shell-fmb-cam | 15 | 15 | 2026-10-15.1 | +0.44 (n=15) | +0.48 (n=15) | +0.50 (n=15) |
| pensacola-sria-west-cam | 9 | 9 | 2026-10-15.1 | -0.11 (n=9) | -0.11 (n=9) | -0.11 (n=8) |

### What to fix next

Made from the numbers above by fixed rules (see docs/scorecards/README.md).

- Model 2026-11-05.1 (live now) is still collecting: 0 of 10 pairs with a forecast 30–120 min out (9 events so far). Check again next week.
- Model 2026-10-15.1 runs low when it says Poor: bias -21.9 points on 20 events (raw camera scale).
- Model 2026-10-15.1's Great calls land in the cam's own top 25% only 17% of the time (2 of 12); chance alone gives 25%.
- Sunrise coverage is low: 34% of 1632 past sunrises have a forecast 30–120 min before the event (560); of those with a camera reading, 88 of 92 (96%).
- Sunset coverage is low: 40% of 1668 past sunsets have a forecast 30–120 min before the event (675); of those with a camera reading, 2 of 122 (2%).
- Afterglow signal at enco-shores-of-panama-cam (sunrises): the satellite's mid/high cloud away from the sun has a rank correlation of +0.31 with the afterglow on 19 events. A candidate input for an afterglow forecast.
- Afterglow signal at siesta-beach-cam (sunrises): the satellite's mid/high cloud away from the sun has a rank correlation of -0.42 with the afterglow on 19 events. A candidate input for an afterglow forecast.
- Afterglow signal at pink-shell-fmb-cam (sunrises): the satellite's mid/high cloud away from the sun has a rank correlation of +0.50 with the afterglow on 15 events. A candidate input for an afterglow forecast.

## Rain forecast

The app says "dry" or "raining" from a weather model, with a note on when that changes. We turn that into a forecast for one hour ahead and two hours ahead. "Dry, rain in 25 min" is a rain forecast for both. "Raining, easing in 25 min" is a dry forecast for both. A change at or before the hour has happened by then. Then we check each forecast against the radar reading one and two hours later. Radar rain means a rate above 0 mm/hr, or a fresh frame that saw rain at or near the beach in the last 20 minutes. A radar frame older than 25 minutes is not used.

- Hours with a rain call: 8464.
- Scored (radar available one and two hours later): 6185. Enough to score.
- Each rate needs enough cases in its own denominator (10 for the matrices, 30 for the headline); until then it shows "n=<count>, collecting".

Headline, the promise "Dry for the next 2+ hrs" (dry now, no rain forecast for 2 hours): 5312 calls scored; 1216 saw radar rain within 2 hours (23%).

**Forecast one hour ahead, against radar one hour later**

| Forecast said | Radar saw rain | Radar saw no rain |
| --- | ---: | ---: |
| Rain | 204 | 236 |
| Dry | 1031 | 4714 |

When we forecast rain: radar confirmed it 46% of the time, and did not 54%. Of the times radar saw rain, we had forecast dry 83%. Of our dry forecasts, 18% got rained on.

**Forecast two hours ahead, against radar two hours later**

| Forecast said | Radar saw rain | Radar saw no rain |
| --- | ---: | ---: |
| Rain | 271 | 371 |
| Dry | 947 | 4596 |

When we forecast rain: radar confirmed it 42% of the time, and did not 58%. Of the times radar saw rain, we had forecast dry 78%. Of our dry forecasts, 17% got rained on.

## Best time to go

Each morning the app names a best window for the beach. We take the window it named by 10 AM local time. Then we compare it with the hourly scores we archived for that day. Only a complete day counts: it must be over, have at least 8 scored daylight hours, have 80% of the daylight hours between its first and last archived hour, start within 2 hours of sunrise, and reach 5 PM local (or the last daylight hour). A day that fails this is censored: its archived hours cover only part of the day, so it has no honest best hour.

- Complete days: 0.
- Of those, with a window named by 10 AM: 0. Status: collecting — 0 of 10 days.
- Left out: 858 censored days (missing hours), 0 scored by two model versions (a deploy day), 63 still in progress, 0 with no early window. Outlook forecasts skipped across a model change: 0.

Days ahead: no outlook rows with a finished target day yet.

## Safety message and lifeguard flags

We compare our swim message (safe, caution, stay out) with the lifeguard flag that was flying. The City posts one flag a beach a day, so we count beach-days, not hours. A beach-day's flag is its most common flag. Our message is its most common swim level; a tie goes to the more serious one. Only beaches with a posted flag count.

- Beach-days with a swim message and a known flag: 28 (from 141 hourly rows). Status: collecting — 28 of 30 beach-days.

### Swim message by flag (beach-days)

| Flag | Safe | Caution | Stay out |
| --- | ---: | ---: | ---: |
| double-red | 0 | 0 | 7 |
| red | 0 | 0 | 15 |
| yellow | 1 | 4 | 0 |
| purple | 0 | 1 | 0 |

A red or double-red flag sets "stay out" directly (lib/safetyLine.ts). Those rows say nothing about our own judgement. The next section leaves them out.

### Green and yellow flags only

- Beach-days: 5 (5 yellow, 0 green). Status: collecting — 5 of 30 beach-days.
- Agreement (yellow with caution or stay out, or green with safe): 4 of 5; rate n=5, collecting.
- Yellow flag, but we said safe: 1.
- Green flag, but we said caution or stay out: 0.

## Data health

- Beaches with rows in the last 7 days: 63.
- Extra data (the prediction blocks) is on 100% of rows in this report's window, 100% of the last 24 hours, and 100% of rows since the first one (2026-10-23 00Z).
- Share of the last 24 hours' extra rows with each block: window 75%, rain 100%, flags 100%, outlook 100%, safety 100%, rip 100%.
- Local hours missing on beaches that should archive all 24 (28 beaches, 168 beach-days): 11 (36.9% present), 12 (3% present), 13 (0% present), 14 (0% present), 15 (0% present), 16 (0% present), 17 (0% present), 18 (4.8% present), 19 (69% present). "Best time to go" cannot score these hours, and sunset forecasts close to the event are missing.
- Beaches under 12 rows a day (finished days, last 7 days), worst first. Auto-tier beaches archive daylight hours only, so their full count is the Expected column:

| Beach | Tier | Rows per day | Expected | Fewest in a day | Days counted |
| --- | ---: | ---: | ---: | ---: | ---: |
| ocean-shores | auto | 2.2 | 9 | 2 | 5 |
| pismo-beach | auto | 3 | 11 | 3 | 5 |
| santa-cruz | auto | 3 | 11 | 3 | 5 |
| seaside | auto | 3 | 11 | 3 | 5 |
| crescent-bay-park | auto | 3 | 10 | 3 | 5 |
| huntington-beach | auto | 3 | 10 | 3 | 5 |
| la-jolla | auto | 3 | 10 | 3 | 5 |
| long-beach | auto | 3 | 10 | 3 | 5 |
| santa-monica | auto | 3 | 10 | 3 | 5 |
| galveston | auto | 4 | 11 | 4 | 5 |

  And 25 more (4 to 6 rows a day).

- Latest camera capture per beach (oldest first): pensacola-beach 198.4 h ago, hobe-sound 3.4 h ago, jacksonville-beach 3.4 h ago, dania-beach 3.3 h ago, dunlawton-beach 3.3 h ago, and 22 more. Silent for over 6 hours: pensacola-beach.
- Sun camera readings: 721; latest event 2026-11-05T22:52:50.796Z, scored 2026-11-05T23:29:05.476Z.
- Sun-color forecast rows in the last 24 hours: 1200.

---

Made by `npx vite-node -c vitest.config.ts scripts/scorecard.ts`. Read-only: it never writes to the database.
