# Hat embroidery art

Flat-colour marks built for a needle, not a printer. The sticker art in
`../stickers/` cannot be stitched: embroidery has no gradients, and a QR code
cannot be threaded at hat scale and stay scannable.

## Artwork, not a stitch file — read this first

These are **artwork** files. They are NOT machine embroidery files (`.DST`,
`.PES`, `.EXP`, `.JEF`). Turning artwork into stitches — "digitizing" — is a
skilled step done in embroidery software (Wilcom/Hatch) that decides stitch
paths, underlay, direction, density and pull compensation. **Your embroiderer
or print-on-demand service does this for you, and Printify and Embroly both
digitize for free and email a proof before they stitch.** So the deliverable
here is the art you hand them; the `.DST`/`.PES` comes back from them.

## Files to send a decorator / upload to a POD

| File | Use |
|---|---|
| `isitbeachday-hat-lockup-for-navy-cap.png` | Front panel on **navy / black**. Transparent, 600 dpi. |
| `isitbeachday-hat-lockup-for-light-cap.png` | Front panel on **stone / khaki / white**. Transparent, 600 dpi. |
| `isitbeachday-hat-icon-only.png` | Sun + waves alone, for a side panel or the back. Transparent, 600 dpi. |

**Upload / send the transparent PNG.** It is 600 dpi with the font baked in, so
it is fully self-contained — the format every POD and digitizer accepts. The
matching `.svg` is the editable vector source, but its lettering references the
**Fredoka** font (text is not outlined), so an SVG opened without that font
loses the words — prefer the PNG unless your decorator has Fredoka installed.
The `preview-*-cap.png` files show the art on cap-fabric colours at true size,
for eyeballing only.

## What to tell them

- **Size:** 4.0" wide x 2.0" tall on the front panel. That is inside the usual
  4.5" x 2.25" limit for a structured cap. The icon-only mark is 2.0" x 1.4".
- **Flat embroidery**, not 3D puff. Puff swallows the wave detail and costs more.
- **Thread colours** — 5 on dark fabric, 4 on light:
  - Gold `#F5B82E` (sun + rays)
  - Aqua `#4FC3E8` light / `#7FD9F0` on dark
  - Blue `#1E7BB0` light / `#35A3D4` on dark
  - Deep `#10283A` navy on light / `#1B7BAE` on dark
  - Letters: navy `#10283A` on light fabric, cream `#FFF6E3` on dark
- Ask for a **digital proof** before they run the batch.

## Design rules this art already obeys

Canvas is 1200x600 px = 4" x 2" at 300 dpi, so 1 mm = 11.8 px.

- No gradients, no opacity, no thin hairlines — every stroke is >= 22 px (~2 mm).
- Rays sit on the **top arc only**. Rays below the horizon tangled with the wave
  bands in the first proof and read as clutter.
- Wave palette differs per fabric. The first navy proof used navy for the deep
  band and it vanished into the cap.
- Letters are ~11 mm cap height, well above the ~5 mm floor where embroidered
  type turns to mush.

Regenerate: `cp marketing/hats/generate.mjs .h.mjs && node .h.mjs marketing/hats && rm .h.mjs`
