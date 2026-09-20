# Codex design review — location phase 2 + history archive + satellite imagery (2026-09-20)

Verbatim. Reviewed docs: `docs/LOCATION_FIRST_PLAN.md` (Phase 2) and `docs/HISTORY_AND_IMAGERY_PLAN.md`. Both verdicts: **build with changes**.

## 1. Location-first Phase 2

**Risk as written: high.** The direction is right, but the proposal treats a substantial runtime/config architecture change as if it were an extension of the existing resolver. It is not.

### What is solid

The live-verification premise is correct. The current picker trusts snapshot flags:

- `nearestBuoys()` chooses one nearest temperature-or-wave station and one wave fallback exclusively from `hasWaterTemp` / `hasWaves` ([stationRegistry.ts:78](/Users/yitzfrid/Projects/bocabeach/lib/resolve/stationRegistry.ts:78)).
- Runtime already fetches both stations and merges each field independently ([buoy.ts:225](/Users/yitzfrid/Projects/bocabeach/lib/sources/buoy.ts:225), [buoy.ts:283](/Users/yitzfrid/Projects/bocabeach/lib/sources/buoy.ts:283)).
- It detects old observations, but only after the two configured stations have been selected ([buoy.ts:318](/Users/yitzfrid/Projects/bocabeach/lib/sources/buoy.ts:318)).

The measured 35/36 result is therefore strong evidence for retaining capability-aware selection while replacing static flags as the final authority.

The two explicit user modes also fit Phase 1’s rule that a manually selected beach owns the complete score. But they require changes to the Plus spec: the current spec still describes a first-run “Find my nearest beach” flow and location-driven `NearYouChip` ([PLUS_BUILD_SPEC.md:134](/Users/yitzfrid/Projects/bocabeach/docs/PLUS_BUILD_SPEC.md:134)). “Pick manually and never touch location” must be an actual privacy mode, not merely declining the initial prompt.

### (a) Pass criteria, ceilings, and basin check

**Freshness: six hours for waves is too loose.** Runtime currently declares the whole buoy observation stale after two hours ([buoy.ts:15](/Users/yitzfrid/Projects/bocabeach/lib/sources/buoy.ts:15), [buoy.ts:320](/Users/yitzfrid/Projects/bocabeach/lib/sources/buoy.ts:320)). A six-hour-old wave reading should not suddenly become acceptable because it was selected by the new resolver. Use approximately the existing two-hour threshold for waves, with any longer grace explicitly labeled stale—not observed/live. Water level should be tighter than two hours because the code expects a six-minute gauge cadence ([tides.ts:172](/Users/yitzfrid/Projects/bocabeach/lib/sources/tides.ts:172)).

There is another implementation trap: `parseNdbcRealtime()` reads only the newest row ([buoy.ts:61](/Users/yitzfrid/Projects/bocabeach/lib/sources/buoy.ts:61)). “A real value sometime within six hours” requires scanning recent rows separately for each field and retaining per-field observation times. The current merge has only one `observedAt`, taken from whichever station led the merge, while provenance records only station IDs, not field timestamps ([buoy.ts:240](/Users/yitzfrid/Projects/bocabeach/lib/sources/buoy.ts:240), [buoy.ts:261](/Users/yitzfrid/Projects/bocabeach/lib/sources/buoy.ts:261)). Generalizing it without fixing that would produce misleading freshness.

**The proposed mileage ceilings are acceptable only as emergency maxima, not quality boundaries.** A 75-mile wave station can be on the same named coast and still represent a different exposure, shelf, cape, island side, or wave regime. Prefer a near tier—roughly 25–40 miles for observed waves—and allow 75 only as low-confidence context after basin/exposure validation. Water temperature is less spatially volatile, but 50 miles still needs current/along-coast validation. Water-level observations should be tied to a compatible gauge and datum; the existing code correctly compares an observation to that same gauge’s predictions rather than to the beach’s subordinate station ([tides.ts:113](/Users/yitzfrid/Projects/bocabeach/lib/sources/tides.ts:113)).

**“Same coast” is not enough, and the repository cannot implement it as proposed.**

- Auto-generated locations have neither `coast` nor `coastNormalDeg`; those are intentionally optional and omitted for auto beaches ([types.ts:1081](/Users/yitzfrid/Projects/bocabeach/lib/types.ts:1081), [locations.generated.json:1](/Users/yitzfrid/Projects/bocabeach/config/locations.generated.json:1)).
- `BuoyStation` contains only coordinates and static capability flags—no basin or exposure ([resolve/types.ts:57](/Users/yitzfrid/Projects/bocabeach/lib/resolve/types.ts:57)).
- The beach registry likewise has no basin, normal, or connected-water identifier ([resolve/types.ts:32](/Users/yitzfrid/Projects/bocabeach/lib/resolve/types.ts:32)).

Do not infer basin from the current three-value `coast` string. Add build-time registry enrichment:

- `basin`: Atlantic, Gulf, Pacific, Great Lakes, Alaska Arctic/Bering/Gulf of Alaska, Hawaii, territories.
- A finer `coastSegment` or connected-water region.
- Beach offshore normal/exposure where confidently derivable.
- A land-crossing/connected-water check for candidate paths.

Then require basin/segment compatibility and reject candidates lying substantially landward of the beach’s offshore normal. Florida, Cape Cod, barrier islands, bays, Puget Sound, and Alaska are precisely where “same coast” fails.

The current coastal gate is also weaker than its name suggests. Once a selected registry beach is not explicitly false, `nearestCoastalMi()` returns zero, so the final gate trivially passes ([resolveLocation.ts:388](/Users/yitzfrid/Projects/bocabeach/lib/resolve/resolveLocation.ts:388), [resolveLocation.ts:567](/Users/yitzfrid/Projects/bocabeach/lib/resolve/resolveLocation.ts:567)). Any added OSM/BEACON rows need genuine build-time coastal validation.

### (b) Candidate walk: resolver or runtime?

**Both, with different responsibilities.**

At resolution time:

- Build and persist ordered, per-metric candidates—not one generic four-station list.
- Probe enough candidates to establish that the initial configuration works.
- Record distance, basin/exposure, capability, observed timestamp, verification time, and rejection reason.

At runtime:

- Walk the already-vetted candidates when a selected station is unavailable, stale, or missing that particular field.
- Use current data as the final authority; daily health may reorder or suppress repeatedly dead stations but must not replace the live check.
- Limit fetch fan-out with a health/circuit-breaker cache.

A global “cap four stations” is wrong because waves and water temperature may need different candidate sequences. The `Location` type currently supports exactly two buoy IDs ([types.ts:1105](/Users/yitzfrid/Projects/bocabeach/lib/types.ts:1105)); this needs a real candidate/provenance model, not more numbered fallback properties.

Tide predictions and observed water levels also need separate walks. Current code already separates `noaaTideStationId` from `noaaWaterLevelStationId` for exactly this reason ([types.ts:1094](/Users/yitzfrid/Projects/bocabeach/lib/types.ts:1094), [tides.ts:213](/Users/yitzfrid/Projects/bocabeach/lib/sources/tides.ts:213)).

### (c) `station_health`: D1 or JSON?

Use **D1 as source of truth, with a cached/materialized snapshot for runtime reads**.

D1 fits dynamic, field-level health and on-demand beaches. Key it by `(provider, station_id, field)`, with `last_checked_at`, `last_value_at`, status, latency/error, consecutive failures, and recovery time. A single station-level status is inadequate because a station may have live wind and water temperature but no waves.

Do not perform an uncached D1 lookup for every field on every conditions request. Materialize the current health map to KV/R2/cache after audit runs. Resolution/admin reporting reads D1; the hot path reads the cached snapshot and still verifies the actual response.

Also fix the claimed CI expansion correctly: the current test imports `LOCATIONS`, which is only the three hand-curated rows ([ndbcStations.test.ts:1](/Users/yitzfrid/Projects/bocabeach/lib/sources/ndbcStations.test.ts:1)). Runtime uses `listLocations()`, which merges `LOCATIONS` with generated beaches ([locations.ts:299](/Users/yitzfrid/Projects/bocabeach/config/locations.ts:299)). The guard should use the merged list or test generated configurations independently.

### (d) On-demand resolution in a Worker request

**Do not perform the complete live resolution synchronously in the first visitor’s HTTP request.**

The current conditions build already launches roughly 21 source operations in parallel ([conditions.ts:120](/Users/yitzfrid/Projects/bocabeach/lib/conditions.ts:120)), and the code documents previous Worker 1102 failures before per-beach caching was added ([conditions.ts:279](/Users/yitzfrid/Projects/bocabeach/lib/conditions.ts:279)). Adding geocoding, multiple live station probes, D1 writes, and then the conditions build produces poor first-visitor latency and a large failure surface.

Cloudflare’s current limit is generous on Paid—10,000 subrequests—but only 50 on Free, with six simultaneously waiting outbound connections. Limits alone do not make a long dependency chain a good request path. [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

Use this flow:

1. Picker selects a canonical registry beach ID.
2. D1 insert/claim creates one `pending` resolution job under a unique beach ID.
3. Queue/Workflow resolves and verifies it asynchronously.
4. The client receives a quick “preparing live conditions” state and polls or receives completion.
5. Concurrent visitors attach to the same job; they do not repeat it.
6. Failed jobs have bounded retry/backoff and a visible degraded result.

Rate-limit by IP/device and canonical beach ID, set a global daily creation budget, and require a human challenge after suspicious bursts. The existing `/api/resolve` endpoint is public and has no rate limiting ([app/api/resolve/route.ts:12](/Users/yitzfrid/Projects/bocabeach/app/api/resolve/route.ts:12)).

The proposal also understates the application work. Nearly every consumer assumes synchronous, build-bundled `getLocation()` / `listLocations()`: page routing, conditions, presence, devices, push, sitemap, finder, and share cards. For example, unknown slugs 404 before any D1 lookup ([page.tsx:64](/Users/yitzfrid/Projects/bocabeach/app/%5Bslug%5D/page.tsx:64)), and conditions calls synchronous `getLocation()` ([conditions.ts:45](/Users/yitzfrid/Projects/bocabeach/lib/conditions.ts:45)). Phase 2 needs an async location repository with static curated overlays and D1-resolved records. It is not just a new `beach_configs` table.

The current registry loaders also use synchronous `node:fs` and `process.cwd()` ([stationRegistry.ts:12](/Users/yitzfrid/Projects/bocabeach/lib/resolve/stationRegistry.ts:12), [beachRegistry.ts:10](/Users/yitzfrid/Projects/bocabeach/lib/resolve/beachRegistry.ts:10)). Before putting them on a production Worker hot path, replace that assumption with bundled imports or a Worker-native registry store.

### (e) Coverage tiers and renormalization

**Labels alone are not sufficient.** The scoring concern is real: `combine()` removes null factors and divides by the remaining weight ([score.ts:689](/Users/yitzfrid/Projects/bocabeach/lib/score.ts:689)). The current auto badge does not expose which weighted factors disappeared and still says “core conditions live” ([ConditionsDashboard.tsx:422](/Users/yitzfrid/Projects/bocabeach/components/ConditionsDashboard.tsx:422)).

Add:

- `availableWeight`, `observedWeight`, missing factor keys, and source class per factor.
- A core-data contract: no headline score if weather or marine safety is unusable.
- Until confidence is calibrated, prevent Limited results from entering the “Excellent” band—currently ≥90 ([scoreBands.ts:31](/Users/yitzfrid/Projects/bocabeach/lib/scoreBands.ts:31)).
- Keep the uncapped raw calculation for transparency, but expose the coverage ceiling/reason just like other caps.
- Exclude Limited beaches from rankings and “turned Excellent” alerts.

Do not apply one arbitrary penalty merely because a beach lacks a cam. Missing crowds or seaweed is not equivalent to missing waves or water temperature. The rule must depend on weighted completeness and observed-versus-modeled inputs.

The existing `tier` type only supports `curated | auto`, so Full/Standard/Limited is not presently represented ([types.ts:1073](/Users/yitzfrid/Projects/bocabeach/lib/types.ts:1073)).

### (f) SEO and doorway risk

The proposed “only resolved pages meeting minimum data enter the sitemap” is necessary but not sufficient.

Google explicitly defines doorway abuse as substantially similar regional pages created to capture similar searches, and scaled-content abuse as large quantities of feed-derived pages with little added value. [Google Search spam policies](https://developers.google.com/search/docs/essentials/spam-policies)

The pages can be legitimate if each provides genuinely useful, beach-specific live conditions. Guardrails:

- `noindex` pending, failed, and materially Limited pages.
- Index only after sustained data availability and actual user interest.
- Keep a browsable state/region hierarchy rather than thousands of isolated pages.
- Do not put every resolved page into the sitemap immediately.
- Stop setting every sitemap `lastModified` to “now”; current code does that for every beach on every sitemap generation ([sitemap.ts:9](/Users/yitzfrid/Projects/bocabeach/app/sitemap.ts:9)).
- Make metadata coverage-aware. Current metadata claims water quality, seaweed, crowds, and webcams for every location ([page.tsx:20](/Users/yitzfrid/Projects/bocabeach/app/%5Bslug%5D/page.tsx:20)), although auto beaches usually have none of them.

“Every US beach” is not something GNIS + BEACON + OSM can guarantee. If that requirement is literal, add a map-pin coastal-point flow for beaches missing from the named registry. Otherwise call it “every beach in our supported national index.”

### (g) Phase 1 / Plus contradictions

- Manual mode must replace the Plus spec’s location-first onboarding, not sit beside it.
- In manual privacy mode, do not call location for nearest-beach chips, Beach Mode, rain, or lightning. Alerts must either remain beach-anchored and say so, or be disabled until the user separately opts into a fix.
- Switching to manual must clear D1 `presence.lat/lon/accuracy/fix_at`, not just local preferences.
- Phase 1 remains consistent if every score stays beach-anchored and only explicitly opted-in device-local hazards use the fix.
- The generated locations lack orientation, so Phase 1’s orientation-dependent advisories correctly remain absent; Phase 2 must not fabricate `coastNormalDeg`.

**Verdict: build with changes**

Required changes:

1. Add basin/coast-segment/exposure metadata; do not use “same coast” alone.
2. Build per-metric candidates at resolution and walk vetted candidates at runtime.
3. Use per-field timestamps/freshness; keep waves near the existing two-hour standard.
4. Store field-level health in D1 and publish/cache a hot-path snapshot.
5. Resolve asynchronously with single-flight jobs, rate limits, retries, and a pending UI.
6. Introduce an async location repository; do not bolt D1 onto synchronous `getLocation()`.
7. Add completeness/observed-weight rules and prevent Limited scores from appearing confidently Excellent.
8. Index only useful stable pages; make sitemap and metadata coverage-aware.
9. Rewrite Plus onboarding/privacy behavior around the two explicit modes.
10. Use a map-pin fallback if “every US beach” is truly non-negotiable.

## 2. History archive and satellite imagery

**Part A is worth building now. Part B, as a full Pro feature, is not yet justified.**

### (a) `beach_hourly` schema

Use a **hybrid schema**, not “all typed” and not one opaque blob.

Typed columns should cover fields you will filter, graph, aggregate, or compare:

- `slug`, `hour_utc`
- `snapshot_generated_at`, `archived_at`
- `local_date`, `local_hour`, `utc_offset_minutes`, `timezone`
- `score`, `raw_score`, `rating`
- `available_weight`, `observed_weight`, `coverage_tier`
- air/water/sand temperature, wave height/source, wind/gust, UV, cloud
- rain/lightning booleans
- tide state
- crowd, seaweed coverage/level, clarity
- `engine_version`, `scoring_config_version`, `build_sha`
- `archive_reason` and `row_kind`

Use compact JSON only for evolving structures such as cap codes, factor provenance/status, missing factors, and extension fields.

A build SHA alone is not a useful engine version: unrelated commits produce a new SHA, while changed weights/configuration may need an explicit semantic version. Store both.

Also store both final and raw scores. The code distinguishes them because caps can materially change the headline ([score.ts:922](/Users/yitzfrid/Projects/bocabeach/lib/score.ts:922)).

Use UTC as the primary key/bucket. Store local date/hour/offset as denormalized display and aggregation fields. Do not key by local hour: DST fall-back produces two distinct 1 AM hours, and spring-forward has no 2 AM. The offset disambiguates repeated hours.

Define what one hourly record means. An unconditional upsert currently leaves that ambiguous. I would store the newest successful snapshot generated within that UTC hour and make the update conditional on `snapshot_generated_at`. Call it an “hourly snapshot,” not literally everything every visitor saw.

Cam backfill should first enter a separate `cam_observations` table keyed by slug and capture timestamp. The feed’s `t` values are offset-bearing local timestamps, and code already treats them as such ([clarity.ts:63](/Users/yitzfrid/Projects/bocabeach/lib/sources/clarity.ts:63)). Parse them to UTC, retain the original local timestamp/offset, and reject entries without a full timestamp rather than inventing one from `hour`.

Do not create fake historical scores from cam-only rows. Aggregate cam observations into hourly history fields, but mark them `row_kind='cam-backfill'` or keep them separate until a real score row exists.

### (b) Cron round-robin versus Queue

Do not attach archiving directly to the current push route.

The push endpoint:

- Returns 503 before doing work if no push transport is configured ([push/run/route.ts:192](/Users/yitzfrid/Projects/bocabeach/app/api/push/run/route.ts:192)).
- Deliberately avoids loading conditions unless a subscriber actually needs a digest or Excellent alert ([push/run/route.ts:303](/Users/yitzfrid/Projects/bocabeach/app/api/push/run/route.ts:303), [push/run/route.ts:324](/Users/yitzfrid/Projects/bocabeach/app/api/push/run/route.ts:324)).
- Is called by a stateless five-minute Worker where a missed tick currently only delays push delivery ([plus-cron index.ts:34](/Users/yitzfrid/Projects/bocabeach/workers/plus-cron/src/index.ts:34)). For history, a missed final tick can create a permanent gap.

Use the cron only as the scheduler. It should enqueue idempotent `(slug, hour_utc)` jobs or call a separate authenticated archive scheduler. A Queue consumer builds/loads conditions and inserts the row. Cloudflare Queues are at-least-once, so duplicate delivery is expected; the composite primary key is exactly the correct dedup mechanism. [Cloudflare Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)

Add:

- Retry/backoff and a dead-letter queue.
- A D1 audit table for scheduled/completed/failed hours.
- Concurrency limits to protect upstreams.
- A rule that delayed jobs archive according to `snapshot.generatedAt`, never the eventual consumer time.
- Gap monitoring and a bounded replay path.

For only 39 beaches, a durable D1 round-robin could work. But the plan explicitly targets 500 and calls the data perishable; Queue-based delivery is the better foundation.

### (c) “Archive what was shown” versus raw inputs

Store both, at different layers.

- D1: the canonical score as displayed, raw score, caps, sub-scores/completeness, selected current metrics, provenance, and observation timestamps.
- R2: compressed normalized input snapshots for debugging and future model comparisons.

Do not put the complete `ConditionsResponse` into every D1 row. It contains multi-day hourly arrays, histories, and cam structures, and would duplicate large amounts of data. Archive the current inputs consumed by `deriveMetrics()` plus provenance; keep optional full snapshots in R2.

The displayed result must remain authoritative. Recomputing history under a new engine would rewrite the user’s past experience. Raw inputs are for “what would engine vNext have said?”—a separate comparison—not retroactive replacement.

### (d) Timezone and backfill traps

Bucket by `floor(captureInstantUtc / 1 hour)`, never by the feed’s `hour` integer.

Retain:

- Original capture timestamp and offset.
- Derived UTC instant.
- Beach IANA timezone at ingestion.
- Local date/hour and offset.

Multiple cam reads in one hour need a documented reducer. Use the same aggregation semantics the application uses—worst/current seaweed where appropriate, median clarity, and the existing crowd rule—not “last value for everything.” Existing seaweed logic deliberately chooses the worst cam from the most recent capture ([sargassum.ts:141](/Users/yitzfrid/Projects/bocabeach/lib/sources/sargassum.ts:141)); backfill should not silently use a different definition.

### (e) D1 versus R2 at 500 beaches

D1 is appropriate for hot, indexed history queries. It is not appropriate for an unbounded “forever” promise.

The estimate of roughly 2.7 million rows/year is manageable initially, but 150 bytes per row ignores SQLite row/index overhead, JSON extensions, and future columns. D1 has a hard 10 GB per-database limit on Workers Paid, and each database is single-threaded. [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

Use:

- D1 for 12–24 months of hourly detail.
- Daily/monthly rollups in D1 for older periods.
- R2 partitioned by year/month/slug as the durable full archive.
- Export manifests, row counts, checksums, and completion markers.
- Delete D1 detail only after export verification.

The primary key `(slug, hour_utc)` supports beach-range queries. Avoid unnecessary secondary indexes because D1 counts index updates as additional writes. [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

### Archiving and upstream load

Yes, scheduled archiving forces conditions builds for beaches nobody is viewing.

The conditions cache lasts only 120 seconds ([conditions.ts:289](/Users/yitzfrid/Projects/bocabeach/lib/conditions.ts:289)), so an hourly archive across 500 beaches still initiates a build for essentially every eligible beach. At roughly eight core Open-Meteo requests per build—and more for cam beaches—that is tens of thousands of upstream calls daily.

Do not archive every merely resolved beach forever. Define an active set:

- Curated beaches.
- Beaches saved/followed by a user.
- Beaches viewed recently.
- Beaches with an active Plus entitlement/history request.

Archive opportunistically when a real visitor causes a conditions build, and schedule only the active set to fill gaps. A resolved-once crawler beach should not generate 12–15 builds every day forever.

### (f) Open-Meteo licensing

The proposal’s licensing conclusion is correct, but “about ten calls” is an approximation.

The conditions path currently calls:

- Air Quality ([airQuality.ts:115](/Users/yitzfrid/Projects/bocabeach/lib/sources/airQuality.ts:115))
- Daily forecast ([forecast.ts:82](/Users/yitzfrid/Projects/bocabeach/lib/sources/forecast.ts:82))
- GFS model ([modelEnsemble.ts:42](/Users/yitzfrid/Projects/bocabeach/lib/sources/modelEnsemble.ts:42))
- Marine and forecast/UV as two requests ([marine.ts:74](/Users/yitzfrid/Projects/bocabeach/lib/sources/marine.ts:74))
- Nowcast ([nowcast.ts:67](/Users/yitzfrid/Projects/bocabeach/lib/sources/nowcast.ts:67))
- Hourly forecast and Satellite Radiation as two requests ([hourlyForecast.ts:144](/Users/yitzfrid/Projects/bocabeach/lib/sources/hourlyForecast.ts:144))
- Per-cam spot weather where cams exist ([cams.ts:100](/Users/yitzfrid/Projects/bocabeach/lib/cams.ts:100))
- Additional location-cell forecast requests from alert rain fallback ([rain.ts:274](/Users/yitzfrid/Projects/bocabeach/lib/alerts/rain.ts:274)).

All use the free public hosts today. Open-Meteo says those hosts are non-commercial, limited to 10,000 calls/day, and that commercial access uses `customer-api.open-meteo.com` with an API key. Satellite Radiation specifically requires Professional or higher. [Open-Meteo pricing](https://open-meteo.com/en/pricing)

The cheapest compliant options are:

- **Cheapest while preserving current behavior:** Professional, because the current sand/observed-sky implementation calls Satellite Radiation.
- **Cheapest subscription:** Standard, but remove the Satellite Radiation request and accept the existing modeled-radiation fallback, or replace it with a NOAA-derived pipeline. `fetchHourlyForecast()` already fails soft when that request is unavailable ([hourlyForecast.ts:161](/Users/yitzfrid/Projects/bocabeach/lib/sources/hourlyForecast.ts:161)).
- Replacing every Open-Meteo dependency with NOAA/NWS/MET is likely cheaper in API fees but substantially more expensive in engineering and operational complexity, especially marine and minutely nowcast.

Given the calibration notes showing observed radiation materially improves sand temperature, Professional is the honest choice if that behavior is part of the product. Otherwise Standard plus explicitly removing the satellite request is the lowest-cost compliant launch path. In either case, change the endpoint and supply the API key before selling subscriptions; attribution remains required.

### (g) Imagery pipeline and satellite-as-data

The off-Worker architecture is sound. Earth Search exposes Sentinel-2 L2A and Landsat C2 L2 collections, but its public service carries no uptime guarantee. [Earth Search documentation](https://github.com/Element84/earth-search/blob/main/README.md)

Do not start a Fly/GDAL job synchronously from a Plus page request. Enqueue an entitlement-checked, idempotent job keyed by beach and pipeline version. Track pending/running/complete/failed, cap concurrent jobs, and serve an honest pending UI. Otherwise one user—or an abusive script—can trigger decades of scene processing across thousands of beaches.

Scene-level `eo:cloud_cover` is not enough for a tiny beach crop. Require local AOI cloud/shadow/SCL screening, consistent crop geometry, reflectance/color normalization, and preferably season/tide metadata. Without that, the slider will exaggerate “change” caused by clouds, water level, sun glint, atmospheric correction, or inconsistent rendering.

The licensing read is sound: Landsat is public domain with requested USGS credit, and modified Sentinel output requires the “Contains modified Copernicus Sentinel data [year]” notice. [USGS](https://www.usgs.gov/faqs/are-landsat-data-cloud-still-considered-within-public-domain), [Copernicus licence](https://cds.climate.copernicus.eu/licences/ec-sentinel)

**Do not build the full imagery product yet. Run the satellite-as-data spike first.** It has a chance to improve core coverage; the slider is mostly novelty and its source archive is not perishable.

But correct the promise: satellite seaweed/clarity cannot make a beach “Standard” under Phase 2’s own definition, which requires observed waves, tides, and water temperature. A five-day nominal revisit plus clouds is also “recent evidence,” not a live condition.

Validate only against defensible ground truth. The proposal itself says Boca has 1,073 reads while Deerfield and Fort Lauderdale have 17 and 4 stale reads, so Boca is the only useful initial validation set. Measure usable-scene frequency, cloud-free acquisition latency, false positives from sunglint/turbid water, and agreement with same-day cam observations before feeding any score.

**Verdict: build with changes**

Required changes:

1. Build Part A with a hybrid typed/JSON schema and explicit engine/config versions.
2. Key hours in UTC; preserve local date, offset, timezone, and capture time.
3. Keep raw cam observations separate from historical score rows.
4. Use a Queue and a separate archive path, not `/api/push/run`.
5. Archive displayed output plus normalized raw inputs/provenance; put bulky snapshots in R2.
6. Archive only curated/recently viewed/saved/Plus beaches, not every resolved beach.
7. Keep detailed D1 history for a bounded hot window; roll up and retain full history in R2.
8. Move to Open-Meteo Professional to preserve current behavior, or Standard only after removing/replacing Satellite Radiation.
9. Defer the full imagery timeline; run the Boca satellite-as-data validation spike first.
10. Do not promote satellite-derived reads into the live score or Standard tier until freshness and validation thresholds are proven.
