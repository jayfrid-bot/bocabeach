# Vision accuracy eval

Measures how well the Gemini vision model reads **seaweed** and **crowd** from the
beach‑cam stills, against human ground‑truth labels. Re‑run it whenever the prompt
or model changes to see if accuracy actually moved.

## Files
- `archive_stills.py` — capture current cam frames into `images/` (+ `manifest.csv`).
- `labels.csv` — **ground truth**. Pre‑filled as a first pass; **correct it by hand.**
- `run_eval.py` — runs the *production* vision call (`scripts/cam_seaweed.py`) over
  `images/` → `predictions.csv`. Needs `GEMINI_API_KEY`; throttled for the free tier.
- `score_eval.py` — compares `labels.csv` vs `predictions.csv` → `report.md`.

## Workflow
```bash
python eval/archive_stills.py            # grow the image set (run over days for variety)
#  -> edit eval/labels.csv: set the true seaweed/crowd/people for each new image
GEMINI_API_KEY=... python eval/run_eval.py
python eval/score_eval.py                # writes eval/report.md
```

## Labeling rubric (keep it consistent)
**Seaweed** (brown/golden sargassum on the sand + shallow water):
- `none` — clean sand, nothing visible.
- `low` — a thin wrack line or scattered patches.
- `moderate` — clear bands of seaweed.
- `high` — heavy mats covering much of the shore.

**Crowd** (people on the sand/in the water + cars in any visible lot):
- `empty` (nobody) · `quiet` (a few) · `moderate` (steady) · `busy` (crowded) · `packed` (very crowded).
- `people` = your best count of visible people (rough is fine).

## Reading the report
- **Exact** vs **adjacent** accuracy — adjacent counts off‑by‑one (moderate↔high) as a near‑miss.
- **MAE** — average distance on the 0–N ordinal scale.
- **Confusion matrix** — *where* it errs.
- **Quadratic weighted kappa** — agreement vs chance, penalizing bigger misses more.
- **Per‑class recall** — catches the class‑imbalance trap (real days are mostly none/quiet).
- Grow the set with rare cases (high seaweed, busy/packed) or those metrics stay blind.
- Label a few images **twice** to gauge the human ceiling (inter‑rater agreement).
