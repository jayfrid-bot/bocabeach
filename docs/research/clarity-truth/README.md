# Water-clarity ground truth

This folder keeps owner observations of the near-shore water, with the cam
frames from the same minutes. Use it to check the cam water-clarity readers
(the live full-frame read and the near-shore SHADOW read in
`scripts/cam_seaweed.py`). One subfolder per day.

## How a day is recorded

- `owner-*.jpg`: photos the owner took at the water line.
- `cams/<cam id>-full.jpg`: the full cam frame from the same time.
- `cams/<cam id>-nearshore.jpg`: the near-shore strip cut from that frame.
- `cams/<cam id>-box.jpg`: the frame with the strip drawn on it.
- `nearshore-boxes.json`: the strip as frame fractions `[x0, y0, x1, y1]`.
  The live boxes are in `config/nearshore-boxes.json`.

## Days

| Date | Time (local) | Beach | Owner label | App showed | Notes |
|---|---|---|---|---|---|
| 2026-11-06 | ~2:00 PM EST | Boca Raton (South Beach and the inlet) | **a bit sandy** (about 45–55 on the old 0–100 scale) | clear, 74 | First ~50 ft from the water line: olive/khaki green, sand visible in the water, no bottom past knee depth. The ankle-deep wash looked clear only because it was inches deep. All three cam reads that tick came from the Clef fallback (Gemini calls failed all day). |

## Shadow reader results on these frames

Runs of `sargassum.yml` in `shadow_test` mode, 2026-11-06 (runs 42281143652 and
42281828267). "Old" is the live full-frame prompt on the same model, as a control.
The live app read that tick came from Clef, not Gemini.

| Frames | Cam | Near-shore read (gemini-3.5-flash-lite) | Old prompt, full frame (same model) | App at the time (Clef) |
|---|---|---|---|---|
| 2026-11-06 ~2 PM (owner: a bit sandy) | boca-inlet-surf | a_bit_sandy (green, some sand, no bottom) — both runs | slightly_murky 65 | clear 74 |
| | boca-south-surf | a_bit_sandy (sandy_green, some sand, no bottom) — run 1; run 2 timed out | slightly_murky 65 | clear 74 |
| | boca-south (not in the median) | a_bit_sandy — both runs | slightly_murky 55 | clear 74 |
| `unlabeled/2026-11-04-1100` (rough, overcast) | inlet / south-surf | murky (brown, lots of sand) / a_bit_sandy | churned 30 / churned 35 | slightly_murky ~60 |
| `unlabeled/2026-11-05-1500` (sunny, blue) | inlet / south-surf | a_bit_sandy / a_bit_sandy | slightly_murky 60 / clear 70 | clear ~73 |

The `unlabeled/` frames have no owner label. They only show that the reader
tells a rough day from a calm one. It has not yet said `clear` on any frame, so
the next useful truth is an owner label on a day that really is clear.

## Using a day as a test

The `sargassum.yml` workflow has a read-only test mode that runs the
near-shore prompt on the committed frames and prints the answers:

```
gh workflow run sargassum.yml --ref <branch> -f shadow_test=true
```

It writes no feed and pushes nothing.
