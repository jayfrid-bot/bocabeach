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
- **One clock for the first render.** `lib/conditions.ts` scores the cached snapshot against `snapshot.generatedAt`, the same clock `ConditionsDashboard` hydrates from. Holds add time boundaries (30 / 20 min); if the server scored with the request clock instead, a boundary inside the ~2-min cache window made the server HTML and the client's hydration pass disagree on the cap text (React #418 on every page during the 2026-09-18 storm). The client re-scores with the live clock after mount.

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

---

# Phase 2 — any US beach, resolved on demand, verified live (proposal, 2026-09-20)

**Owner direction:** "If somebody puts in their location it should automatically pull the station data and only discard it if it doesn't meet the criteria." Two explicit modes: location-based, and fully manual with no location use. Every US beach available to pick.

## What already exists (measured 2026-09-20)
- `data/registry/beaches.us.json` — **956** coastal beaches (USGS GNIS, `coastalConfirmed`). Thin in places: FL has 46.
- `data/registry/buoys.json` — **1,930** NDBC stations with `hasWaves` / `hasWaterTemp`; `tide-stations.json` — **3,450** CO-OPS stations.
- `lib/resolve/*` — location → beach config: coastal gate (30 mi), capability-aware station pick (`stationRegistry.ts`: primary = nearest with water temp OR waves; fallback = nearest *wave*-capable), NWS zone, timezone, per-field source / confidence / distance report. It built the 36 `tier: "auto"` beaches. Admin-only today (`/admin/yf`), output committed as JSON.
- Live probe of every station those 36 beaches use: **35 of 36 receive observed waves right now.** The miss (South Padre Island) has an offline fallback (42020 → 404). Hand-written Boca had two wave-less stations. So the picker design is right; the failure mode is **static capability flags + stations that go offline, with nothing re-checking.**
- The CI coverage guard (`lib/sources/ndbcStations.test.ts`) covers only the 3 curated beaches — a gap.

## 2a. Pull it, keep it only if it passes — live-verified station selection
For each metric (observed waves, water temp, observed water level, tide predictions) the resolver builds an **ordered candidate list by distance** (not just primary + one fallback) and walks it until a station **passes**:
- reports the field with a real value within the freshness window (waves / water temp: numeric in the last 6 h; water level: last 2 h);
- inside the metric's distance ceiling (proposal: waves 75 mi, water temp 50 mi, water level 40 mi) and on the same coast (beach `coast` / `coastNormalDeg` vs station position — no picking a Gulf buoy for an Atlantic beach across the peninsula);
- not a prediction-only tide gauge when an observed value is wanted (the 8722816 trap).
Nothing passes → the forecast model, **labeled "estimated"** in the UI and recorded as such. Every chosen station stores provenance: id, distance, `verifiedAt`, what failed before it.
Runtime: `lib/sources/buoy.ts` already merges two stations field-by-field; generalize to the ordered list (cap 4) so a dead station degrades to the next one instead of to the model.

## 2b. Station health, re-checked on a schedule
A daily job (extends the `NDBC_LIVE_CHECK` audit) probes every station any served beach depends on and writes `station_health` (id, field, lastSeenAt, status). The resolver and the runtime candidate walk read it; a beach that drops to model-only for >24 h shows up in the growth report. The CI guard is extended to **all** served beaches (curated + generated).

## 2c. Two modes, one explicit setting
- **Use my location** — asks While-Using permission; follows the person: nearest served beach, rain/lightning measured from where they stand (phase 1), Beach Mode auto-arm.
- **I'll pick my beaches** — never requests location; one or more saved beaches; everything anchors to the chosen beach (Codex's rule: a manual destination anchors the whole score).
Asked once at first run, changeable in settings, stored with device prefs. Switching to manual clears any stored presence fix.

## 2d. A complete beach list
Grow the gazetteer beyond GNIS: EPA's national beach list (BEACON — monitored swimming beaches, with ids and coordinates) as the main addition, OpenStreetMap `natural=beach` names to fill gaps. **Verify counts and licences before building** (GNIS: public domain; EPA: federal public data; OSM: ODbL — attribution + share-alike on the derived database, so OSM-derived rows stay separable). Dedupe by name + distance. Ship as a searchable static index (name, lat, lon, state, source) — no per-beach config.

## 2e. Resolve on first open, cache, re-verify
No pre-built configs for thousands of beaches. First open of a beach → resolve (2a) → store in D1 `beach_configs` (slug, config JSON, coverage tier, resolvedAt, verifiedAt) → served like any beach; re-verified on the 2b schedule. Rate-limited, so a crawler cannot trigger thousands of resolutions. An admin can promote a beach to curated (flags, cams, water-quality sites). Cost stays proportional to beaches people actually open (one build ≈ 10 Open-Meteo calls + ~10 other fetches, cached ~2 min).
Sitemap lists only beaches with a resolved config that meets the minimum-data rule — no thin doorway pages.

## 2f. Minimum data + honest confidence (Codex's standing warning)
`scoreBeachDay` drops missing factors and renormalizes, so a data-poor beach can look confidently great. Rules:
- Coverage tiers, shown on the page: **Full** (flags, water testing, cams) · **Standard** (weather + observed waves + tides + water temp) · **Limited** (model-only waves or no water temp).
- The score always lists which factors are missing. Limited beaches carry a visible "limited data" label and are excluded from cross-beach "best beach" comparisons and rankings.
- A beach below a minimum (no usable weather, or not coastal-confirmed) is not scored at all.

## Questions for the reviewer
(a) Are the pass criteria and distance ceilings sane per metric; is "same coast" enough of a basin check? (b) Ordered candidate list at runtime vs resolve-time only — which layer should own the walk? (c) `station_health` as D1 table vs a published JSON like the other feeds. (d) On-demand resolution inside a Worker request: subrequest limits, abuse, cold-start latency for the first visitor. (e) Coverage tiers — does labeling solve the renormalization problem or must Limited scores be capped? (f) SEO risk of thousands of programmatic beach pages. (g) Anything that contradicts phase 1 or the Plus spec.

## Phase 2 — Codex review 2026-09-20: build with changes (adopted)
Full text: `docs/reviews/2026-09-20-codex-phase2-history-imagery.md`. These replace the matching parts of the proposal above.
1. **Basin / coast-segment / exposure metadata.** "Same coast" cannot be checked with today's data (no basin field on beaches or stations; the coastal gate is a no-op once a registry beach is chosen). Add a small static coast-segment set and tag beaches + stations with it.
2. **Per-metric candidates, two layers.** Resolve time builds and verifies an ordered candidate list per metric; runtime walks the *vetted* list when live data fails. No global "cap four".
3. **Per-field timestamps; waves stay near the existing 2-hour staleness rule** (6 h was too loose). The buoy adapter needs per-field observation times first.
4. **Station health in D1, with a cached hot-path snapshot** the request path reads (never a D1 query per conditions build).
5. **Resolve asynchronously**: single-flight job per beach, rate limits, retries, and a "setting up this beach" pending state. Never a full live resolution inside the first visitor's request (`/api/resolve` is public and unthrottled today; conditions already fan out ~21 source calls and has hit Cloudflare 1102 before).
6. **An async location repository** in front of curated + generated + D1-resolved beaches; do not bolt D1 onto the synchronous `getLocation()`.
7. **Completeness rules, not just labels**: track available vs observed weight; a Limited beach must not be able to read as a confident "Excellent" (`combine()` renormalizes silently today).
8. **Coverage-aware SEO**: sitemap lists only stable, useful pages with a real `lastModified` (today every entry says "now"); page metadata must stop claiming water quality / seaweed / crowds for beaches that lack them.
9. **Rewrite Plus onboarding + the privacy page around the two explicit modes.**
10. **Map-pin fallback** if "every US beach" is non-negotiable: a person can drop a pin on the coast and get a location-only beach, even when no list has it.
Also: extend the CI coverage guard to the merged served list (it covers only the 3 curated beaches today).
