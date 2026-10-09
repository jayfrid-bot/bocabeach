# Is It Beach Day? — Astra redesign

Eight premium coastal App Store screenshots. Prepared 2026-10-09 for review; nothing pushed, published, or submitted to App Store Connect.

## Current revision — a 95-point, all-green day

At the owner's request, frame 01 now shows an illustrative excellent-day state. The production `scoreBeachDay` engine calculates 95 from the editable fixture in `source/demo-95.tsx`. All ten factors score at least 90 and therefore use the app's emerald green. Its low rip risk, green flag, light waves and absence of advisories produce a green swim-safety status through the real safety logic. This sample is not a live observation for a named beach.

The wheel is the actual production `ScoreWheel` React SVG, rendered locally; the surrounding card is a vector transcription of the app's typography, spacing and colors. The original 90-point capture is preserved untouched in `assets/01-app.png`. The new sample panel is `assets/01-app-95-demo.png`, with an editable SVG alongside it. No app UI was sent through image generation. All 28 SVG, JPG, PNG and preview files for frames 02–08 remain byte-identical to the preceding revision.

Rebuild the sample panel with `node screenshots/appstore/1.2/redesign-astra-2026-10-09/source/render-demo.cjs`, then run the frame-only compose and verification commands below.

## Previous revision — frame 01 reference redesign

Frame 01 now communicates the user's supplied source-to-score concept in the Astra coastal style. Five prominent source chips (NOAA, NWS, BUOYS, SATELLITE, RADAR) feed visually into an enlarged, unchanged app score panel. Ten supporting condition chips sit below in three rows: CAMS, TIDES, FLAGS, LIGHTNING, WATER QUALITY, SAND TEMP, RIP CURRENTS, SEAWEED, CROWDS, UV. Those supporting chips are unconnected so they are not represented as individual score inputs. The original headline and requested “20+ live feeds. One score. / Just decide.” copy are retained. The 20+ claim follows the owner's stated 22-feed count in `FIX-REQUEST.md`.

That revision retained the real Deerfield score of 90 and its moderate rip-current caution. The current user-requested 95-point sample supersedes that panel. Astra reviewed the reference-based composition. Frames 02–08 retain identical SVG, JPG, PNG, and preview bytes from round 2.

The reference was found and visually opened at `/Users/yitzfrid/Dropbox (Personal)/ChatGPT Image Oct 9, 2026, 03_29_12 PM.png`; its local copy and hash are recorded under `reference-round3/` and `manifest.json`. Earlier Library-download blockers were resolved by this user-provided local copy.

For a frame-01-only rebuild that also refreshes the contact sheet and strip:

```sh
node screenshots/appstore/1.2/redesign-astra-2026-10-09/source/compose.cjs --frame=01
node screenshots/appstore/1.2/redesign-astra-2026-10-09/source/verify.cjs
```

## Requested revision — round 2

Applied `FIX-REQUEST.md`: page 01 retains its headline and now reads “20+ live feeds. One score. / Just decide.” All eight text-only ivory feed chips fit on one line inside the safe margins. Every headline subline is now 47 px, up from 42 px (+11.9%); font and color are unchanged. Page 07 uses the unchanged `07-plan-v4-fort-lauderdale.png` capture from 2026-10-09, including the 3–6 PM best-time pill, Today 84 / Wednesday 98 forecast, and ~3.3 ft waves card. Its phone is 30 px narrower and 32 px higher so the complete waves card fits despite the new capture's additional “Last 7 days” section. Pages 02–06 and 08 otherwise retain their approved layouts and content.

## Deliverables

- `exports/01-know` through `exports/08-sunset`: eight 1290 × 2796 JPGs and eight matching opaque RGB PNGs, in sRGB.
- `contact-sheet.jpg`: four-by-two overview.
- `contact-strip.jpg`: eight-frame swipe sequence.
- `preview/`: half-size JPGs for fast review.
- `source/*.svg`: eight self-contained editable artworks with live text and embedded original image layers.
- `source/compose.cjs`: master editable layout, typography, copy, image positions, and export script.
- `assets/`: preserved original app captures, the new 95-point demo panel, app icon, and four generated photographic backgrounds.
- `source/prompts.md`: background generation prompts and provenance.
- `manifest.json`: source mappings, file hashes, export properties, and preservation checks.

## Design

Astra directed and visually reviewed the set. The direction is premium coastal travel editorial: bold Avenir Next headlines, Atlantic navy, warm ivory, restrained lime/citrus accents, and original shoreline photography. The sequence alternates large phone views with enlarged, authentic app panels.

Frames 02–08 embed the repository's verified source captures with crop and scale only. Frame 01 uses the requested illustrative 95-point state described above, retaining the real score component. The phone shell is a presentation frame. Photography outside the UI is decorative generated atmosphere, not a claim about the displayed beach or a live camera feed. The camera images inside the UI remain the original captures.

The personal score is labeled Beach Day Plus. The rip-current frame describes risk forecasts and clearly defers to lifeguard flags. Lightning copy describes distance, direction, and timing. The camera copy avoids a continuous-video claim. Sunset color remains a forecast.

## Editing and rebuilding

Edit `source/compose.cjs` for layout or copy, then run from the repository:

```sh
node screenshots/appstore/1.2/redesign-astra-2026-10-09/source/compose.cjs
```

The script uses the repository's installed `sharp` package, not a browser or computer-control session. The SVGs keep text editable; use Avenir Next (available on this Mac) for the intended appearance. Helvetica Neue and Arial are fallback fonts. For identical appearance on another machine, use the provided raster exports or install the same font. No fonts are redistributed.

## Validation

Visual review was completed at contact-sheet and individual-frame size, including a separate Astra review. Final refinements tightened copy, thinned the phone rim, restored Lock Screen masthead contrast, removed a partial preceding card from the planning crop, and matched the sunset panel's rounded contour. Every export is exactly 1290 × 2796, has three RGB channels with no alpha, and uses sRGB. All eight original final JPGs still match commit `e3b7295c82e4e17301b9a7a975fa705595b5aee9` byte-for-byte at the Git object level. No application code was changed.

The initial headless browser launch was blocked by the local sandbox. That launch was not retried with elevated privileges. All successful exports use local SVG rasterization, which does not open or control a browser. No pending computer-access approval was consumed or bypassed.
