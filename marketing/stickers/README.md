# Sticker art — 2" × 2"

Print-ready art for die-cut vinyl stickers. Canvas is 2.25" square (2" finished + 1/8" bleed on every side), rendered at 600 DPI (1350 px). Upload the plain PNGs; the `-guides` versions only show the cut line (red) and safe zone (green) and are not for printing.

- `isitbeachday-sticker-round.png` — 2" circle
- `isitbeachday-sticker-square.png` — 2" square, 0.25" rounded corners
- `.svg` files are the editable vectors (fonts: Fredoka 700, Nunito 800 from Google Fonts)

Regenerate: `cp marketing/stickers/generate.mjs .sticker-tmp.mjs && node .sticker-tmp.mjs marketing/stickers && rm .sticker-tmp.mjs` (needs the repo's Playwright).
