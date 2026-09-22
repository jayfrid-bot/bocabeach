# Build plan (2026-09-22)

Sizes are agent-build days (Sonnet crews, Fable orchestrating, Codex review on anything big). Details live in the linked plan docs; this page is the order and the sizes.

## Waiting on the owner (no build)
- **1.1 billing release:** sandbox purchase on TestFlight 2026090701 → three App Store Connect clicks (attach both subscriptions to 1.1, privacy label, agreement) → "submit". Draft is staged. *This is the only thing between the app and revenue.*
- **Open-Meteo plan — owner decision 2026-09-22: stay on the free tier for now; switch to a paid plan once there are paying customers** (`docs/research/2026-09-20-open-meteo-cost-and-alternatives.md`). Consequence: everything that adds upstream calls (the history collector) must stay well under the free tier's 10,000 calls/day.

## Now — committed (≈ 2 weeks)
| # | Item | Days | Notes |
|---|---|---|---|
| 1 | ~~Paid Open-Meteo endpoint~~ | — | dropped for now (owner) |
| 2 | NOAA full-disk radiation check → GOES radiation feed if it works | 0.5 + 1–2 | optional; only matters once a paid plan is chosen |
| 3 | ✅ **History collector** — LIVE 2026-09-22 (worker cb948a16, history-cron every minute, 1,144 cam observations backfilled) | done | `docs/HISTORY_AND_IMAGERY_PLAN.md` Part A, Codex-revised: UTC hourly rows, separate cam table, own cron path |
| 4 | ✅ Deerfield + Fort Lauderdale cam reads — courier recovered, Groq fallback model id fixed | done |
| 5 | ✅ Station guard for all 39 beaches (67 stations classified) + South Padre → 42092 | done |
| 6 | ✅ `/api/resolve` rate-limited (10/h/IP) + input validation | done |
| 7 | ✅ Sitemap `lastModified` stable + coverage-honest descriptions | done |
| 8 | ⏳ **Live Activities phases 0–1** (extension target, lock-screen UI in the simulator) — IN PROGRESS from 2026-09-22 | 5 | `docs/LIVE_ACTIVITY_PLAN.md` |

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

**Owner's definition of done (2026-09-22):** every feature discussed works properly, no bugs, and the app stays as simple and clean as it is now. Any change that would regress something gets flagged before it is made.

**Rule:** revenue first (1.1), then the licence that revenue creates, then data we can't get back (history, cams), then the feature that sells Plus (Live Activities), then everything else.
