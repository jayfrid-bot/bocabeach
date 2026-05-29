# Boca Beach Conditions 🏖️🌊

Live local beach conditions for **Boca Raton, FL**, consolidated into one page with a
composite **Surf** and **Beach Day** score. Built config-first so adding a new beach
town is a single entry — the long-term goal is *every* beach town.

## What it shows

- **Tides** — next high/low (NOAA CO-OPS)
- **Water temperature & live wind** — nearest NDBC buoy (LKWF1)
- **Air temp, wind, sky, rain chance** — NWS `api.weather.gov`
- **Waves / swell / period / sea-surface temp / UV** — Open-Meteo
- **Official lifeguard report** — beach warning **flags**, swim/snorkel/surf ratings,
  marine life & hazards (scraped from the City of Boca Raton Ocean Rescue page)
- **Water quality** — FL Healthy Beaches (best-effort; see note below)
- **Beach & surf cams** — every public cam for the area

Two composite scores (toggle in the UI):

- **Beach Day** — air/water warmth, calm wind & seas, sky, water quality, UV
- **Surf** — wave/swell size, period, offshore wind, tide, water temp

Official lifeguard **flags act as safety overrides**: a red flag caps the Beach Day score,
double-red drives it to ~0, and a purple (marine-pest) flag caps it and shows a banner.

## Tech

Next.js (App Router) + TypeScript + Tailwind. All data is fetched **server-side** (avoids
CORS, centralizes caching) by isolated adapters in `lib/sources/*`, aggregated in
`lib/conditions.ts`, scored in `lib/score.ts`, and exposed at `GET /api/conditions/[slug]`.

```
config/locations.ts   # add a town here — drives everything
lib/sources/*          # one adapter per data source (each degrades gracefully)
lib/conditions.ts      # parallel fetch + assemble snapshot
lib/score.ts           # Beach Day + Surf scores with breakdown & safety caps
app/[slug]/page.tsx    # beach dashboard (client shell: ConditionsDashboard)
app/page.tsx           # all-beaches landing
app/api/conditions/... # cached JSON API (also a public endpoint)
```

## Develop

```bash
npm install
npm run dev      # http://localhost:3000/boca-raton
npm test         # parser + scoring unit tests (Vitest)
npm run lint
npm run build
```

No API keys are required — every default source is free and keyless. See `.env.example`
for the optional Stormglass key and the `User-Agent` used for NWS.

## Add a beach town

Add an entry to `LOCATIONS` in `config/locations.ts`:

```ts
{
  slug: "deerfield-beach",
  name: "Deerfield Beach",
  region: "Broward County, FL",
  lat: 26.3173, lon: -80.0764,
  timezone: "America/New_York",
  noaaTideStationId: "8722929",
  ndbcBuoyId: "LKWF1",
  offshoreWindFromDeg: 270, // beach faces east -> offshore wind from the west
  cams: [ /* ... */ ],
}
```

That's it — the route, scoring, and UI all pick it up automatically.

## Known gaps / next steps

- **FL Healthy Beaches**: `lib/sources/waterQuality.ts` is a graceful stub (returns
  "no advisory"). Their site is client-rendered with no public API — wire up their
  internal data endpoint or a headless scrape and map enterococci CFU/100ml to
  good/moderate/poor.
- **Cams**: all currently link out. Some (e.g. the Palm Beach County video-monitoring
  feeds) may be iframe-embeddable — check `X-Frame-Options` and switch `embedType` to
  `"iframe"` per cam.
- **Tide phase for surf**: the surf tide sub-score is a generic mid-tide constant;
  add per-spot tide preferences for real accuracy.

## Deploy

Push to GitHub and import into **Vercel** (Next.js auto-detected; no env vars needed for v1).

---

*Composite scores are an automated estimate for general guidance only — not a safety
determination. Always follow posted flags and lifeguards.*
