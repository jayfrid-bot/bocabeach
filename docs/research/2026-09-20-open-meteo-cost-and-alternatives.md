# Open-Meteo: what it costs, and what could replace it (research, 2026-09-20)

**Why this matters:** Open-Meteo's free API is for non-commercial use only (10,000 calls/day; 300,000/month). Their terms give no exception for small apps: any app with ads or subscriptions needs a paid plan. Beach Day Plus goes on sale with App Store 1.1. (Verified on open-meteo.com/en/terms and /en/pricing.)

## Prices
| Plan | Price | Calls / month | Notes |
|---|---|---|---|
| Standard | **~$29 / month** | 1 M | Commercial licence. No Satellite Radiation, no Historical. |
| Professional | **~$99 / month** | 5 M | Adds Satellite Radiation + Historical / Climate / Ensemble. |
| Enterprise | quote | 50 M+ | Not relevant. |
Prices are REPORTED (Open-Meteo's own Substack, 2023-06-12, plus two independent aggregators that match); the live pricing page shows plan names and limits but renders the dollar figure only inside Stripe checkout — confirm at checkout. VERIFIED on the pricing page: Satellite Radiation and Historical need Professional; plans are monthly and can be upgraded, downgraded or cancelled any time; a request with >10 variables or >2 weeks counts as fractional extra calls. No annual discount confirmed.
Self-hosting their open-source server is allowed (AGPL-3.0) but means running multi-TB model ingestion — not realistic for a solo developer.

## What the app uses Open-Meteo for
| File | Endpoint | Used for |
|---|---|---|
| `lib/sources/hourlyForecast.ts` | forecast + **satellite-api/archive** | hourly strip; cloud low/mid/high → sunset-quality card; shortwave radiation → sand temperature; the satellite call is the Professional-gated one (fails soft) |
| `lib/sources/marine.ts` | marine + forecast | wave height / period / direction at the beach (rip curve, wave card when no buoy), SST, UV, cloud |
| `lib/sources/modelEnsemble.ts` | forecast (`gfs_seamless`) | the GFS voice in the 4-source consensus |
| `lib/sources/forecast.ts` | forecast (daily) | 7-day outlook |
| `lib/sources/spotWeather.ts` | forecast (current) | per-cam spot weather |
| `lib/sources/nowcast.ts`, `lib/alerts/rain.ts` | forecast (`minutely_15`) | raining-now banner; rain alerts' cell forecast |
| `lib/sources/airQuality.ts` | air-quality | AQI (AirNow already preferred when keyed) + aerosol optical depth for sunset color |
| `lib/resolve/geocode.ts` | geocoding | address → lat/lon in the resolver |

## Free sources that allow commercial use — verdict per input
| Input | Verdict | Free source | Effort |
|---|---|---|---|
| Rain nowcast (`minutely_15`) | **Replaceable now** | our own MRMS radar feed (`precipRadar.ts`) | S (~1 day glue) |
| Geocoding | **Replaceable now** | US Census Geocoder (public domain, US-only) | S |
| Cloud low / mid / high | Replaceable with work | MET Norway Locationforecast "complete" (CC BY 4.0, commercial use allowed with a descriptive User-Agent); `metno.ts` already wired | S–M |
| GFS voice | Replaceable with work | raw NOAA GFS (GRIB2) — or just drop to 3 voices (NWS + MET Norway + one) | M |
| Observed shortwave radiation (sand temp, observed-sky) | **Uncertain** | NOAA GOES-R Downward Shortwave Radiation on AWS open data — BUT our July check found the CONUS product (`DSRC`) had **0 objects for GOES-19** and the product has a sun-angle quality bound. The full-disk variant was not checked. Needs a half-day look before anything is planned on it. | M–L if it exists |
| Wave model at beach coordinates | No free drop-in | NOAA WAVEWATCH III / NWPS GRIB2 (public domain) — a new decode + interpolation pipeline | L (3–5 days) |
| UV index (incl. clear-sky) | **Gap** | no confirmed real-time free equivalent; EPA's hourly UV API needs a live test; could approximate clear-sky UV from sun elevation | ? |
| Aerosol optical depth | **Gap** | satellite swath products only; heavy | L, low value |

## Options
- **A — Professional (~$99/mo):** nothing changes, zero dev.
- **B — Standard (~$29/mo) + a free observed-radiation feed:** only if the GOES radiation product really exists for GOES-East (see "Uncertain" above). Without it, dropping the satellite feed regresses sand temperature and the observed-sky read — the feed is what fixed the 2026-09-04 miss (94°F modeled vs 140°F measured) and the `solarObserved` rules built since depend on it.
- **C — fully free:** ~6–9 dev-days plus two more GRIB pipelines to maintain, and UV + aerosol remain gaps (a free-tier call for just those would still break their terms). Not now.

Sources: open-meteo.com/en/pricing · /en/terms · /en/licence · github.com/open-meteo/open-meteo · openmeteo.substack.com/p/api-subscriptions-for-commercial · api.met.no/doc/TermsOfService · registry.opendata.aws/noaa-goes · geocoding.geo.census.gov · nominatim.org usage policy
