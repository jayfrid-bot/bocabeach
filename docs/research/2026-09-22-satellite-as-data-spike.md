# Satellite-as-data spike: Sentinel-2 vs Boca cam history (2026-09-22)

Answers the open question from `docs/HISTORY_AND_IMAGERY_PLAN.md` Part B and
item 9 of `docs/reviews/2026-09-20-codex-phase2-history-imagery.md`: can
Sentinel-2 imagery stand in for a live cam, for offshore sargassum coverage
and nearshore turbidity/clarity, on beaches that have no camera?

Reproducible script: `scripts/research/satellite_spike.py`. Raw output:
`satellite_spike_matched_scenes.csv`, `satellite_spike_summary.json` (this folder).

## Data sources

- Scenes: [Earth Search STAC API](https://earth-search.aws.element84.com/v1),
  collection `sentinel-2-l2a`, point search at Boca Raton (26.3587, -80.0686),
  2026-06-01 to 2026-09-22, `eo:cloud_cover < 40`.
- Ground truth: Boca cam-derived history
  (`cam_seaweed.json`, `sargassum-data` branch), 1,122 reads, 2026-06-04 to
  2026-09-22.
- Bands read as small windowed crops over `/vsicurl/` (no full-scene
  downloads): B02/B03/B04/B08/B11/SCL, in two boxes — nearshore (0-300m
  offshore, ~1km alongshore) and offshore (300m-3km offshore, same alongshore
  span).

Attribution: Copernicus Sentinel data, processed by ESA / Element 84 (Earth
Search).

## What was fetched

13 scenes matched the scene-level cloud filter over the 3.7-month window.
Per-crop SCL cloud/cirrus screening (not just the scene-level
`eo:cloud_cover` tag, per the Codex review) rejected 4 more — one had both
boxes 100% cloud despite a "25% cloud" scene tag, illustrating exactly the
gap the review flagged. **9 scenes survived.**

| Month | Scenes queried | Survived crop-level cloud filter |
|---|---|---|
| 2026-06 | 3 | 2 |
| 2026-07 | 4 | 3 |
| 2026-08 | 5 | 4 |
| 2026-09 | 1 | 0 |

All 5 SWIR (B11) reads succeeded, so FAI (not the NDVI fallback) was used for
every surviving scene.

## Correlations vs cam ground truth

Matching rule: median cam `cov`/`clr` from reads within ±3h same calendar day
as the ~16:00 UTC Sentinel-2 pass.

| Signal | vs | Spearman rho | n |
|---|---|---|---|
| Offshore sargassum raft fraction (FAI > 0.02, water pixels) | cam `cov` (seaweed %) | **0.16** | **7** |
| Nearshore mean red (B04) reflectance | cam `clr` (clarity %) | **-0.80** | **4** |
| Nearshore NDTI | cam `clr` (clarity %) | **-0.80** | **4** |

Scatter plots: `satellite_spike_sargassum_scatter.png`,
`satellite_spike_turbidity_scatter.png`.

**n is small — call this out explicitly, not a footnote.** 7 and 4 points
respectively is far below what's needed to trust a correlation; both numbers
should be read as directional hints from this single beach, single season,
not as validated results.

## Honest verdict

- **Sargassum raft fraction: not usable yet.** rho=0.16 on n=7 is
  statistically meaningless — could easily be noise. The offshore box also
  measured near-zero raft fraction on most dates (max 1.6%) even when cam
  `cov` read 65%, which is plausible (cam sees nearshore drift-in seaweed on
  sand/surf, not the same thing as a detectable floating raft 300m-3km out)
  but means the two are measuring related-but-different phenomena, not
  interchangeable ones.
- **Turbidity proxy (red reflectance, NDTI): more promising but unproven.**
  rho=-0.80 on n=4 is the expected sign (more red reflectance / higher NDTI ->
  lower clarity) and a strong magnitude, but n=4 is not a result, it's a
  suggestion worth a bigger run.
- **Freshness/staleness, measured from this run's actual survival dates:**
  gaps between consecutive surviving scenes were 7, 12, 18, 5, 10, 17, 3, 5,
  10, and **26 days** (from 2026-06-01, the survived dates, to 2026-09-22).
  **Worst case in this window: 26 days with zero usable satellite read**
  (2026-08-27 to 2026-09-22 — the single September scene was cloud-rejected).
  That is far outside anything that could be called "recent conditions."
  Even the median gap (~10 days) is stale relative to the ~3-hour cam refresh
  cadence this app already has on Boca. Revisit cadence (~5 days nominal, 2-3
  in overlap zones) plus South Florida's summer cloud cover means real-world
  gaps are dominated by weather, not orbit geometry.

**Bottom line against the Codex review's bar (item 10 — no satellite signal
enters the live score or lifts a coverage tier until freshness and
validation are proven): neither signal clears that bar today.** Turbidity is
worth a longer validation run; sargassum raft fraction as defined here is not
demonstrating the relationship needed to promote it, though the underlying
FAI approach and per-crop cloud screening pipeline worked technically (13
scenes queried, 9 survived, no blockers, ~3s per band per scene over
`/vsicurl/`).

## What a phase-2 attempt would need

1. **Longer baseline.** One Boca summer, n=7-9, is not enough. Need a
   multi-season run (ideally covering a known sargassum bloom period,
   spring-summer is typical) to get to n>=30 matched scenes before trusting a
   correlation.
2. **Better cloud masking near the coast.** SCL performance degrades near
   coastlines and in shallow water (sun glint, adjacency effects); consider
   ACOLITE or a coastal-specific atmospheric correction check rather than
   relying on the standard L2A SCL/Sen2Cor output.
3. **Separate "visible raft" from "cam-visible nearshore accumulation."** The
   two may need different geometries — e.g. move the raft-detection box closer
   to shore, or track raft appearance offshore N days before validating
   against nearshore cam reads N days later (currents move rafts onshore over
   time, same-day matching may be the wrong lag).
4. **Downscaling / case-2 water check.** Sentinel-2's atmospheric correction
   is tuned for case-1 (open ocean) water; nearshore South Florida is case-2
   (sediment/CDOM-influenced). Validate FAI/NDTI against known Sentinel-2
   ocean-color literature caveats before trusting absolute values, only
   relative trends.
5. **Cross-validate on more cam beaches** once Deerfield/Fort Lauderdale
   collection is fixed (currently 17 and 4 reads respectively, per the
   history plan) — Boca alone can't rule out beach-specific geometry quirks
   (inlet, groins, `sandbar` shape) driving the raft-fraction miss.
6. **If pursued, keep it out of the live score** (per Codex item 10) until a
   validation run with the above changes clears a pre-agreed n and rho bar —
   this spike does not clear it.

## Reproducing this spike

```bash
python3 -m venv <venv>
<venv>/bin/pip install pystac-client rasterio numpy pandas matplotlib
<venv>/bin/python scripts/research/satellite_spike.py
```

No API key needed (Earth Search + the public `sentinel-cogs` S3 bucket are
open). Only small windowed crops are read, not full scenes — this run made
no full-scene downloads.
