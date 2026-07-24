# Water clarity calibration ledger

Ground-truth observations for calibrating the cam-vision water-clarity reads
(same method that got the sand-temp model to ±2°F: collect real observations,
correct SYSTEMATIC bias only, never chase single noisy points).

## Owner in-water estimates (the gold standard — actual Boca water)

| Date | Time (ET) | Owner estimate | Cam reads (per-cam) | Worst-of | Median | UW cam (Deerfield) |
|---|---|---|---|---|---|---|
| 2026-07-24 | ~1:10 PM | **75% clear** | 25 / 65 / 85 (pre-fix prompt) | 25 | 65 | 35 (7 mi away) |
| 2026-07-24 | 1:17 PM (post-fix re-read, same water) | (75) | 50 / 85 / 88 | — | **85** (published) | — |
| 2026-07-24 | 2:58 PM | **65% clear** | 85 / 85 / 85 | — | **85** (published) | — |

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

**2026-07-24 later (n=2):** both post-fix residuals are OVER (+10, +20) and the
cams clustered at exactly 85 while the real water declined 75→65 — the
seaweed/glare prompt overcorrected into poor scale discrimination. Fix: rubric
anchoring in the prompt (explicit 0-100 bands, "most days fall 55-80, reserve
85+ for genuinely exceptional transparency") rather than a numeric offset.
Re-evaluate the residual sign after the next owner anchor.

## Open questions (need more data)

- Residual: pre-fix median 65 vs 75 → −10; post-fix (median + seaweed/glare
  prompt) 85 vs 75 → **+10**. The pipeline moved from −50 to +10 in one pass.
  One ground-truth point; apply a numeric correction only when ≥4-5 owner
  estimates show a consistent sign (watch for overshoot now that the prompt
  is more permissive).
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
