# Sand backtest — sun-angle term (2026-10-12)

Question (owner): is the October miss the lower sun? Two candidates added to `scripts/sand_backtest.ts`:
- **Season sun angle:** boost × min(1, sin(noon sun elevation) / sin(87°))^p. 87° is June noon at Boca (the season the model was tuned on), so June is untouched by construction.
- **Instant sun angle:** the same idea with the sun's elevation at the reading's minute.

## Result
| model | all-reading MAE | Jun | Jul | Sep | Oct |
|---|---|---|---|---|---|
| live | 7.6 | −1.3 | +6.0 | −3.9 | **+8.7** |
| season, p=1 | 6.5 | −1.3 | +6.0 | −5.7 | +3.7 |
| season, p=1.5 (est.) | ~6.4 | −1.3 | ~+6.0 | — | ~+1.5 |
| season, p=2 | 6.4 | −1.3 | +5.9 | −7.5 | **−0.5** |
| instant, p=1 | 6.3 | −4.8 | +4.2 | −6.3 | +3.1 |

September's mean is dragged by one cloudy reading (9/04 15:10, −26.7 live: sun 352 W/m²). Without it, September is +3.7 live → −0.7 at p=2.

## Verdict: the sun angle explains the seasonal average
- **Season p=2** centers both September and October near zero and leaves June alone — the instant-angle version double-counts (the W/m² already carries the instant angle) and cools June wrongly.
- **What it does NOT explain:** 10/06 vs 10/12 at the same sun angle differ by ~10°. With p=2, 10/06 reads 4–7° cold and 10/09, 10/12 read 4–5° hot. That day-to-day spread is something else (wind, humidity, wet sand from a recent tide or rain) and needs more readings.

## Recommendation
Ship season p=2 (one line in `lib/sandTemp.ts` + tests + scoring version bump + `lib/scoringVersions.ts` note). Keep logging readings with spots named to chase the day-to-day spread.

## Every reading, live model, satellite-observed sunshine

| date | time | spot | measured | soil | sun W/m² | accum Wh | wind | h from noon | noon sun ° | model | error |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-06-11 | 14:00 | dunes | 135 | 103 | 896 | 3452 | 14 | +0.7 | 87 | 134 | -1.5 |
| 2026-06-15 | 13:00 | dunes | 132 | 108 | 893 | 2586 | 11 | -0.3 | 87 | 137 | +4.8 |
| 2026-06-23 | 09:54 | surf | 113 | 92 | 281 | 743 | 2 | -3.5 | 87 | 109 | -3.5 |
| 2026-06-23 | 09:54 | dunes | 124 | 92 | 281 | 743 | 2 | -3.5 | 87 | 119 | -4.9 |
| 2026-07-06 | 16:30 | dunes | 96 | 97 | 589 | 4723 | 4 | +3.1 | 86 | 111 | +14.7 |
| 2026-07-14 | 13:00 | dunes | 138.5 | 105 | 905 | 2433 | 12 | -0.4 | 85 | 135 | -3.2 |
| 2026-07-14 | 14:20 | dunes | 137.5 | 106 | 956 | 3657 | 8 | +0.9 | 85 | 139 | +1.6 |
| 2026-07-15 | 16:15 | dunes | 112.5 | 103 | 681 | 5449 | 8 | +2.8 | 85 | 119 | +6.9 |
| 2026-07-15 | 17:30 | dunes | 100 | 98 | 673 | 6297 | 8 | +4.1 | 85 | 98 | -1.5 |
| 2026-07-16 | 15:38 | dunes | 113 | 104 | 878 | 4568 | 10 | +2.2 | 85 | 130 | +17.4 |
| 2026-09-02 | 14:00 | dunes | 129 | 94 | 873 | 2728 | 8 | +0.7 | 71 | 135 | +6.4 |
| 2026-09-04 | 13:00 | dunes | 140 | 94 | 836 | 1861 | 3 | -0.3 | 70 | 139 | -1.4 |
| 2026-09-04 | 15:10 | dunes | 130 | 96 | 352 | 3610 | 6 | +1.8 | 70 | 103 | -26.7 |
| 2026-09-08 | 11:40 | dunes | 120 | 94 | 465 | 898 | 4 | -1.6 | 69 | 126 | +6.2 |
| 2026-10-06 | 13:10 | surf | 117 | 96 | 778 | 1798 | 8 | +0.0 | 57 | 120 | +3.2 |
| 2026-10-06 | 13:10 | mid | 125 | 96 | 778 | 1798 | 8 | +0.0 | 57 | 127 | +1.8 |
| 2026-10-06 | 13:10 | dunes | 128 | 96 | 778 | 1798 | 8 | +0.0 | 57 | 133 | +5.5 |
| 2026-10-09 | 13:15 | mid | 109.5 | 98 | 693 | 2024 | 15 | +0.1 | 56 | 122 | +12.5 |
| 2026-10-12 | 14:50 | surf | 104 | 92 | 739 | 3169 | 9 | +1.7 | 55 | 116 | +12.3 |
| 2026-10-12 | 14:50 | dunes | 113 | 92 | 739 | 3169 | 9 | +1.7 | 55 | 130 | +16.6 |

Live model: MAE 7.6  bias +3.4  by month → 06: -1.3  07: 6.0  09: -3.9  10: 8.7
Live model fed FORECAST sunshine instead: MAE 8.4  bias +3.4  by month → 06: -4.0  07: 6.2  09: -3.4  10: 10.0

## Candidates (all readings, observed sunshine)

| candidate | MAE | bias | by month |
|---|---|---|---|
| live | 7.6 | +3.4 | 06: -1.3  07: 6.0  09: -3.9  10: 8.7 |
| accumulated sunshine, ref 3000 Wh | 11.0 | -3.3 | 06: -10.8  07: 5.0  09: -14.7  10: 1.1 |
| accumulated sunshine, ref 4000 Wh | 12.5 | -6.9 | 06: -14.1  07: 3.5  09: -19.6  10: -4.2 |
| accumulated sunshine, ref 5000 Wh | 14.0 | -9.8 | 06: -16.8  07: 1.4  09: -22.8  10: -7.6 |
| accumulated sunshine, ref 4000 Wh, sqrt | 9.6 | -2.9 | 06: -9.7  07: 4.6  09: -13.6  10: 1.2 |
| steeper sun response (power 0.75) | 7.3 | +1.2 | 06: -4.8  07: 5.1  09: -6.5  10: 6.6 |
| linear sun response (power 1) | 7.4 | -0.6 | 06: -7.4  07: 4.3  09: -8.8  10: 4.7 |
| weaker wind effect (÷90) | 8.5 | +4.7 | 06: 0.1  07: 7.2  09: -2.9  10: 10.5 |
| stronger wind effect (÷40, floor 0.4) | 6.8 | +1.3 | 06: -3.4  07: 4.2  09: -5.3  10: 5.9 |
| stronger wind effect (÷30, floor 0.3) | 6.5 | -0.8 | 06: -5.5  07: 2.3  09: -6.7  10: 3.2 |
| stronger wind effect (÷25, floor 0.2) | 6.9 | -2.4 | 06: -7.2  07: 0.9  09: -7.9  10: 1.0 |
| stronger wind effect (÷20, floor 0.2) | 7.9 | -4.9 | 06: -9.7  07: -1.3  09: -9.6  10: -2.3 |
| max boost 50 | 6.9 | +0.9 | 06: -3.7  07: 4.1  09: -6.7  10: 5.9 |
| season sun angle (noon elev), power 1 | 6.5 | +1.5 | 06: -1.3  07: 6.0  09: -5.7  10: 3.7 |
| season sun angle, power 2 | 6.4 | -0.1 | 06: -1.3  07: 5.9  09: -7.5  10: -0.5 |
| season sun angle, power 3 | 6.4 | -1.5 | 06: -1.3  07: 5.9  09: -9.1  10: -3.9 |
| season sun angle, power 4 | 7.2 | -2.7 | 06: -1.3  07: 5.8  09: -10.6  10: -6.8 |
| season sun angle, power 6 | 9.0 | -4.6 | 06: -1.3  07: 5.8  09: -13.5  10: -11.3 |
| instant sun angle, power 1 | 6.3 | -0.0 | 06: -4.8  07: 4.2  09: -6.3  10: 3.1 |
| instant sun angle, power 2 | 6.3 | -2.8 | 06: -7.2  07: 2.7  09: -8.6  10: -1.4 |
| instant sun angle, power 3 | 7.3 | -4.9 | 06: -8.9  07: 1.5  09: -10.6  10: -4.9 |

Grid best: {"maxBoost":60,"sunPower":0.5,"windDiv":25,"windFloor":0.6,"soilSlope":80,"accumRef":0,"accumPower":1,"seasonPower":1,"elevPower":0} → MAE 5.8 bias -0.1 by month → 06: -1.7  07: 4.6  09: -6.5  10: 0.6
