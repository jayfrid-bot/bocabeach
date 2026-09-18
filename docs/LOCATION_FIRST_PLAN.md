# Location-first conditions — build plan (for review)

**Status:** proposal, not started. Written 2026-09-18 for design review before any code.
**Owner decision it answers:** "Move the app's logic to the person's real location, with a manually chosen beach as the fallback."

## Bottom line

Do it as a **split, not a swap**. Half of what the app measures is physics that belongs to a point and should follow the person. The other half is facts about a place that only exist at a named, lifeguarded beach and cannot be derived from a coordinate. The plan makes the person's position drive the physics, keeps the nearest served beach as the source of place facts, and lets a manual pick override which beach. It stays cheap by caching physics per map cell instead of per person.

## Today (what we are changing)

- Everything is computed per curated beach (`config/locations.ts`, three entries today, target 300–500). `getConditions(slug)` builds one snapshot per beach, wrapped in `unstable_cache` (~2 min) in KV. That cache is the only reason the Worker stays under its resource limit (it tipped over once: Cloudflare 1102).
- The score (`lib/score.ts`) reads that beach snapshot. Every reading is anchored to the beach's center point.
- The person's device fix is used only for: nearest-beach discovery, Beach Mode presence, and — in the at-beach alert engine — lightning distance (`lightningSubjects` reads the person's fix). Rain radar in alerts is beach-based (`radar:<slug>`); the audit noted the phone-pixel version was the original intent.
- A "location cell" already exists for the forecast fallback in alerts.

## The split

| Bucket | Readings | Source type | Anchor after this plan |
|---|---|---|---|
| **Physics** (follows the person) | weather, forecast, hourly, GFS, MET.no, nowcast (minutely rain), rain radar (MRMS pixel), lightning (GLM distance), GOES cloud, sun / golden hour, air quality, NWS alerts, marine model, shore orientation | Grid / model / point query, valid at any lat-lon | **Person's fix**, quantized to a cell |
| **Place facts** (belong to a beach) | lifeguard flags, city advisories, water-quality samples (Healthy Beaches sites), cams and everything derived from them (crowds, seaweed, clarity), tide gauge, wave buoy (observed), water trend, traffic, regional marine-life context | Hand-wired per beach; exists only at a named site | **Nearest served beach**, manual pick overrides |

Rule: a reading is "point" only if the same query works at any coordinate with no per-beach wiring. Anything that needs a station id, a page scrape, a camera, or a permission is "place".

Two cautions that come straight from this week's bugs:

- Auto-picking "nearest station" from a point is a trap. Boca was wired to two stations with no wave sensor and silently served a model that read 3x high. Any auto-pick needs a registry with capability metadata (the new `lib/sources/ndbcStations.ts` map is the seed) and the coverage guard generalizes to "whatever gets picked must measure the thing".
- Hard thresholds flicker. Point-based radar at the person's own cell is more local, so it sits on threshold edges more often. Sticky hazard caps are a prerequisite, not a follow-up.

## Architecture changes

### 1. Two anchors in the snapshot
Split `ConditionsSnapshot` into a point part and a place part. Every reading carries its anchor (`point` / `place:<slug>`). The score reads both. The UI can then say plainly: "rain and lightning measured from where you stand; flags and water quality from Boca Raton" — which the location audit asked for.

### 2. Cell cache for physics
Round the fix to a map cell (proposal: 0.02° ≈ 2 km; tune by hit rate). Cache physics per `cell:<lat>,<lon>` with the same ~2 min TTL. People in the same cell share it; a beach's center is just another cell. Place facts stay cached per beach as today. Per-person, per-exact-GPS computation is explicitly out: it would remove the cache that keeps the Worker alive.

### 3. Two scores from one engine
- **Canonical beach score**: beach center cell + that beach's place facts. Unchanged behavior. Used by the web pages, the share card, the bare-apex flagship page, and the SEO beach/state pages — anything with no user location.
- **Personal score**: person's cell + nearest served beach's place facts (or the manually chosen beach's). Native app only, foreground, when a fix is fresh and accurate enough (reuse `establishesArrival`'s accuracy/age gates). Same scoring function, different inputs.

Web users without location keep seeing the canonical score. Nothing about SEO or sharing changes.

### 4. Station registry with capabilities
Replace hand-wired buoy / tide / sampling-site ids with registries that record what each station measures (waves yes/no, observed vs prediction-only tide gauge, etc.). Auto-pick the nearest *capable* station; the existing coverage guard becomes the generic rule. Needed for 500 beaches regardless of this plan.

### 5. "Lite" beaches
A beach entry may have only a point (name, lat-lon, timezone). It gets physics, a score, and alerts immediately; place facts (flags, cams, water quality) are optional and can be added later. This is how the catalog grows to 500 without 500 hand-built entries. A lite beach must be labeled as such in the UI ("no lifeguard or water-quality data for this beach yet") so a missing flag is never read as "no flag".

### 6. Alerts
Move rain radar and nowcast in the at-beach engine to the person's cell (lightning already is). Dedup keys stay beach-scoped (the LOC-08 fix) because the *monitored beach* is still the session identity.

## Phasing

0. **Sticky hazard caps** (rain ~20 min, lightning 30 min after last observation). Prerequisite. Small.
1. **Physics from the person's cell in the app and alerts** — radar, nowcast, lightning. Reuses the existing cell idea. Biggest accuracy win, smallest surface.
2. **Snapshot tagging + cell cache + attribution UI.** The structural change; canonical and personal scores diverge here.
3. **Station registry + lite beaches.** The scaling unlock.

## Risks and open questions

- **Cell size.** Smaller = more accurate, fewer cache hits, more upstream calls (Open-Meteo, AirNow rate limits). Need a cost model: expected distinct active cells per 2 min at 10× today's users.
- **Two scores can disagree.** A person standing at Boca may see 78 while the Boca page says 85 (rain over their end of the beach). Honest, but confusing if not explained; the attribution line and a one-time explainer are the mitigation. Alerts and the share card must be unambiguous about which score they mean.
- **Worker limits.** More distinct snapshots per minute. Physics is the cheap half (few fetches); place facts (cams, scrapes) stay per beach. Needs measurement before phase 2 ships.
- **Privacy.** Sending the fix on every app refresh, not just on arming. Native While-Using only, never web, never background; the privacy page must say so. Cell quantization also bounds what the server ever sees.
- **Far from any served beach.** Point-only personal score with no place facts. Present as "conditions where you are" with no beach name, or hide the personal score beyond N miles? Owner call.
- **Consistency of hazards between engines.** The score's caps and the alert engine's hazards must read the same cell, or a user can get a lightning push while the score looks fine.

## Questions for the reviewer

(a) Is the point / place cut right? Anything misclassified — in particular marine model, rip risk, NWS alerts (zone-based)?
(b) Cell caching: size, key design, TTL, and the Worker/upstream cost at 10× users. Is there a simpler way to keep physics cheap?
(c) The two-score UX: acceptable, or should the app show one score and use the person's cell only for hazards/alerts?
(d) Phasing order — would you ship anything before sticky caps?
(e) Traps we are not seeing, especially around auto-picked stations and lite beaches eroding trust.
(f) Anything here that contradicts `docs/PLUS_BUILD_SPEC.md` or the location audit (`docs/audits/location-features/BUG_REPORT.md`)?
