# Fix request — Astra set, round 2 (2026-10-09)

Keep the pipeline exactly as it is: `source/compose.cjs` + the SVGs, real app
captures untouched, re-export with
`node screenshots/appstore/1.2/redesign-astra-2026-10-09/source/compose.cjs`.
Update `manifest.json`, the contact sheet, the strip and `preview/` after the
re-export. Do not send any app UI through image generation. Do not touch
`1.2/final/`.

## 1. Page 01 — carry the "many feeds, one score" message

Headline stays "Know before you go." Replace the subline with:

    20+ live feeds. One score.
    Just decide.

Under the subline (above the phone), add one row of small pill chips in the
set's ivory style, text only, no logos, each exactly once, in this order:

    NOAA · NWS · BUOYS · SATELLITE · RADAR · CAMS · TIDES · FLAGS

If eight do not fit on one line at a readable size, use two short rows. Keep
every chip inside the same safe margins the headline uses. Nothing else on
the page changes. (The app pulls 22 feeds per beach today; "20+" is the claim
we can defend.)

## 2. Page 07 — swap the stale capture

`assets/07-app.png` comes from `captures-1.2/07-plan-fort-lauderdale-v3.png`,
taken before this week's surf fix (waves 3.2 ft, 13 s). Replace it with

    /Users/yitzfrid/Projects/bocabeach/screenshots/appstore/captures-1.2/07-plan-v4-fort-lauderdale.png

(1170×2532, taken 2026-10-09). Same crop intent as now: the two pills at the
top ("Dry for the next 2+ hrs", "Best time left today: 3:00 PM–6:00 PM"), the
7-day outlook row (Today 84 … Wed 98), and the waves card ("~3.3 ft · Rough
surf · estimated") all visible. Update the manifest hash for this asset.

## 3. Subcopy one size up (all pages)

The line under each headline (e.g. "Strike distance, direction and timing.")
is hard to read at App Store thumbnail size. Raise it one step (about 10–15%)
on every page, same font and color. Do not let it collide with the phone or
the first card; move the phone down a few px if needed, never crop the
headline.

## 4. Leave as is

Pages 02, 03, 04, 05, 06, 08 — content and layout are approved. Only the
subcopy size change from item 3 applies to them.

## Deliver

Re-exported `exports/01-know.*` and `exports/07-plan.*` (and the six others
if item 3 changed their pixels), refreshed `contact-sheet.jpg`,
`contact-strip.jpg`, `preview/`, `manifest.json`. Confirm every export is
still exactly 1290×2796, RGB, sRGB, and that every app panel still matches
its source capture byte-for-byte except crop and scale.

---

# Round 4 — one alignment fix on page 01 (2026-10-09)

Everything on frame 01 is left-aligned to the headline margin except the
three rows of feature chips at the bottom (CAMS … UV), which are centered.
Left-align those rows to the same left margin as the headline, the subline,
the top source-chip row and the "PLUS THE DETAILS THAT MATTER" label. Keep
the chip order, sizes, gaps and row breaks as they are; only the row start
position changes. Nothing else on any frame changes.

Re-export frame 01 only (`exports/01-know.*`, `preview/01-know.jpg`), then
refresh `contact-sheet.jpg`, `contact-strip.jpg` and `manifest.json`. Confirm
frames 02–08 stay byte-identical and frame 01 is still 1290×2796 RGB sRGB.
