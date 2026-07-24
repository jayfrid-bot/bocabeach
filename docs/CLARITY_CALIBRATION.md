# Water clarity calibration ledger

Ground-truth observations for calibrating the cam-vision water-clarity reads
(same method that got the sand-temp model to ±2°F: collect real observations,
correct SYSTEMATIC bias only, never chase single noisy points).

## Owner in-water estimates (the gold standard — actual Boca water)

| Date | Time (ET) | Owner estimate | Cam reads (per-cam) | Worst-of | Median | UW cam (Deerfield) |
|---|---|---|---|---|---|---|
| 2026-07-24 | ~1:10 PM | **75% clear** | 25 / 65 / 85 | 25 | 65 | 35 (7 mi away) |

## Changes made from this ledger

**2026-07-24 (n=1, structural fixes only — no numeric offset yet):**
- Aggregation `worst-of` → `median` across cams. The 25 came from one angle
  whose own note said "brownish near shore due to seaweed" — floating
  sargassum patches (a separate, already-tracked signal) contaminating the
  water grade. Per-angle clarity noise is mostly downward (seaweed, glare,
  whitewater), so worst-of systematically under-reads; the median (65) landed
  within 10 pts of the owner's 75.
- Vision prompt now explicitly excludes floating seaweed and sun glare from
  the water-clarity judgment.

## Open questions (need more data)

- Residual after the median fix: 65 vs 75 → −10. One point; apply a numeric
  correction only when ≥4-5 owner estimates show a consistent sign.
- Deerfield UW cam reads much lower than Boca surface/owner (35 vs 75).
  Plausible real difference (pier piling, 7 mi north, different bottom) —
  treat UW as a TREND/sanity signal, not an absolute anchor for Boca, until
  owner points say otherwise.
- Time-of-day: surface reads drifted 65→25 through the morning while actual
  water stayed clear — watch whether midday sun angle biases reads down even
  after the prompt fix.

## How to add a point

Owner texts/says an in-water estimate → add a row with the same-tick cam
values from the feed (`git show origin/sargassum-data:cam_seaweed.json`),
then re-check the residual column before touching any constant.
