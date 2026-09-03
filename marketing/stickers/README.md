# Sticker art — 2" × 2"

Print-ready art for die-cut vinyl stickers. Canvas is 2.25" square (2" finished + 1/8" bleed on every side), rendered at 600 DPI (1350 px). Upload the plain PNGs; the `-guides` versions only show the cut line (red) and safe zone (green) and are not for printing.

- `isitbeachday-sticker-round.png` — 2" circle
- `isitbeachday-sticker-square.png` — 2" square, 0.25" rounded corners
- `.svg` files are the editable vectors (fonts: Fredoka 700, Nunito 800 from Google Fonts)

Regenerate: `cp marketing/stickers/generate.mjs .sticker-tmp.mjs && node .sticker-tmp.mjs marketing/stickers && rm .sticker-tmp.mjs` (needs the repo's Playwright).

## QR versions (recommended for print)

- `isitbeachday-sticker-round-qr.png` / `square-qr.png` — the QR code is the sun: white panel, 4-module quiet zone, sun logo over the centre (error-correction level H, so the logo costs nothing). Encodes `HTTPS://ISITBEACHDAY.COM` (uppercase = alphanumeric mode = a smaller, easier-to-scan symbol; hosts are case-insensitive). Version 3-H, 29 modules, ~0.6 mm per module at 2".
- `qr.json` is the module matrix (made with `segno`); `generate-qr.mjs` renders; `scan-test.mjs` decodes the finished PNGs with jsQR at 2", 1", 0.73" to prove they read.
