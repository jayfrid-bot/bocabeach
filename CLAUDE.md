# CLAUDE.md — Boca Beach Rats

Next.js (App Router) + TypeScript + Tailwind app that consolidates live beach
conditions and computes composite **Surf** and **Beach Day** scores. Designed to
scale from Boca Raton to every beach town.

## Architecture (read these first)
- `config/locations.ts` — the source of truth. Adding a town = adding one entry.
- `lib/types.ts` — shared domain types; every source returns `Wrapped<T>` with a status.
- `lib/sources/*` — one adapter per data source. **Each must catch its own errors and
  return a `Wrapped<T>` (never throw to the UI).** Pure parsers (`parseNdbcRealtime`,
  `parseNoaaPredictions`, `parseCityConditions`) are split out and unit-tested.
- `lib/conditions.ts` — fetches all sources in parallel and assembles the snapshot.
- `lib/score.ts` — `deriveMetrics` consolidates best-available values; `computeScores`
  produces both scores with sub-score breakdowns and safety caps.
- `app/api/conditions/[slug]/route.ts` — cached JSON API and the data the pages use.
- `components/ConditionsDashboard.tsx` — client shell (Surf/Beach Day toggle + SWR polling).

## Conventions
- All external data is fetched **server-side** with per-source `next.revalidate` caching.
- Units are normalized to imperial in the adapters; conversions live in `lib/util.ts`.
- New data source => new `lib/sources/x.ts` returning `Wrapped<T>` + a fixture-based test.

## Commands
```bash
npm install
npm run dev
npm test          # Vitest (parsers + scoring)
npm run lint
npm run build
```

## Guardrails
- Don't embed Surfline cams or scrape their video (link out only).
- Keep scores as guidance; lifeguard flags are authoritative safety overrides.
