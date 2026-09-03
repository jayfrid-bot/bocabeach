# Sticker art — 2" × 2"

Print-ready art for die-cut vinyl stickers. Canvas is 2.25" square (2" finished + 1/8" bleed on every side), rendered at 600 DPI (1350 px). Upload the plain PNGs; the `-guides` versions only show the cut line (red) and safe zone (green) and are not for printing.

- `isitbeachday-sticker-round.png` — 2" circle
- `isitbeachday-sticker-square.png` — 2" square, 0.25" rounded corners
- `.svg` files are the editable vectors (fonts: Fredoka 700, Nunito 800 from Google Fonts)

Regenerate: `cp marketing/stickers/generate.mjs .sticker-tmp.mjs && node .sticker-tmp.mjs marketing/stickers && rm .sticker-tmp.mjs` (needs the repo's Playwright).

## QR versions (recommended for print)

- `isitbeachday-sticker-round-qr.png` / `square-qr.png` — the QR code is the sun: white panel, 4-module quiet zone, sun logo over the centre (error-correction level H, so the logo costs nothing). Encodes `https://isitbeachday.com/sticker` — a real route (`app/sticker/route.ts`) that counts the scan in D1 and 307s to `/?ref=sticker`. Version 4-H, 33 modules, ~0.54 mm per module at 2". Uppercase would give a sparser version-3 symbol, but it decoded no better in testing and would need case-insensitive routing, so the readable lowercase URL wins.
- `qr.json` is the module matrix (made with `segno`); `generate-qr.mjs` renders; `scan-test.mjs` decodes the finished PNGs with jsQR at 2", 1", 0.73" to prove they read.

## Counting scans

```bash
npx wrangler d1 execute isitbeachday-plus --remote --command \
  "SELECT day, source, n FROM scan_log ORDER BY day DESC LIMIT 30"
```

The `?s=` tag on the link becomes `source`, so a second print run or a different placement can be told apart: `https://isitbeachday.com/sticker?s=coolers`.
