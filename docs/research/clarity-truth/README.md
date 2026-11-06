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

## Using a day as a test

The `sargassum.yml` workflow has a read-only test mode that runs the
near-shore prompt on the committed frames and prints the answers:

```
gh workflow run sargassum.yml --ref <branch> -f shadow_test=true
```

It writes no feed and pushes nothing.
