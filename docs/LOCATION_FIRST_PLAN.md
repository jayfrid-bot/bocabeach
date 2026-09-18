# Location-first conditions — build plan

**Status:** phase 1 in progress (2026-09-18). Reviewed by Codex on 2026-09-18; its changes are folded in below and supersede the first draft.

## Bottom line (post-review)

The score stays anchored to the **selected beach**. The person's real position is used for the two hazards that are genuinely local — **rain and lightning** — in alerts and in a separate "at your location" hazard state. Hazard logic becomes **one shared assessment** that both the score's caps and the alert engine consume, with **hysteresis** so a storm hovering at a threshold cannot make the score flicker. No second location-derived score. No arbitrary-point conditions snapshot. Station auto-selection and point-only beaches are later work behind explicit safety rules.

## What the review changed, and why

| First draft said | Codex found | Decision |
|---|---|---|
| Two buckets: point physics vs place facts | Three: person point; beach/coastal context (marine model, shore orientation, rip risk, flags, water, cams); assigned observations (buoys, gauges, sites). Marine model and rip risk are NOT point-safe (`fetchMarine`, `fetchRipRisk`). Radar and GOES feeds are built per beach, not point-queryable. | Adopt the three buckets. Only rain + lightning move to the person in phase 1. |
| Person's cell drives physics, beach supplies facts, manual pick overrides beach | A manual pick of Boca from New York would mix NY weather with Boca flags. | A manual destination anchors the **whole** score to that beach. Device geometry replaces beach geometry only for hazards, and only when a fresh, accurate fix is near the beach (`decideArm`, `fixOf` rules stay). |
| Canonical beach score + personal score | Multiplies against the existing Everyone's / Your (profile) split into four variants. | One beach-anchored score. Show device-local hazards separately. |
| 0.02° cells, 2-min TTL, "physics is the cheap half" | Unmeasured; per-source cadence exists already; existing 0.05° grid (`lib/location/cell.ts`). | Cells only for rain/nowcast at 0.05°; lightning from the exact fix against the shared feed; measure occupied cells before anything wider. |
| Sticky caps as a small prerequisite | Needs observation history, not a request-mutated KV latch. Score and alert engine already disagree (score pairs `nearestMi` with a *different* strike's age). | Record "last wet" in the upstream radar product; lightning hold from the strike's own age; one `HazardAssessment` for both engines. |
| Lite beaches with a label | Renormalized weights make a data-poor beach look confidently good (`scoreBeachDay`). `Location` type requires stations/cams. | Deferred. Needs a minimum-data contract + confidence rules first. |

## Phase 1 — "one truth for hazards, and it holds"

### 1a. Shared hazard assessment — `lib/hazards/assess.ts` (new, pure)

```ts
export type HazardAnchor =
  | { kind: "beach"; slug: string }
  | { kind: "point"; lat: number; lon: number; cell: string }; // cell = cellKey(lat, lon)

export interface HazardAssessment {
  kind: "lightning" | "rain";
  anchor: HazardAnchor;
  /** The cap/alert should apply now (observed now OR still inside the hold). */
  active: boolean;
  /** true when active only because of the hold window (nothing observed this instant). */
  latched: boolean;
  severity: "none" | "rain" | "storm" | "lightning-near";
  observedAtIso: string | null; // the observation the state rests on
  expiresAtIso: string | null;  // when the hold lapses if nothing new is seen
  /** Short, user-facing reason, e.g. "Lightning within 5 miles, 12 min ago". */
  reason: string | null;
}
```

**Lightning** — `assessLightning({ status, closeStrikeMinutesAgo, windowMinutes, nearestMi, nearestMinutesAgo, nowMs, anchor })`:
- `lib/sources/lightning.ts` `summarizeStrikes` exposes `closeStrikeMinutesAgo`: the age of the **most recent strike within 5 mi** of the point (undefined if none in the feed window). Active when the feed is OK and `closeStrikeMinutesAgo ≤ LIGHTNING_HOLD_MIN = 30`. This is the hold and the recency fix in one: the decision no longer depends on whichever strike happens to be nearest *right now* (4.8 → 5.2 → 4.8 mi cannot toggle it), and it never pairs one strike's distance with another strike's age (the bug the review found in `deriveMetrics`).
- The GLM feed window is 30 min (`scripts/glm_lightning.py` `WINDOW_MIN`, feed field `windowMinutes`), so strikes leave the feed exactly when the hold lapses; the hold is stateless because of that coupling. If `windowMinutes < 30` the effective hold is capped at the window — never claim a hold the data can't back.
- `latched` = active and `closeStrikeMinutesAgo > 5` (nothing in the last scan interval, still holding). `nearestMi` / `nearestMinutesAgo` are display-only inputs for the reason text.

**Rain** — `assessRain({ radar, nowcast, weatherCode, shortForecast, cloudPct, nowMs, anchor })`:
- Inputs are the same signals `deriveMetrics` uses today (nowcast state, corroboration: rain-ish weather code / cloud ≥ 50% / etc., radar frame age, `rainNowMmHr`, `nearestRainKm`) plus the new radar field `lastWetIso`.
- "Radar wet now" = `rainNowMmHr ≥ RAIN_WET_MM_HR` (0.5 mm/hr, one exported constant in `lib/hazards/assess.ts`, mirrored in `scripts/mrms_precip.py`) or `nearestRainKm ≤ 5`. The same threshold defines the alert engine's literal "raining" and the MRMS job's `lastWetIso`, so a 0.1 mm/hr trace can neither cap the score nor latch a 20-minute hold while the push engine says it is not raining. (The old dry veto's `=== 0` rule is retired; a trace now reads as dry, matching the alert engine.)
- The GLM producer (`scripts/glm_lightning.py`) caps the feed at 20,000 strikes most-recent-first; to keep the 30-minute hold honest on a heavy CONUS day it always retains every strike within 50 mi of a served beach for the full window and caps only the remainder, and reports `retention` {cap, total, kept, nearBeachKept} in the feed.
- "Radar wet recently" = `lastWetIso` within `RAIN_HOLD_MIN = 20`.
- Active when: radar wet now; **or** radar wet recently (latched); **or** nowcast says raining and is corroborated and radar does not *confidently* veto. The dry veto is confident only when the frame is fresh (≤ 25 min), dry now, **and** not wet recently.
- severity `storm` when a storm signal corroborates (weather code 95–99 or storm/thunder in the forecast text), else `rain`.
- The rain assessment also exposes `confidentDryVeto` so `lib/score.ts` sets `radarDryNow` from it instead of re-deriving the rule (one truth; no drift). Strike corroboration for rain uses `hazardLightning.active`, never a separate distance/age pairing.
- Missing `lastWetIso` (feed not yet upgraded) → behave exactly as today (no hold), never throw.

### 1b. Score consumes it — `lib/score.ts`
- `deriveMetrics` calls `assessLightning` / `assessRain` for the beach anchor and sets the existing fields from the result: `lightningWithin5mi = lightning.active`, `nowcastRaining = rain.active && !latched-only-forecast…` — keep the field names so `applyBeachCaps` changes are minimal; add `hazardLightning` / `hazardRain` to `Derived` for the reason strings.
- `applyBeachCaps` cap copy: "Lightning within 5 miles — get out of the water" (observed) / "Lightning within 5 miles in the last 30 minutes" (latched); "Raining right now" / "Rain in the last 20 minutes" (latched); storm variants unchanged.
- Hourly forecast scoring (future buckets) is untouched — holds apply to the now-bucket only, as `radarDryNow` does today.

### 1c. Radar product records "last wet" — `scripts/mrms_precip.py` + `lib/sources/precipRadar.ts`
- The MRMS job (GitHub Action → `mrms-data` branch, ~10-min cadence) writes, per beach, `lastWetIso`: the time of the **newest wet frame among every frame it decoded this run** (not only the newest frame — a throttled Action must not lose a wet frame from 10 minutes ago). It persists across runs by fetching the previously published `mrms-data` JSON at start (fail-soft: unavailable → carry nothing) and takes the later of "newest wet frame this run" and the carried value; carry-forward never moves the timestamp backwards and never invents one.
- `precipRadar.ts` parses `lastWetIso` (validated ISO, else null) and exposes `wetMinutesAgo` computed at read time (server clock, never the job's; small future-skew tolerance). When a publication has no current frame (job failure right after rain) but a valid `lastWetIso`, the adapter still returns data with `wetMinutesAgo` set and every current-frame field null and a non-ok status — the hold survives, and nothing can read "wet now" from it.
- Feed consumers must tolerate the field being absent (old feed) for the rollout window.

### 1d. Alerts consume the same assessment — `lib/alerts/evaluate.ts`, `lib/alerts/run.ts`, `lib/alerts/rain.ts`
- `lightningSubjects` builds its inputs from the person's fix (as today), passes `closeStrikeMinutesAgo` into `assessLightning` with a `point` anchor (or `beach` when `fixOf` fell back to the centroid); the hazard subject fires iff `active`. Escalation semantics (in-2-mi supersedes plain lightning) unchanged.
- Rain: radar is not point-queryable today, so the alert rain truth comes from the **beach** radar and is labeled anchor `beach`; only the cell-forecast fallback (Open-Meteo minutely for the fix's 0.05° `cellKey`) is labeled `point`. Anchors are never claimed that the data can't back.
- `RainRead` carries three things and they are not conflated: literal `rainingNow` (the observation), `hazardActive` (assessment, incl. hold), `latched`. The rain-wet mark is written only on literal rain; "clearing" is held back while `hazardActive`; a latched-only state never erases an upcoming rain-soon ETA. Beach-scoped dedup keys (LOC-08) unchanged.
- The per-cell cache holds **only the raw cell forecast**; the assessment and `RainRead` are built per caller (per beach radar) outside the cache, so two beaches sharing a cell can never inherit each other's hold. The radar latch is assessed independently of the forecast fetch: if the forecast fails, alerts still get `hazardActive`/`latched` from the radar (ETA/clearing null), matching what the score keeps.
- Lightning's hold is stateless because GLM strikes are raw per-flash coordinates (rounded to 3 decimals, never clustered) and the feed window equals the hold; an end-to-end test runs the real `summarizeStrikes` over a 40-minute sequence and asserts exactly one on→off transition.
- Result: score caps and push subjects are computed from the same rule and the same observation.

### 1e. "At your location" hazard state (native app, foreground) — after 1a–1d land
- Native-only, rate-limited `GET /api/hazards?lat&lon` returning the two assessments for a `point` anchor. Fresh/accurate fix required (reuse `establishesArrival` gates); web never calls it.
- Beach Mode card shows a single line when it differs from the beach: "Where you stand: lightning 3.8 mi, 6 min ago" / "Where you stand: raining". The score itself does not change.
- Privacy page: state that a location fix is sent while the app is open with location on, only to read local rain/lightning, never stored beyond the existing presence record.

### Out of phase 1 (tracked, not built)
- Station registries with distance/coast/quality constraints (capability map exists: `lib/sources/ndbcStations.ts`).
- Cell-cached physics beyond rain/nowcast; occupied-cell instrumentation first.
- Point-only beaches (needs minimum-data + confidence rules; evolve the `Location` tier model).
- Amend `docs/PLUS_BUILD_SPEC.md` §conditions to record: caps hold; hazards are one shared assessment; device geometry is used for rain + lightning hazards only.

## Acceptance for phase 1
- A strike at 4.8 mi 5 min ago → capped; the same strike 31 min ago → not capped; nearest strike 6.4 mi with a farther strike 2 min ago → not capped (recency bug fixed).
- Radar dry now but wet 10 min ago → still capped, cap text says "in the last 20 minutes"; wet 25 min ago → clear; feed without `lastWetIso` → today's behavior.
- Score and alert engine produce the same active/inactive answer for the same inputs (shared fixture test).
- No flicker: consecutive assessments across a threshold-hovering fixture sequence never toggle more than once per hold window.
- Existing tests, `tsc`, and the layout check stay green; changelog entry ships with it.
