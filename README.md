# Boca Beach Conditions 🏖️🌊

Live local beach conditions for **Boca Raton** and **Deerfield Beach, FL**, consolidated
into one page each with a single composite **Beach Day** score (for beachgoers — no
surfing). Built config-first so adding a new beach town is a single entry — the long-term
goal is *every* beach town.

## What it shows

- **Tides** — next high/low (NOAA CO-OPS)
- **Water temperature & live wind** — nearest NDBC buoy (LKWF1)
- **Air temp, wind, sky, rain chance** — NWS `api.weather.gov`
- **Waves / swell / period / sea-surface temp / UV** — Open-Meteo
- **Official lifeguard report** — beach warning **flags**, swim/snorkel ratings,
  marine life & hazards (scraped from the City of Boca Raton Ocean Rescue page)
- **Water quality** — FL Healthy Beaches enterococci sampling, mapped to good/moderate/poor
- **Beach & surf cams** — public cams for the area (embedded inline where the host allows
  framing; Surfline and frame-blocking hosts link out), each with **live weather & wind**
  pulled from Open-Meteo at the cam's own coordinates

A single composite **Beach Day** score (0–100), weighted for beachgoers:

| Sub-score | Weight |
|-----------|:------:|
| Air temperature | 22% |
| Sky / precipitation | 22% |
| Wind (calmness) | 18% |
| Water temperature | 15% |
| Sea state (swim calmness) | 10% |
| Water quality | 8% |
| UV index | 5% |

Official lifeguard **flags act as safety overrides**: a red flag caps the score (≤40),
double-red drives it to ~0, and a water-quality advisory caps it (≤40). The purple
(marine-pest) flag is **shown in the safety banner for awareness but does not affect the
score** — it's near-constant in South Florida, so it carries no day-to-day signal.

## Tech

Next.js (App Router) + TypeScript + Tailwind. All data is fetched **server-side** (avoids
CORS, centralizes caching) by isolated adapters in `lib/sources/*`, aggregated in
`lib/conditions.ts`, scored in `lib/score.ts`, and exposed at `GET /api/conditions/[slug]`.

```
config/locations.ts   # add a town here — drives everything
lib/sources/*          # one adapter per data source (each degrades gracefully)
lib/conditions.ts      # parallel fetch + assemble snapshot
lib/score.ts           # Beach Day score with weighted breakdown & safety caps
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
for the optional Stormglass key, the FL Healthy Beaches DataPage override, and the
`User-Agent` used for NWS.

## Add a beach town

Add an entry to `LOCATIONS` in `config/locations.ts` (Deerfield Beach is the worked
example already shipped there):

```ts
{
  slug: "deerfield-beach",
  name: "Deerfield Beach",
  region: "Broward County, FL",
  lat: 26.317, lon: -80.0748,
  timezone: "America/New_York",
  noaaTideStationId: "8722816",       // nearest NOAA tide station
  ndbcBuoyId: "LKWF1",                 // nearest NDBC buoy
  offshoreWindFromDeg: 270,            // beach faces east -> offshore wind from the west
  healthyBeaches: {                    // FL DOH county + SPLocation site names
    county: "Broward",
    sites: ["DEERFIELD BEACH PIER", "DEERFIELD BEACH SE 10TH ST"],
  },
  cams: [ /* iframe (YouTube/embeddable) or link cams */ ],
}
```

That's it — the route, scoring, and UI all pick it up automatically. (Find the exact
`SPLocation` names per county from the FL DOH feed:
`https://services1.arcgis.com/CY1LXxl9zlJeBuRZ/arcgis/rest/services/FloridaBeachSamplingPoints/FeatureServer/0/query?where=County='Broward'&outFields=SPLocation,Active&f=json`.)

## Known gaps / next steps

- **Lifeguard flags for new towns**: Boca Raton scrapes its Ocean Rescue page for warning
  flags; towns without a `cityConditionsUrl` (e.g. Deerfield Beach) show no flags and so
  apply no safety caps. Add a flag source per town as one is found.
- **Tide phase for surf**: the surf tide sub-score is a generic mid-tide constant;
  add per-spot tide preferences for real accuracy.

## Deploy (Netlify)

This app deploys to **Netlify** using the official Next.js runtime — `netlify.toml` and
`.nvmrc` are committed, so it's zero-config:

1. Push to GitHub and **Add a new site → Import an existing project** in Netlify, picking
   this repo. Netlify reads `netlify.toml` (`npm run build`, Node 20, the
   `@netlify/plugin-nextjs` plugin) and auto-installs the plugin.
2. No environment variables are required. Optionally set `CONDITIONS_USER_AGENT`,
   `FL_HEALTHY_BEACHES_APPKEY`, or `STORMGLASS_API_KEY` (see `.env.example`) under
   **Site settings → Environment variables**.
3. SSG pages, the `/api/conditions/[slug]` route, and per-source `next.revalidate`
   caching all work on Netlify's Next.js runtime.

Or from the CLI: `npm i -g netlify-cli && netlify deploy --build` (use `--prod` to
publish).

---

*Composite scores are an automated estimate for general guidance only — not a safety
determination. Always follow posted flags and lifeguards.*
