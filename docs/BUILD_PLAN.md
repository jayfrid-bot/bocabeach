# Build plan (2026-09-22)

Sizes are agent-build days (Sonnet crews, Fable orchestrating, Codex review on anything big). Details live in the linked plan docs; this page is the order and the sizes.

## Waiting on the owner (no build)
- **1.1 billing release:** sandbox purchase on TestFlight 2026090701 → three App Store Connect clicks (attach both subscriptions to 1.1, privacy label, agreement) → "submit". Draft is staged. *This is the only thing between the app and revenue.*
- **Open-Meteo plan:** Standard ~$29/mo or Professional ~$99/mo, due the day 1.1 goes live (`docs/research/2026-09-20-open-meteo-cost-and-alternatives.md`).

## Now — committed (≈ 2 weeks)
| # | Item | Days | Notes |
|---|---|---|---|
| 1 | Point the app at Open-Meteo's paid endpoint | 0.5 | after the subscription exists |
| 2 | NOAA full-disk radiation check → GOES radiation feed if it works | 0.5 + 1–2 | decides $29 vs $99 |
| 3 | **History collector** (storage only) | 2–3 | `docs/HISTORY_AND_IMAGERY_PLAN.md` Part A, Codex-revised: UTC hourly rows, separate cam table, own cron path |
| 4 | Deerfield + Fort Lauderdale cam reads stopped 2026-09-18 | 0.5–1 | data being lost now |
| 5 | Station guard for all 39 beaches + South Padre fallback | 0.5 | today it covers 3 |
| 6 | Rate-limit the public `/api/resolve` | 0.5 | |
| 7 | Sitemap `lastModified` + coverage-honest page metadata | 0.5–1 | SEO hygiene before more pages |
| 8 | **Live Activities phases 0–1** (extension target, signing, lock-screen UI in the simulator) | 5 | `docs/LIVE_ACTIVITY_PLAN.md`; runs while 1.1 is in review |

## Next — after 1.1 is approved (≈ 4 weeks)
| # | Item | Days |
|---|---|---|
| 9 | Live Activities phases 2–4 (bridge, server push, lightning hero) → **submit 1.2** (new native build + review) | 8–10 |
| 10 | Score completeness rule — a data-poor beach can't read "Excellent" (live on 36 auto beaches today) | 2–3 |
| 11 | "Where you stand" rain/lightning line in the app (`/api/hazards`, native-only) | 2–3 |
| 12 | Plus history screens (calendar, typical crowds, seaweed season) | 5 |
| 13 | Satellite-as-data spike against Boca's 1,073 cam reads | 2–3 |

## Later — optional (≈ 5–6 weeks if all of it)
| # | Item | Days |
|---|---|---|
| 14 | Location phase 2: coast segments, per-metric station candidates, station health, async beach setup, two explicit modes, drop-a-pin, bigger beach list, coverage-aware SEO (`docs/LOCATION_FIRST_PLAN.md` Phase 2) | 15–20 |
| 15 | Satellite imagery gallery (only if the spike passes) | 5 |
| 16 | Replace Open-Meteo fully with free sources (UV + aerosol remain gaps) | 6–9 |
| 17 | Android release (Play key + AAB) | 1 + owner |

## Housekeeping (small, no order)
Decommission the Netlify twin · paid vision tier for cams (Gemini ~$7/mo) · Workers Paid $5/mo for KV limits · consolidate `lib/rainNowcast.ts` rain constant.

**Rule:** revenue first (1.1), then the licence that revenue creates, then data we can't get back (history, cams), then the feature that sells Plus (Live Activities), then everything else.
