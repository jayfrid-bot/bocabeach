# Clef as a Beach Day cam reader: offline backtest (Oct 12 2026)

## Bottom line

Clef is not ready to be the primary cam reader. It is good enough to be a fallback for Gemini, with one big caveat.

The caveat: this archive has no real seaweed and no murky water. Every one of the 93 labelled frames is clean sand or a thin wrack line, and the water is clear or unreadable. Nothing here shows that Clef can spot moderate or heavy sargassum, or murky water. That is the job that matters most. A shadow run on a real seaweed day must settle it.

| role | verdict | why, in one line |
| --- | --- | --- |
| 1. Primary reader (replace Gemini) | No, not proven | Seaweed severity and murky water are untested. People counts run low on crowds. Percent scores are squeezed toward the middle. |
| 2. Fallback when Gemini is out of quota | Yes, `clef` 27B only, with the limits below | Same accuracy as the Qwen fallback on seaweed and crowd. Better on water words. Never invents answers on dark frames. 0 failed calls in 458. |
| 3. Neither | Only for `clef-flash` | Flash says "clear" on almost every frame, even when the water is not visible. It misses 6 of 15 dark frames. |

Where `clef` 27B is trustworthy (on this data):

- Dark, blank or silhouette frames. It flagged 15 of 15 as unreadable, with 1 false alarm on 57 readable frames. It gave no water grade on any of them. Gemini gave a water grade on 5 of the same 15 and called two black frames "moderate" crowd (45 and 35 people).
- "Water not visible" calls. It said unknown on 31 of 34 frames the key calls unknown or dark. It said unknown wrongly once.
- Crowd level, within one step: 100% on every cam family. Exact: 79% on all 93 frames.
- Water word when water is visible: 95% exact (n=38). Almost all of those frames are "clear", so this is a weak test.
- Spinner: it ranks frames in the right order (r=0.75) and finds the dark frames (2 of 3).

Where it is not trustworthy:

- People counts. Clef cannot return a number, so the test used count bands. The result runs low on crowds: about 65% of the key on the 16 frames with 20 or more people (bias -7.7 on frames with 5 or more). Crowd level reads one step low on 7 of 19 "moderate" frames and on both "busy" frames.
- Percent scores (crowd %, water %, Spinner %). They squeeze toward the middle. Spinner: key clear frames (72, 80) read 58 and 68. Key hazy frames (30-38) read 39-55. Spinner exact word match is only 56%.
- Seaweed "low". It said "none" on 8 of 12 frames the key calls "low". Those key labels are weak (a faint dark line at the tide mark), so read this as unsettled, not as a miss.
- Coverage %. Meaningless here. Every true value is 0 to 6.

Other numbers:

- Parse failures: none. Clef returns fixed fields. 0 of 229 calls failed for either model, and none lacked a field.
- `clef` 27B: median 594 ms, p95 1,007 ms from a Mac. $0.00043 per call. 1,795 input tokens per call.
- At 300 reads a day: about $3.88 a month at list price. The free 10,000 neurons a day covers about 255 calls a day, so the bill after the free allowance is about $0.58 a month. The allowance is shared with all other Workers AI use on the account.
- `clef-flash`: median 872 ms, p95 3,583 ms. Cloudflare lists it at $0.038 per M tokens, so about $0.61 a month, and the free allowance covers it fully.
- Total spend for this backtest: $0.1356 for 458 calls (spend cap was $1.00). That total uses the Dumpster Brain price for flash, which is 2.4 times too high.

## Setup

- Worktree `/Users/yitzfrid/Projects/bocabeach-wt-clef`, branch `clef-backtest`. No app code, workflow, `cam_seaweed.py` or deployed config was touched. Nothing is committed.
- Data: 229 archived frames in D1 `cam_frames` (11 cams, Oct 11 and 12 only). 57 `cam_reads` rows since Oct 11. 51 of those rows matched a frame (29 by `frameAt`, 22 by time within 10 minutes). 6 had no frame. The matched rows are 29 Gemini (2.5 flash and flash-lite) and 22 Groq Qwen (`qwen/qwen3.8-27b`). Production already falls back from Gemini to Qwen.
- Images: every frame went to Clef as a base64 data URI, shrunk with `sips` to 768 px on the long side, JPEG quality 60. All fit under 120 KB, so the 512 px fallback was never needed.
- Cam families: Boca feed (boca-south, boca-south-surf), Boca inlet feed (boca-inlet, -north, -surf, -jetty), Deerfield YouTube courier (beach, pier, surf), Elbo Room courier, Spinner underwater.
- Both models ran on all 229 frames.

### How the production prompt was used

Clef does not take one free-form prompt. It takes a list of questions (yes/no, choice, score) and returns probabilities. So the prompt from `scripts/cam_seaweed.py` was split into questions. The rubric words are copied word for word into the instructions and options. Spinner frames use the separate `UW_PROMPT` rubric.

Three differences from production. They matter for reading the numbers:

1. Clef cannot return integers or percents. People count and the percent scores come from `score` questions over bands (the prompt's own anchors for seaweed %, crowd %, water %), then interpolated from the probabilities. People use the bands 0, 1-3, 4-10, 11-25, 26-60, 61-150, 150+.
2. One extra question, not in the prompt: "is this frame too dark, blurred or blocked to read?" It scores the "unreadable" check.
3. Water has `unknown` as a fifth option, as in the prompt.

### The answer key

- Labelled by me (Claude), by eye, on the same 768 px images Clef saw. One labeller, one pass, no second reviewer.
- 48 core frames: stratified across all 11 cams (4 per cam, plus 4 extra midday frames from the people cams). Strata: 14 midday, 14 morning, 10 golden, 5 late, 5 night. Labelled before any Clef run.
- 45 extension frames: every other frame with a matched production read (28) and every other Spinner frame (17). They were added so the check of Gemini and Qwen had enough frames, and so Spinner had more than 4. Labelled before reading any per-frame model output.
- File: `answer-key.json`. Each frame has a confidence for each field group and one short reason.
- Weak spots in the key:
  - "Water unknown" is a judgement call. On sunrise and glare frames I said unknown. Gemini said "clear". Clef 27B agreed with me. That may be right, or it may be a shared blind spot.
  - "Low" seaweed on faint tide-mark lines is low confidence.
  - People counts on crowds above 20 are about plus or minus 30%. Two big Deerfield crowds (50 and 120) are the least certain.
  - Core frames with unreadable key labels are left out of the field scores. The dark-frame table scores them.

## How to read the tables

- Words: exact match, then within one step on the scale (none, low, moderate, high; empty to packed; clear to churned).
- Numbers: mean absolute error (MAE), signed bias (model minus key), and Pearson r when there are 5 or more frames.
- "Key" is my labelling. "Production" is the matched `cam_reads` row. "Agreement" with production is not truth.

## The eight worst disagreements

The table is at the end of this file (clef 27B against the key, across all 93 frames). Even the worst eight are mostly one step off. What they show:

- Dusk frames (boca-inlet-north 2212Z, boca-inlet-jetty 2244Z). Clef made a different seaweed or water call in dim light (a "low" seaweed call, a water grade). The key says water unknown or hard to judge.
- Big crowds read low (deerfield-beach-cam 2007Z: key 50, Clef 23; 1807Z: key 120, Clef 59; boca-south 1907Z: key 30, Clef 16). Gemini said 120 on the 2007Z frame, which is probably too high. Qwen said 60 and 45 on the other two.
- Faint wrack lines (boca-inlet-surf 1618Z and 1300Z). Clef says "none" where the key says "low". Qwen sided with the key on one and with Clef on the other.
- One water miss (boca-inlet 1214Z): Clef said unknown on a dark-blue inlet where the key said clear (low confidence).

## What to do next

1. Shadow-run `clef` 27B beside Gemini and Qwen for a week that includes a real sargassum day and a murky day. Log seaweed level and water word. That is the one test this archive cannot do.
2. If a fallback is wanted now, wire `clef` 27B in behind Gemini. Use its `unreadable` answer to skip dark frames. That also stops Gemini's invented night readings.
3. Fix the people count in code, not in the model. Ask Clef for a crowd level and use the level, not the band midpoint. Or scale the band values up. The current bands read about 35% low on crowds of 20 or more.
4. Do not use `clef-flash` for water or for dark frames.
5. Check Spinner with real visibility ground truth. My Spinner labels are one person's estimate of fish and structure sharpness.

## Caveats

- 93 frames, two days, one labeller. Differences of one or two frames are noise.
- Cams and hours are limited. The archive starts Oct 11. There are no storm, murky, heavy-seaweed or packed-holiday frames.
- Production reads were made on the full-size camera frames. Clef saw the shrunk 768 px copy. A fair share of the Gemini and Qwen disagreement with Clef may come from that, in either direction.
- Production reads used different providers by hour. Gemini rows lean to dawn and night. Qwen rows lean to daytime. Do not compare the two directly.
- Latency is over the REST API from a Mac. It will differ inside a Worker.
- The spend cap used $0.24 and $0.09 per M tokens (the Dumpster Brain table). The Cloudflare price page lists $0.24 and $0.038.

## Files

- `scripts/clef_vision_backtest.mjs`: `--fetch`, `--sample`, `--run`, `--report`. `--report` needs no network and costs nothing.
- `docs/benchmarks/clef-vision-2026-10-12/answer-key.json`: the labels.
- `docs/benchmarks/clef-vision-2026-10-12/cache/`: 458 raw Clef replies, JSON only. No images.
- `docs/benchmarks/clef-vision-2026-10-12/data/`: the D1 rows (frames and reads) the report uses.
- `docs/benchmarks/clef-vision-2026-10-12/per-frame.csv`: key, Clef, flash and production reading for each labelled frame.
- `docs/benchmarks/clef-vision-2026-10-12/summary.json`: all numbers.

<!-- AUTO:START (rewritten by scripts/clef_vision_backtest.mjs --report) -->

## Run facts

| item | value |
| --- | --- |
| Frames archived (state=ready) | 229 |
| Answer-key frames | 48 core + 45 extension |
| cam_reads rows since 2026-10-11 | 57 |
| Matched to a frame by frameAt | 29 |
| Matched by time (within 10 min) | 22 |
| Unmatched | 6 |
| Providers in matched reads | gemini/gemini-2.5-flash, gemini/gemini-2.5-flash-lite, groq/qwen/qwen3.8-27b |
| Workers AI spend (all calls, estimated) | $0.1356 |

## Cost, speed and parse rate

| model | calls | answered | API failures | malformed | fail rate | latency p50 | latency p95 | input tokens / call | $ / call (spend-cap price) | total $ (spend-cap price) | $ / call (docs price) | $ / month at 300 reads/day (docs price) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| clef | 229 | 229 | 0 | 0 | 0% | 594 ms | 1007 ms | 1795 | $0.00043 | $0.0986 | $0.00043 | $3.88 |
| clef-flash | 229 | 229 | 0 | 0 | 0% | 872 ms | 3583 ms | 1795 | $0.00016 | $0.0370 | $0.00007 | $0.61 |

| model | neurons / call | neurons / day at 300 reads | free neurons / day | calls / day the free allowance covers | $ / month at 300 reads/day after the free allowance |
| --- | --- | --- | --- | --- | --- |
| clef | 39.2 | 11746 | 10000 | 255 | $0.58 |
| clef-flash | 6.2 | 1860 | 10000 | 1613 | $0.00 |

The spend cap used the Dumpster Brain price table, which has clef-flash at $0.09 per M tokens. Cloudflare's pricing page says $0.038, so the real flash cost is lower than the cached figure. Neuron figures and the 10,000 neurons per day allowance (Workers Free and Paid) come from the same page. The allowance is shared with every other Workers AI call on the account.

Latency is over the REST API from a Mac. Inside a Worker it will differ. "Malformed" means the reply lacked a field we need.

## Clef vs the answer key

Cells show exact / within one bucket for words, and mean absolute error for numbers. n is the frames scored. Frames the key calls unreadable are left out of the field cells; the last table of each block scores them.

### Core key: the 48 stratified frames

**clef**

| group | frames | seaweed (exact / within 1) | coverage % MAE | crowd (exact / within 1) | crowd % MAE | people MAE | people MAE (key >= 5) | water (exact / within 1) | water % MAE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| All beach cams | 37 | 81% / 100% (n=37) | 1.6, bias +1.1, r=0.56 (n=37) | 78% / 100% (n=37) | 10.9, bias +9.2, r=0.88 (n=37) | 6.2, bias -5.2, r=0.95 (n=37) | 9.3, bias -8.3, r=0.93 (n=23) | 92% / 96% (n=26) | 4.3, bias +3.9, r=0.78 (n=26) |
| Boca feed | 9 | 100% / 100% (n=9) | 1.7, bias +1.7 (n=9) | 78% / 100% (n=9) | 7.9, bias +4.6, r=0.98 (n=9) | 10.7, bias -10.7, r=0.98 (n=9) | 11.8, bias -11.8, r=0.98 (n=8) | 100% / 100% (n=7) | 2.4, bias +1.6, r=0.49 (n=7) |
| Boca inlet feed | 15 | 53% / 100% (n=15) | 1.7, bias +0.5, r=0.55 (n=15) | 73% / 100% (n=15) | 9.9, bias +9.8, r=0.83 (n=15) | 1.7, bias -1.1, r=0.99 (n=15) | 2.5, bias -2.5, r=0.99 (n=6) | 82% / 91% (n=11) | 5.0, bias +5.0, r=0.66 (n=11) |
| Deerfield YouTube courier | 11 | 100% / 100% (n=11) | 1.6, bias +1.6 (n=11) | 82% / 100% (n=11) | 14.3, bias +11.2, r=0.85 (n=11) | 9.2, bias -6.6, r=0.93 (n=11) | 13.9, bias -10.7, r=0.92 (n=7) | 100% / 100% (n=6) | 6.3, bias +6.3, r=0.94 (n=6) |
| Elbo Room courier | 2 | 100% / 100% (n=2) | 1.0, bias +1.0 (n=2) | 100% / 100% (n=2) | 14.0, bias +14.0 (n=2) | 4.0, bias -4.0 (n=2) | 4.0, bias -4.0 (n=2) | 100% / 100% (n=2) | 1.0, bias -1.0 (n=2) |

**clef-flash**

| group | frames | seaweed (exact / within 1) | coverage % MAE | crowd (exact / within 1) | crowd % MAE | people MAE | people MAE (key >= 5) | water (exact / within 1) | water % MAE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| All beach cams | 37 | 78% / 100% (n=37) | 1.2, bias +0.2, r=0.46 (n=37) | 86% / 100% (n=37) | 11.7, bias +11.4, r=0.91 (n=37) | 5.2, bias -4.2, r=0.96 (n=37) | 7.8, bias -7.0, r=0.95 (n=23) | 100% / 100% (n=26) | 7.6, bias +7.6, r=0.65 (n=26) |
| Boca feed | 9 | 100% / 100% (n=9) | 0.8, bias +0.8 (n=9) | 89% / 100% (n=9) | 10.8, bias +10.6, r=0.97 (n=9) | 10.6, bias -10.6, r=0.99 (n=9) | 11.9, bias -11.9, r=0.99 (n=8) | 100% / 100% (n=7) | 6.3, bias +6.3, r=0.35 (n=7) |
| Boca inlet feed | 15 | 67% / 100% (n=15) | 1.7, bias -0.7, r=0.48 (n=15) | 87% / 100% (n=15) | 8.9, bias +8.8, r=0.85 (n=15) | 2.0, bias -1.5, r=0.99 (n=15) | 3.8, bias -3.8, r=0.99 (n=6) | 100% / 100% (n=11) | 7.7, bias +7.7, r=0.73 (n=11) |
| Deerfield YouTube courier | 11 | 73% / 100% (n=11) | 0.9, bias +0.9 (n=11) | 82% / 100% (n=11) | 15.7, bias +15.0, r=0.89 (n=11) | 5.6, bias -2.7, r=0.97 (n=11) | 7.9, bias -5.0, r=0.96 (n=7) | 100% / 100% (n=6) | 11.2, bias +11.2, r=0.38 (n=6) |
| Elbo Room courier | 2 | 100% / 100% (n=2) | 0.5, bias +0.5 (n=2) | 100% / 100% (n=2) | 14.0, bias +14.0 (n=2) | 3.5, bias -3.5 (n=2) | 3.5, bias -3.5 (n=2) | 100% / 100% (n=2) | 0.5, bias +0.5 (n=2) |

| model | dark/unreadable: key yes | caught (p>=0.5) | false alarms | missed | water unknown or dark: key yes | model said unknown too | model said unknown wrongly |
| --- | --- | --- | --- | --- | --- | --- | --- |
| clef | 7 | 7 | 1 | 0 | 18 | 15 | 1 |
| clef-flash | 7 | 3 | 0 | 4 | 18 | 8 | 0 |

### All 93 labelled frames (core plus extension)

**clef**

| group | frames | seaweed (exact / within 1) | coverage % MAE | crowd (exact / within 1) | crowd % MAE | people MAE | people MAE (key >= 5) | water (exact / within 1) | water % MAE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| All beach cams | 57 | 79% / 100% (n=57) | 1.7, bias +1.2, r=0.52 (n=57) | 79% / 100% (n=57) | 11.7, bias +10.2, r=0.86 (n=57) | 5.7, bias -4.7, r=0.95 (n=57) | 8.6, bias -7.7, r=0.93 (n=35) | 95% / 97% (n=38) | 4.4, bias +4.1, r=0.80 (n=38) |
| Boca feed | 12 | 100% / 100% (n=12) | 1.8, bias +1.8 (n=12) | 83% / 100% (n=12) | 10.5, bias +8.0, r=0.98 (n=12) | 8.3, bias -7.9, r=0.98 (n=12) | 10.7, bias -10.2, r=0.98 (n=9) | 100% / 100% (n=10) | 2.8, bias +2.2, r=0.65 (n=10) |
| Boca inlet feed | 20 | 50% / 100% (n=20) | 1.5, bias +0.1, r=0.62 (n=20) | 75% / 100% (n=20) | 10.7, bias +10.6, r=0.77 (n=20) | 1.7, bias -1.0, r=0.98 (n=20) | 2.6, bias -2.6, r=0.98 (n=8) | 87% / 93% (n=15) | 4.9, bias +4.9, r=0.64 (n=15) |
| Deerfield YouTube courier | 21 | 95% / 100% (n=21) | 1.7, bias +1.7 (n=21) | 76% / 100% (n=21) | 12.9, bias +10.3, r=0.80 (n=21) | 8.6, bias -7.0, r=0.93 (n=21) | 11.0, bias -9.3, r=0.91 (n=16) | 100% / 100% (n=11) | 5.8, bias +5.8, r=0.87 (n=11) |
| Elbo Room courier | 4 | 75% / 100% (n=4) | 2.3, bias +2.3 (n=4) | 100% / 100% (n=4) | 14.3, bias +14.3 (n=4) | 2.5, bias -2.0 (n=4) | 4.0, bias -4.0 (n=2) | 100% / 100% (n=2) | 1.0, bias -1.0 (n=2) |

**clef-flash**

| group | frames | seaweed (exact / within 1) | coverage % MAE | crowd (exact / within 1) | crowd % MAE | people MAE | people MAE (key >= 5) | water (exact / within 1) | water % MAE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| All beach cams | 57 | 77% / 100% (n=57) | 1.3, bias +0.1, r=0.39 (n=57) | 82% / 100% (n=57) | 12.9, bias +12.7, r=0.90 (n=57) | 4.5, bias -3.6, r=0.96 (n=57) | 6.8, bias -6.0, r=0.94 (n=35) | 97% / 100% (n=38) | 8.2, bias +8.2, r=0.56 (n=38) |
| Boca feed | 12 | 100% / 100% (n=12) | 0.8, bias +0.8 (n=12) | 92% / 100% (n=12) | 11.9, bias +11.8, r=0.98 (n=12) | 8.0, bias -8.0, r=0.99 (n=12) | 10.6, bias -10.6, r=0.99 (n=9) | 100% / 100% (n=10) | 7.3, bias +7.3, r=0.34 (n=10) |
| Boca inlet feed | 20 | 60% / 100% (n=20) | 2.1, bias -1.3, r=0.40 (n=20) | 85% / 100% (n=20) | 9.4, bias +9.3, r=0.81 (n=20) | 1.6, bias -1.2, r=0.98 (n=20) | 3.0, bias -3.0, r=0.98 (n=8) | 100% / 100% (n=15) | 7.9, bias +7.9, r=0.47 (n=15) |
| Deerfield YouTube courier | 21 | 76% / 100% (n=21) | 0.9, bias +0.9 (n=21) | 76% / 100% (n=21) | 16.4, bias +16.0, r=0.88 (n=21) | 5.7, bias -3.8, r=0.96 (n=21) | 6.9, bias -5.3, r=0.95 (n=16) | 91% / 100% (n=11) | 10.9, bias +10.9, r=0.51 (n=11) |
| Elbo Room courier | 4 | 100% / 100% (n=4) | 0.8, bias +0.8 (n=4) | 75% / 100% (n=4) | 14.3, bias +14.3 (n=4) | 2.3, bias -1.3 (n=4) | 3.5, bias -3.5 (n=2) | 100% / 100% (n=2) | 0.5, bias +0.5 (n=2) |

| model | dark/unreadable: key yes | caught (p>=0.5) | false alarms | missed | water unknown or dark: key yes | model said unknown too | model said unknown wrongly |
| --- | --- | --- | --- | --- | --- | --- | --- |
| clef | 15 | 15 | 1 | 0 | 34 | 31 | 1 |
| clef-flash | 15 | 9 | 0 | 6 | 34 | 16 | 0 |

### Spinner (underwater) vs the answer key (all labelled Spinner frames)

| model | frames scored | clarity word (exact / within 1) | visibility % MAE | dark: key yes | dark caught | false dark | dark missed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| clef | 18 | 56% / 100% (n=18) | 8.1, bias +5.1, r=0.75 (n=18) | 3 | 2 | 0 | 1 |
| clef-flash | 18 | 50% / 100% (n=18) | 9.3, bias +5.8, r=0.74 (n=18) | 3 | 2 | 0 | 1 |

## Dark frames: does the reader still invent an answer?

Frames the key calls dark, blank or in silhouette (beach cams only). A good reader gives no water grade and does not call the beach busy.

| reader | dark frames read | gave a water grade anyway | called crowd moderate or higher |
| --- | --- | --- | --- |
| Gemini (2.5 flash + flash-lite) | 15 | 5 | 2 |
| All providers | 15 | 5 | 2 |
| clef | 15 | 0 | 0 |
| clef-flash | 15 | 0 | 0 |

## Production readers vs the answer key

Only labelled frames (core plus extension) that have a matched cam_reads row. Frames the key calls unreadable are left out.

| reader | matched reads (all) | scored vs key | seaweed | coverage % MAE | crowd | crowd % MAE | people MAE | people MAE (key >= 5) | water | water % MAE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Gemini (2.5 flash + flash-lite) | 29 | 14 | 71% / 100% (n=14) | 2.5, bias +1.9, r=0.76 (n=14) | 64% / 100% (n=14) | 9.6, bias +8.6, r=0.88 (n=14) | 10.6, bias +7.5, r=0.88 (n=14) | 13.9, bias +10.1, r=0.89 (n=9) | 83% / 100% (n=6) | 9.0, bias +9.0, r=0.06 (n=6) |
| Groq Qwen (fallback) | 22 | 22 | 91% / 100% (n=22) | 0.4, bias -0.4, r=0.78 (n=22) | 82% / 100% (n=22) | 6.9, bias +2.5, r=0.86 (n=22) | 6.6, bias -3.7, r=0.89 (n=22) | 9.4, bias -6.1, r=0.85 (n=14) | 62% / 100% (n=13) | 6.2, bias +4.1, r=0.32 (n=13) |
| All providers | 51 | 36 | 83% / 100% (n=36) | 1.2, bias +0.5, r=0.60 (n=36) | 75% / 100% (n=36) | 7.9, bias +4.9, r=0.84 (n=36) | 8.2, bias +0.7, r=0.72 (n=36) | 11.2, bias +0.2, r=0.64 (n=23) | 68% / 100% (n=19) | 7.1, bias +5.6, r=0.15 (n=19) |

Same frames, Clef against the key (apples to apples with the table above):

| Clef on the same frames | frames | seaweed | coverage % MAE | crowd | crowd % MAE | people MAE | people MAE (key >= 5) | water | water % MAE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| clef (frames where Gemini (2.5 flash + flash-lite) also read) | 14 | 93% / 100% (n=14) | 1.4, bias +1.3, r=0.93 (n=14) | 79% / 100% (n=14) | 12.5, bias +11.2, r=0.79 (n=14) | 5.1, bias -2.6, r=0.82 (n=14) | 7.3, bias -4.7, r=0.71 (n=9) | 100% / 100% (n=6) | 4.8, bias +4.8, r=0.95 (n=6) |
| clef-flash (frames where Gemini (2.5 flash + flash-lite) also read) | 14 | 71% / 100% (n=14) | 1.4, bias +0.1, r=0.61 (n=14) | 86% / 100% (n=14) | 14.1, bias +14.1, r=0.93 (n=14) | 2.5, bias -1.5, r=0.97 (n=14) | 3.1, bias -2.9, r=0.98 (n=9) | 83% / 100% (n=6) | 10.5, bias +10.5, r=0.93 (n=6) |
| clef (frames where Groq Qwen (fallback) also read) | 22 | 82% / 100% (n=22) | 2.1, bias +1.5, r=0.39 (n=22) | 77% / 100% (n=22) | 12.3, bias +10.0, r=0.85 (n=22) | 7.3, bias -6.7, r=0.97 (n=22) | 11.0, bias -10.4, r=0.97 (n=14) | 100% / 100% (n=13) | 3.2, bias +3.2, r=0.75 (n=13) |
| clef-flash (frames where Groq Qwen (fallback) also read) | 22 | 91% / 100% (n=22) | 1.4, bias +0.1, r=0.45 (n=22) | 82% / 100% (n=22) | 13.9, bias +13.5, r=0.90 (n=22) | 6.0, bias -5.4, r=0.98 (n=22) | 9.1, bias -8.7, r=0.98 (n=14) | 100% / 100% (n=13) | 7.8, bias +7.8, r=0.32 (n=13) |
| clef (frames where All providers also read) | 36 | 86% / 100% (n=36) | 1.8, bias +1.4, r=0.61 (n=36) | 78% / 100% (n=36) | 12.4, bias +10.5, r=0.82 (n=36) | 6.4, bias -5.1, r=0.94 (n=36) | 9.6, bias -8.2, r=0.92 (n=23) | 100% / 100% (n=19) | 3.7, bias +3.7, r=0.86 (n=19) |
| clef-flash (frames where All providers also read) | 36 | 83% / 100% (n=36) | 1.4, bias +0.1, r=0.51 (n=36) | 83% / 100% (n=36) | 14.0, bias +13.8, r=0.90 (n=36) | 4.7, bias -3.9, r=0.97 (n=36) | 6.8, bias -6.4, r=0.97 (n=23) | 95% / 100% (n=19) | 8.6, bias +8.6, r=0.46 (n=19) |

## Clef vs production readers (agreement, not truth)

Reference = the production reading. Same cells as above.

| pair | frames | seaweed | coverage % MAE | crowd | crowd % MAE | people MAE | people MAE (key >= 5) | water | water % MAE | water unknown: Clef/prod |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| clef vs Gemini (2.5 flash + flash-lite) | 29 | 76% / 100% (n=29) | 3.1, bias +1.2, r=0.45 (n=29) | 66% / 90% (n=29) | 9.8, bias +1.8, r=0.75 (n=29) | 9.1, bias -7.2, r=0.60 (n=29) | 18.6, bias -17.5, r=0.41 (n=13) | 33% / 39% (n=18) | 9.3, bias -6.6, r=-0.05 (n=18) | 22/11 (agree 62%) |
| clef-flash vs Gemini (2.5 flash + flash-lite) | 29 | 69% / 100% (n=29) | 2.4, bias -0.1, r=0.09 (n=29) | 76% / 93% (n=29) | 8.5, bias +2.2, r=0.79 (n=29) | 8.0, bias -6.9, r=0.84 (n=29) | 16.9, bias -16.2, r=0.78 (n=13) | 56% / 67% (n=18) | 8.2, bias -1.2, r=-0.09 (n=18) | 16/11 (agree 76%) |
| clef vs Groq Qwen (fallback) | 22 | 82% / 100% (n=22) | 2.2, bias +1.9, r=0.23 (n=22) | 86% / 100% (n=22) | 11.1, bias +7.5, r=0.86 (n=22) | 3.8, bias -3.0, r=0.92 (n=22) | 5.3, bias -4.5, r=0.88 (n=15) | 38% / 67% (n=21) | 5.5, bias +1.3, r=0.61 (n=21) | 8/1 (agree 68%) |
| clef-flash vs Groq Qwen (fallback) | 22 | 91% / 100% (n=22) | 1.1, bias +0.5, r=0.74 (n=22) | 73% / 100% (n=22) | 11.7, bias +11.0, r=0.92 (n=22) | 5.4, bias -1.7, r=0.86 (n=22) | 7.4, bias -2.9, r=0.83 (n=15) | 38% / 100% (n=21) | 7.5, bias +6.5, r=0.67 (n=21) | 0/1 (agree 95%) |
| clef vs All providers | 51 | 78% / 100% (n=51) | 2.7, bias +1.5, r=0.38 (n=51) | 75% / 94% (n=51) | 10.4, bias +4.2, r=0.78 (n=51) | 6.8, bias -5.4, r=0.66 (n=51) | 11.5, bias -10.5, r=0.51 (n=28) | 36% / 54% (n=39) | 7.3, bias -2.3, r=0.01 (n=39) | 30/12 (agree 65%) |
| clef-flash vs All providers | 51 | 78% / 100% (n=51) | 1.8, bias +0.2, r=0.18 (n=51) | 75% / 96% (n=51) | 9.9, bias +6.0, r=0.83 (n=51) | 6.9, bias -4.7, r=0.75 (n=51) | 11.8, bias -9.0, r=0.66 (n=28) | 46% / 85% (n=39) | 7.8, bias +2.9, r=-0.00 (n=39) | 16/12 (agree 84%) |

## Eight worst disagreements (clef 27B vs the answer key)

| frame | key | production read | clef 27B | why (key note) |
| --- | --- | --- | --- | --- |
| boca-inlet-north/2026-10-11/2212Z | sw none/0%, crowd quiet/8 ppl, water clear/65 | no read | sw low/3%, crowd quiet/7 ppl, water slightly_murky/68 | Dusk, sand clean. About 8 people. Blue-grey water, hard to judge clarity. |
| boca-inlet-jetty/2026-10-11/2244Z | sw low/3%, crowd moderate/14 ppl, water unknown/- | no read | sw none/2%, crowd quiet/11 ppl, water clear/70 | Dusk. Group of about 9 at right, 4-5 on jetty. Water is grey-pink from sky, clarity unclear. |
| deerfield-beach-cam/2026-10-11/2007Z | sw none/0%, crowd moderate/50 ppl, water clear/65 | gemini: sw low/5%, crowd busy/120 ppl, water clear/78 | sw none/2%, crowd quiet/23 ppl, water clear/72 | Late afternoon. About 25 blue umbrellas, roughly 50 people. Clean sand. Teal water with whitecaps. |
| boca-inlet/2026-10-11/1214Z | sw none/0%, crowd empty/0 ppl, water clear/60 | no read | sw none/2%, crowd empty/1 ppl, water unknown/72 | Inlet channel, sun flare on the right. No sand shown, no people. Slate-blue water, depth colour only. |
| deerfield-beach-cam/2026-10-11/1807Z | sw none/0%, crowd busy/120 ppl, water clear/65 | groq: sw none/0%, crowd moderate/60 ppl, water slightly_murky/65 | sw none/2%, crowd moderate/59 ppl, water clear/70 | Beach full of blue umbrellas and loungers to the horizon. About 100-150 people, hard to count. Clean sand. Teal water with surf. |
| boca-inlet-surf/2026-10-11/1618Z | sw low/6%, crowd quiet/12 ppl, water clear/72 | groq: sw low/5%, crowd quiet/8 ppl, water slightly_murky/65 | sw none/3%, crowd quiet/7 ppl, water clear/73 | Midday. About 12 people along the beach. Dark debris patch on the sand near the water. Teal-blue water with whitecaps. |
| boca-inlet-surf/2026-10-12/1300Z | sw low/3%, crowd quiet/1 ppl, water clear/68 | groq: sw none/0%, crowd empty/0 ppl, water clear/80 | sw none/2%, crowd empty/1 ppl, water clear/73 | Bright morning, glitter on the water. One tiny figure far left. Small dark smudge on the sand. |
| boca-south/2026-10-11/1907Z | sw none/0%, crowd moderate/30 ppl, water clear/70 | groq: sw none/0%, crowd moderate/45 ppl, water clear/75 | sw none/1%, crowd quiet/16 ppl, water clear/73 | Wide view, similar to the earlier one but fewer people. About 30. Clean sand. Deep blue water. |

<!-- AUTO:END -->