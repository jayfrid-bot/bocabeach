# Beach history archive + satellite "beach over time" — plan (for review)

**Status:** proposal, 2026-09-20. Two Pro (Beach Day Plus) features with very different urgency.

## Bottom line
- **Our own observations are perishable.** A crowd level, a seaweed read or the score at 2 PM last Saturday can never be recovered later. Start **collecting now**, before any Pro screen exists. It is a small build.
- **Satellite imagery is permanent upstream** (public archives). It can be backfilled any day, so it ranks below the archive — and its sharp record starts in 2015, not 1976.

## Part A — hourly history archive

### What exists (measured 2026-09-20)
- Cam-derived history **is** kept, in the published feed JSON: Boca **1,073 reads since 2026-06-04** (`crowdPct`, `cov`/seaweed level, `clr`/water). Deerfield 17 reads and Fort Lauderdale 4 — both **stale since 2026-09-18** (collection problem to fix separately).
- The hourly **score is stored nowhere**: score, sub-scores, caps and the conditions behind them are computed per request and discarded. D1 (`isitbeachday-plus`) is 106 KB — room is not a constraint.

### Design
- D1 table `beach_hourly`, primary key (`slug`, `hour_utc`), compact typed columns (not a JSON blob): score, rating band, the sub-scores, active caps (short codes), air / water / sand temp, wave ft + source (`observed` | `model`), wind + gust, UV, cloud %, rain flag, lightning flag, tide state, busyness %, seaweed % + level, clarity %, coverage tier, `engine` (build sha).
- **Archive what was shown.** The archiver writes the same `getConditions` result a visitor would have seen that hour. History is never recomputed when the model changes; `engine` makes model changes visible in a trend.
- Writer: the existing 5-minute cron. Each tick archives the next few beaches that have no row for the current hour (round-robin, idempotent upsert), which keeps each invocation inside Worker subrequest limits.
- Hours: every hour for cam / curated beaches; daylight hours only for auto beaches (nobody needs a 3 AM beach score, and it halves upstream cost).
- Cam metrics: import the existing feed history into the same table (Boca back to 2026-06-04); going forward the archiver copies the cam read that belongs to that hour.
- Retention: forever. 39 beaches ≈ 0.25 M rows/yr; 500 beaches daylight-only ≈ 2.7 M rows/yr (~150 bytes/row ≈ 400 MB/yr) — inside D1's 10 GB. Monthly NDJSON export to R2 as the durable cold copy.

### Pro features this enables (later, UI not in this plan)
Score calendar ("how was last Saturday"), typical-by-weekday-and-hour crowds, seaweed season trend, clarity trend, year-over-year, "best month to visit", and per-beach records. Free shows today; Plus shows history.
Honest scope: busyness / seaweed / clarity exist only where there are cams (3 beaches today), so cross-beach **rankings** of those are limited to cam beaches; score, weather, water, waves and tides cover every served beach.

### Cost + a licensing decision that is due anyway
One conditions build ≈ 10 Open-Meteo calls. Archiving 39 beaches ≈ 5,900 calls/day (daylight rule) on top of visitor traffic. Open-Meteo's free API is **non-commercial only, 10,000 calls/day**, and the Satellite Radiation API (used for sand temperature and the observed-sky read) requires their **Professional** plan (verified on open-meteo.com/en/pricing, 2026-09-20). Selling Plus makes today's use commercial. Decide around the 1.1 release: subscribe (Standard 1 M calls/mo; Professional 5 M + satellite/historical), or move those inputs to NOAA / NWS / MET Norway sources that allow commercial use. CC BY 4.0 attribution is required either way.

## Part B — satellite "beach over time"

### Honest dates and resolution
| Archive | Years | Pixel | What a beach looks like |
|---|---|---|---|
| Landsat 1–3 (MSS) | 1972–1983 | 60–80 m | One pixel wide. Not useful. |
| Landsat 4/5/7/8/9 | 1984–now | 30 m (15 m sharpened from 1999) | Coastline shape: inlets, erosion, new jetties. |
| Sentinel-2 | 2015–now, every ~5 days | 10 m | Recognizably your beach: sandbars, water color, seaweed rafts. |
So the product is "**sharp views since 2015 + coastline change since 1984**", not 1976.

### Design
- Reuse the proof of concept (`scratchpad/skyfi-poc/beach-over-time.html`): Earth Search STAC → cloud-filtered scenes → crop the beach from the cloud-optimized GeoTIFF with GDAL. GDAL cannot run in a Worker, so crops are produced off-Worker (the existing Fly machine or a GitHub Action) and stored as WebP in R2; a per-beach index JSON drives a date scrubber.
- Build lazily: generate a beach's timeline the first time a Plus user opens it, never for every beach up front. Storage ≈ 70 clear scenes/yr × 10 yr × ~80 KB ≈ 56 MB per beach → 39 beaches ≈ 2.2 GB, 500 beaches ≈ 28 GB (R2 ≈ $0.40/mo, no egress fees).
- A "then vs now" slider from Landsat decade snapshots (1985 / 1995 / 2005) for the long view.
- Attribution: "Contains modified Copernicus Sentinel data [year]"; Landsat courtesy of the U.S. Geological Survey. Both allow commercial use. (SkyFi was rejected earlier on licence grounds.)

### The higher-value use: satellite as data, not just pictures
For beaches with no cams, Sentinel-2 can supply two observed factors we otherwise lack: a floating-seaweed index offshore (large sargassum rafts are visible at 10 m) and turbidity plumes after rain (a water-clarity proxy). That would lift "Limited" beaches toward "Standard" in the phase-2 coverage tiers. Limits: ~5-day revisit and cloud cover mean "recent", never "now". Research item — validate against the Boca cam history before promising anything.

## Order of work
1. App Store 1.1 (billing) — submit. 2. **History collector** (Part A, storage only) — small, perishable, can start immediately. 3. App Store 1.2 (Live Activities). 4. Location phase 2. 5. Imagery (Part B).

## Questions for the reviewer
(a) `beach_hourly` schema: typed columns vs JSON, what is missing, what will be regretted in a year. (b) Archiving via the 5-min cron round-robin vs a Queue — failure modes, double writes, gaps. (c) "Archive what was shown" vs storing raw inputs so scores can be recomputed — which, or both? (d) Backfilling cam history into the table: timezone / hour-bucket traps. (e) D1 vs R2-first for scale to 500 beaches. (f) The Open-Meteo licensing read — correct, and what is the cheapest compliant path? (g) Imagery pipeline: lazy generation on the Fly machine, abuse, cloud filtering quality, and whether the satellite-as-data idea is worth a spike.
