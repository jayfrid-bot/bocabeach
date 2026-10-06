# 01 — English text produced outside React components (lib/ and app/api/)

Repo: `/Users/yitzfrid/Projects/bocabeach`. Research only. Nothing in the repo was changed.
Scope skipped by request: `*.test.*`, `lib/alerts/`, `lib/push/`, `lib/liveActivity/`. `lib/changelog.ts` and `lib/nerdInfo.ts` are only sized (section 1H).

## 0. How to read this report

Method. I read the code paths by hand. I used a TypeScript AST scan (script in `scratchpad/i18n/extract.js`) to list string literals with line numbers, then checked each hit by reading the file. I traced callers with `rg`. Counts are "distinct strings or templates", not words. A template such as `` `Rip current risk: ${level}` `` counts as one.

"Runs where" legend (as you defined it):
- (a) server only, inside `getConditions` / the API payload
- (b) client only, called from a component
- (c) both server and client
- (d) push/cron only (none in scope; I flag "+d" where `lib/alerts` or `lib/push` also imports the function)

Three facts shape everything below.
1. `getConditions` output is built once on the server, cached 120 s in KV (`lib/conditions.ts:445-460`), then edge-cached 300 s (`app/api/conditions/[slug]/route.ts:58-63`). It is shared by every visitor. It has no locale key.
2. The same scoring engine (`lib/score.ts`) also runs in the browser. The dashboard re-derives metrics and re-labels the rip cap every minute (`components/ConditionsDashboard.tsx:306,389`). Plus users get a full client-side re-score (`lib/plus/personalScore.ts`). So cap strings are written in two places and mixed in one array.
3. The first client render must match the server HTML. The code already fixed React #418 mismatches for this more than once (`ConditionsDashboard.tsx:271-304`, `lib/conditions.ts:512-521`, `components/RelativeTime.tsx:1-50`). Any locale choice must be known at SSR time.

---

## 1. Text producers in lib/

### 1A. Scoring, caps, safety, hazards

| File | Exported function(s) that return or embed user text | ~Strings | Static or interpolated | Runs where (traced) |
|---|---|---|---|---|
| `lib/score.ts` | `scoreBeachDay`, `applyBeachCaps`, `applyLiveRipCap`, `computeScore`, `computeHourlyScores`, `computeMultiDayWindows`, `FACTOR_WORDS` | ~55: 11 sub-score labels (`:1086-1157`), 11 display templates (`:1089-1160`), 19 cap templates = ~22 variants (`:1204-1206,1297-1437`), 11 `FACTOR_WORDS` (`:879-891`), `"Unavailable"` (`:1183`), `"Today"` (`:1967`) | Labels static. Display and caps interpolate °F, mph, ft, %, a factor count with a hand-made plural (`:1205`), a capitalised enum (`sargassumDisplay :1029`) and a seaState label (`:1124`). `dow` uses `Intl en-US` (`:1913`). | (c). Server: `lib/conditions.ts:521-528`. Client: `ConditionsDashboard.tsx:306,389`; Plus `lib/plus/personalScore.ts:62-65` via `usePersonalScore` (`lib/plus/client.ts:1278`). Also run by push through `getConditions`. |
| `lib/scoreBands.ts` | `SCORE_BANDS`, `scoreBand` | 15: 5 verdicts, 5 ratings, 5 push titles (`:33-37`) | Static | (c). `rating` is written by server and client (`score.ts:861,1478`). `verdict` is made on the client (`ConditionsDashboard.tsx:654`) and on the server (`lib/shareCard.ts:158`). `.push` is push only (`lib/push/notify.ts:130`). |
| `lib/explain.ts` | `explainScore` | ~55: ~34 helping/hurting reasons, 13 lead phrases, 3 cap sentences, 3 summary templates, 1 default summary (`:253-310`) | Heavy interpolation: °F, %, mph, ft, enum words, the NWS `shortForecast` text pasted into a sentence (`:103`), and the profile label (`:308`) | (b) only. `components/ScoreExplainer.tsx:30` <- `ConditionsDashboard.tsx:728` |
| `lib/safetyLine.ts` | `swimSafety`, `surfConditions` | 17 distinct (24 call sites; most repeat the score cap text) | Static except lightning distance (`:27`) and wave ft (`:46,:118`) | (b) only. `components/plus/SafetyLine.tsx:42,48`. Plus-gated (`plusOn`). |
| `lib/safetyTone.ts`, `lib/safetyBannerRank.ts` | `safetyTone`, `rankSafetyItems`, `isWarningTierAlert` | 0 user text. They only regex NWS text. | n/a | (b). `SafetyBanner.tsx:103,176,232` |
| `lib/hazards/assess.ts` | `assessLightning`, `assessRain` (`reason` field) | 4 (`:96-100,152,157`); 2 interpolated (miles, minutes) | Mixed | (c)+(d). Server `score.ts:466,487`. `/api/hazards` returns `reason` to the client. Client `deriveMetrics`. |
| `lib/hazards/pointVsBeach.ts` | `whereYouStandLine`, `beachModeHazardLine` | 4 (`:54-65`) | Built by regex-parsing the English `reason` | (b). `components/plus/BeachModeCard.tsx:382` |
| `lib/ripRisk/copy.ts` | `ripCopy` | 14 (`:23,32,60-111`) | Interpolates level words, time and weekday | (b). `SafetyBanner.tsx:114`, `RipRiskCard.tsx:542` |
| `lib/ripRiskCurve.ts` | `ripRiskCurve` -> `peakNote` | ~8 fragments: 5 reasons (`:420-435`), range label (`:401-402`), degraded note (`:440-441`), lead word (`:514`) | A sentence glued from fragments. Uses en-US 12-hour time (`:387-402`). | (a) only. `lib/conditions.ts:279-290`. Rendered in the flip-back only. |
| `lib/waterTrend.ts` | `waterTrend` -> `note` | 4 (`:152,155,158,161`); 3 interpolate °F | Mixed | (a) only. `lib/conditions.ts:272`. |
| `lib/marineStinger.ts` | `marineStinger` -> `manOWar.note`, `seaLice.note` | ~16 (`:299-319,432-438`) | Prose built from hedge fragments and season words | (a) only. `conditions.ts:295`. **Never rendered** (see 2B). |
| `lib/sharkContext.ts` | `sharkContext` -> `note`, `rarityNote`, `factors` | ~26 (`:278-339`) incl. 3 factor ids (`:257-269`) | Prose with joined clauses (`:312-314`) | (a) only. `conditions.ts:311`. **Prose never rendered**; only `factors` is read by `seasonalHazards.ts:213`. |
| `lib/seasonalHazards.ts` | `seasonalHazards` (`:243`) + row builders | 25 (`:78-223`) | Static | (b). `components/SeasonalHazards.tsx` |
| `lib/stormActivity.ts` | `computeStormActivity` (`band`) | 4 words (`:201-204`) | Static | (b). `ConditionsDashboard.tsx:440`; `nerdInfo.ts` |
| `lib/rainNowcast.ts` | `rainNowcast` | 5 (`:87,104,126` + 2 tails) | Interpolates mi, cardinal, minutes | (b). `ConditionsDashboard.tsx:453` |
| `lib/sources/nowcast.ts` | `parseNowcast` -> `text` | 4 (`:54-61`) | Interpolates minutes, hours | (a) only |
| `lib/vsAveragePhrase.ts` | `busynessVsAvgPhrase`, `seaweedVsAvgPhrase` | 8 | Interpolates %, points, weekday name | (b). `BusynessCard.tsx`, `ConditionsDashboard.tsx:1048` |
| `lib/sandTemp.ts` | `sandVerdict` | 8 (4 labels + 4 advice, `:432-435`) | Static | (b). `SandTempPanel.tsx`, `explain.ts:221` |
| `lib/uv.ts` | `uvBand` | 5 (`:6-15`) | Static | (c). `UvCard.tsx:39`; `shareCard.ts:123` (server) |
| `lib/feelsLikeBeach.ts` | `feelsLikeBandInfo`, `buildDrivers` | ~14 (`:306-309,342-351`) | Interpolates "±N°" | (b). `FeelsLikeCard.tsx` |

### 1B. Sun, sky, tides, weather sources

| File | Exported function(s) | ~Strings | Static or interpolated | Runs where |
|---|---|---|---|---|
| `lib/sunQuality.ts` | `SUN_QUALITY_BANDS`, `factorModelQuality`, `factorNote`, fallback notes | ~33: 5 band labels (`:121-125`), 6 breakdown templates (`:321-331`), ~16 note sentences (`:348-412`), 5 clauses (`:350-352,386-396`) | Interpolates %, AOD, PM2.5 | (b)+(d). Client `SunQualityCard.tsx` via `lib/sunAlert.ts`; push via `lib/alerts/sunColor.ts`. |
| `lib/goldenHourTiming.ts` | `goldenHourTiming`, `formatDuration` | 13 (`:92-103,166-226`) | Interpolates durations and a clock string | (b). `SunQualityCard.tsx` |
| `lib/sunArc.ts` | `daylightStatusLabel`, `fmtDurationShort` | 2 templates (`:172,175`) | Interpolates `Xh Ym` | (b). `SunArc.tsx` |
| `lib/skyVisibilityQuality.ts` | `skyVisibilityQuality` | 9: 5 labels (`:299-303`), 4 `drivers` (`:187-204`) | `drivers[0]` interpolates moon % | (a). `lib/skyEvents.ts:244` inside `buildComingUp` (`conditions.ts:358`) |
| `lib/sources/launchLibrary.ts` | `describeBearing`, `CARDINAL_WORDS` | 2 templates (`:377-378`) + 16 compass words (`:327-344`) + 4 primary words (`:346-351`) | Interpolates degrees | (a). Writes `whereToLook.line`. |
| `lib/sources/moonEvents.ts` | `buildMoonSkyEvent` | 1: `"over the water"` (`:370`) | Static | (a) |
| `config/meteorShowers.ts` (data, shipped in payload) | `showerName` x7 (`:103-229`) | 7 | Static | (a) |
| `lib/sources/spotWeather.ts` | `wmoText` | 13 (`:9-21`) | Static | (a). Feeds `hourly[].shortForecast` (`hourlyForecast.ts:85`), `forecast[].sky` (`forecast.ts:71`), cam weather (`spotWeather.ts:64`). |
| `lib/sources/sun.ts` | `moonPhase` | 8 phase names (`:188-195`) + 1 note (`:285`) | Static | (a). `sun.data.moonPhase.phase` |
| `lib/sources/forecast.ts` | `dow()` | weekday via `toLocaleDateString("en-US")` (`:29`) | Dynamic | (a). `forecast[].dow` |
| `lib/sources/weather.ts` | (passes NWS text), `windDirCardinal` (`:139-141`) | 0 own; 1 cardinal | n/a | (a) |
| `lib/sources/cityOfficial.ts` | `parseCityConditions` vocabulary | 6 words (`:210-218`): jellyfish, seaweed, rip currents, shoreline drop-offs, rocks (Red Reef), hot sand | Static | (a). Stored as display words in `marineLife[]` / `hazards[]` (no ids). |
| `lib/sources/{airQuality,buoy,tides,marine,metno,modelEnsemble,hourlyForecast,traffic,lightning,precipRadar,goesCloud,ripNwps,kingTide,waterQuality,sargassum,busyness,clarity,nws}.ts` | `Wrapped.source`, `.attribution`, `.note` | ~35 provider names, ~22 attribution consts, ~45 distinct notes (full list in section 2B) | Mostly static. Some interpolate a station id, minutes or `String(e)`. | (a). Only `source` and 3 attributions are rendered. |
| `lib/conditions.ts` | `skySkippedLaunch/Tide` | 2 notes (`:151,162`) | Static | (a), internal |

### 1C. Cam-derived text (both environments)

| File | Exported function(s) | ~Strings | Static or interpolated | Runs where |
|---|---|---|---|---|
| `lib/sources/clarity.ts` | `clarityDisplayWord` (`:161-175`), `clarityTileCopy` (`:432-496`), gate notes (`:37-42`), tile notes (`:514,539,565`) | ~28 | Interpolates %, time, day headline | (c). Server writes `word`, `note` into payload. Client `ConditionsDashboard.tsx:916` runs `clarityTileCopy`. Server `shareCard.ts:110` runs `clarityDisplayWord`. |
| `lib/sources/busyness.ts` | `camDayLabel` (`:295`), `camDayHeadline` (`:312-326`), `noRecentCamReadsCopy` (`:333`), `SHORT_WEEKDAYS` (`:263`), gate notes (`:27-30`), notes (`:588,613`) | ~18 | Interpolates weekday | (c). Server writes `dayLabel`, `lastReadWeekday`. Client `BusynessCard.tsx:4,95,111`. |
| `lib/vsAverage.ts` | `weekdayName` (`:84-106`) | 7 full weekdays | Static | (a). Writes `busyness.vsAvg.weekday` (`busyness.ts:484`, fallback `"day"`). |
| `lib/format.ts` -> `nextCamReadPhrase` | 2 templates (`:80,83`) | Interpolates minutes and time | (b). `ConditionsDashboard.tsx:1050`, `BusynessCard.tsx:91,139`, `ClarityScene.tsx:172` |
| `lib/sources/sargassum.ts` | notes | 4 (`:235,260,280` + `worst.note` passthrough `:209`) | Static | (a) |

### 1D. Formatting, shared helpers

| File | Exported function(s) | ~Strings | Runs where |
|---|---|---|---|
| `lib/format.ts` | `fmtTime`, `fmtTimeCompact`, `fmtDate`, `fmtRelative`, `seaState` (`:92-104`: 7 labels + 7 notes), `AQI_BANDS` (`:167-174`: 6 labels), `beachDayVerdict` | ~26 text + 3 `Intl` formatters | (c)+(d). Details in section 4. |
| `lib/util.ts` | `degToCardinal` (`:12-20`) | 16 abbreviations | (c). 13 call sites. |
| `lib/shareCard.ts` | `shareCardModel` | 13: 8 tile labels (`:101-135`), `"Unavailable"` (`:156`), wordmark (`:151`) | (a) only. `app/api/share/[slug]/route.tsx:518` |
| `lib/history/summary.ts` | `weekdayOf`, `weekdayLongOf`, `shortMonthDay`, `summarizeHistory` | 38: 7 short + 7 long weekdays (`:24-26`), 12 months with `"Sept"` (`:31`) | (c). Server `app/api/history/[slug]/route.ts:107`; client `HistorySection.tsx`. |
| `lib/stateBeachPrograms.ts` | `stateProgram`, `US_STATE_NAMES` | 26 names + 1 template (`:90`) | (b). `LocalCoverage.tsx`, `BeachFinder.tsx` |

### 1E. Plus / profile (all client)

| File | Exported function(s) | ~Strings | Runs where |
|---|---|---|---|
| `lib/plus/labels.ts` | `FACTOR_LABELS`, `ALERT_LABELS`, `ALERT_GROUPS` | 32 (a third copy of factor names) | (b). `PlusSettingsSheet.tsx` |
| `lib/plus/paywallCopy.ts` | pricing lines | 6 (`:59-78`); interpolates price | (b). `Paywall.tsx` |
| `lib/plus/preview.ts` | `previewReminder`, `revealLine`, `formatPreviewDate` | 18 incl. 12 months (`:9`) + hand plural (`:59`) | (b) |
| `lib/plus/entitlement.ts` | days/hours left | 4 (`:122,125`) hand plurals | (b) |
| `lib/plus/api.ts` | server error code -> message map (`:235-264`) | 14 | (b). Good pattern: the server sends codes, the client owns text. |
| `lib/profile/presets.ts`, `resolve.ts` | `PRESETS` label/chip, `profileLabel` | 16 + 1 joined phrase (`resolve.ts:151`) | (b). Also imported by `lib/alerts/evaluate.ts`, `morning.ts` (push). |

### 1F. Not user-facing

- `lib/resolve/*` (resolver warnings `WARN_MESSAGES` 9 at `resolveLocation.ts:110-118`, report text ~40 in `emit.ts`): admin console `/admin/yf` via `/api/resolve` only. `components/BeachFinder.tsx` does not read `warnings`.
- `lib/db/*`, `lib/admin/*`: machine codes only.
- `lib/sources/ndbcStations.ts:176-194`: dev-time diagnostics (~8).
- `lib/location/device.ts`: no text, but one regex on a native error message (see 3D).

### 1G. Machine error codes returned by `app/api/*`

`bad-query`, `Unknown location`, `app-only`, `too-many-attempts`, `stale-fix`, `inaccurate-fix`, `future-fix`, `too-far`, `token-required`, `Missing ?q=`, `Unknown cam`, `Bad format — use story or square`. Users never see these raw. `lib/plus/api.ts:235-264` maps the Plus ones to text on the client.

### 1H. Long prose (sized only)

| File | Size | Notes |
|---|---|---|
| `lib/nerdInfo.ts` | 843 lines, 53.6 KB, 21 cards (`NerdKey`, `:25-46`) | Client only (`buildNerdInfo`, `ConditionsDashboard.tsx:423`). Embeds live `snap.*.source` names in sentences (`:204,250,323`). |
| `lib/changelog.ts` | 800 lines, 37.7 KB, 122 entries (title + details) | Client only (`ChangelogSection.tsx`). |

---

## 2. Text fields in the conditions payload

Type walk: `ConditionsResponse` (`lib/types.ts:1127`) = `snapshot` + `score` + `hourlyScores` + `hourlyForecast` + `multiDayWindows` + `cams`. `getConditionsForLocation` builds it (`lib/conditions.ts:505-541`).

### 2A. OUR wording, rendered to users

| Field path | Written by | Rendered by | Notes |
|---|---|---|---|
| `score.caps[]` | `score.ts:1297-1437` (19 templates); `:1204-1206`; client re-run `:1465-1488` | `ScoreCapBanner.tsx:58`; `ScoreWheel.tsx:441`; `ScoreExplainer` via `explain.ts`; `shareCard.ts:161` (`capNote`); `HistorySection.tsx:223` (archived copy) | No codes. English text is the only identity. |
| `score.subScores[].label` | `score.ts:1086-1157` | `ScoreWheel.tsx:338,404`; `DayOutlookStrip.tsx` | 11 static. `key` is a stable id; `label` is not. |
| `score.subScores[].display` | `score.ts:1089-1160` | `ScoreWheel.tsx:340,410`; share tiles (parsed, see 3C) | Numbers + units + English words inside (`"~101°F est."`, `"4.8 ft · rough surf"`) |
| `score.rating`, `hourlyScores[].rating`, `multiDayWindows[].peakBreakdown.rating` | `scoreBands.ts:33-37`; `score.ts:1183` | `ScoreWheel.tsx:270`; `DayOutlookStrip.tsx:116`; `shareCard.ts:156` | `Excellent/Good/Decent/Marginal/Poor/Unavailable`. `hourlyScores[].rating` is never rendered. |
| `multiDayWindows[].dow` | `score.ts:1913,1967` | `DayOutlookStrip.tsx:85,109,114,216` | `"Today"` or en-US `Mon..Sun`. Also used as a logic key (3A). |
| `multiDayWindows[].peakBreakdown.{caps,subScores}` | `score.ts:1971-1978` | `DayOutlookStrip.tsx:126-131,140-160` | Same strings as above |
| `forecast.data[].dow`, `.sky` | `forecast.ts:29,71` | `DayOutlookStrip.tsx:40-61` | `sky` = WMO label |
| `hourly.data[].shortForecast` | `hourlyForecast.ts:85` | **Not rendered.** Read by scoring regexes (3B). | 192 buckets repeat 13 labels |
| `nowcast.data.text` | `nowcast.ts:54-61` | `ConditionsDashboard.tsx:755` | 4 templates |
| `sun.data.moonPhase.phase` | `sun.ts:188-195` | `SunArc.tsx:121,264,276`; `SunPanel.tsx:52`; `MoonPanel.tsx:35` | 8 names |
| `waterTrend.note` | `waterTrend.ts:152-161` | `WaterTrendCard.tsx:34` (tooltip only) | The pill text is rebuilt in the component from `status` and `deltaF48h` (`:23-29`). Server text duplicates it. |
| `ripRisk.peakNote` | `ripRiskCurve.ts:441,514` | `RipRiskCard.tsx:420,430` (flip-back, via `sentence()`) | Lower-case-first fragment |
| `cityOfficial.data.marineLife[]`, `hazards[]` | `cityOfficial.ts:210-218` | `LifeguardReport.tsx:34-44` | 6 vocabulary words stored as display words |
| `busyness.data.yesterday.dayLabel`, `lastReadWeekday`, `vsAvg.weekday` | `busyness.ts:295-300,263,484`; `vsAverage.ts:84-106` | `BusynessCard.tsx:95-111`; `busynessVsAvgPhrase` | Mix of ids (`"today"`) and display words |
| `busyness.data.note`, `clarity.data.note` (gate notes) | `busyness.ts:27-30`; `clarity.ts:37-42` | `BusynessCard.tsx:102,123`; clarity tile via `compactGateNote` (`clarity.ts:424-430`) | 5 strings; also compared by equality (3A) |
| `clarity.data.yesterday.word` | `clarity.ts:161-175` | `clarity.ts:462` -> tile | 6 words |
| `skyEvents.rows[].events[].whereToLook.line`, `overWater.line` | `launchLibrary.ts:377-378`; `moonEvents.ts:370` | `SkyEventsCard.tsx` (launch and moon rows) | Server-built, includes compass words |
| `skyEvents...meteor.showerName` | `config/meteorShowers.ts:103-229` | `SkyEventsCard.tsx` title | 7 |
| `skyEvents...rating.label` | `sunQuality.ts:121-125` via `skyVisibilityQuality.ts:299-311` | `SkyEventsCard.tsx:124` | 5 words; also a lookup key (3C) |
| `*.source` (every `Wrapped`) | each fetcher | `SourceBadge.tsx:20` | Mostly proper nouns. Descriptive ones: `"Computed (NOAA solar position algorithm)"`, `"Beach cams + Gemini vision"`, `"Meteor shower calendar (computed)"`, `"Computed (astronomy-engine)"`. |
| `water.attribution`, `city.attribution`, `cams[].attribution` | `waterQuality.ts:10`; config `cityConditionsAttribution`; config cam `attribution` | `SafetyBanner.tsx:328`; `LifeguardReport.tsx:43`; `CamGrid.tsx:113` | Config-sourced credit lines, 3 patterns across 40 beaches |
| `location.name`, `.region`; `cams[].name`, `.provider` | `config/locations.ts` (4 curated) + `locations.generated.json` (36) | `ConditionsDashboard.tsx:564-577`; `CamGrid.tsx` | Proper nouns. `region` is also parsed (`stateBeachPrograms.ts:102`). |

### 2B. OUR wording, shipped but never rendered (payload ballast)

Safe to drop from the payload before translating. About 90 strings.

- `marineStinger.manOWar.note`, `seaLice.note` (~16). Components read only `.level` (`seasonalHazards.ts:92,122`).
- `sharkContext.note`, `rarityNote` (~24). Components read only `factors` (`seasonalHazards.ts:213`).
- `skyEvents...rating.drivers` (4) — `skyVisibilityQuality.ts:187-204`. The card copies only `label` (`SkyEventsCard.tsx:216,238,262,331`).
- `weather.windDirCardinal`, `spotWeather.windDirCardinal` (`weather.ts:140`, `spotWeather.ts:58`). Components call `degToCardinal` themselves.
- `cityOfficial.swimmingRating/snorkelingRating/surfingRating/summary` (`cityOfficial.ts:136-139,222-228`).
- `nws.alerts[].description` (only used in a regex, `ripRisk/types.ts:109`).
- `hourlyScores[].rating`, `hourly[].shortForecast` (scoring only).
- `Wrapped.note` for every source (~45 distinct, e.g. `"no beach cams here — crowd isn't tracked for this beach"`, `"rip model feed unavailable"`, `` `${filledByFallback…} from ${fallbackId}` ``). Several adapters also put `String(e)` (a raw JS error) here (`weather.ts:163`, `busyness.ts:656`, `clarity.ts:574`, `sargassum.ts:289`).

### 2C. Third-party or generated text — cannot be translated by a static catalog

| Field | Origin | Writer | Rendered by |
|---|---|---|---|
| `weather.data.shortForecast` | NWS observation `textDescription` or NWS hourly `shortForecast` | `weather.ts:61,119-120` | `ConditionsDashboard.tsx:950` (Air temp tile); pasted into a sentence at `explain.ts:103`; scoring regexes |
| `nws.data.alerts[].event`, `.headline`, `.severity`, `.description` | NWS CAP | `nws.ts:54-60` | `SafetyBanner.tsx:182,379,398,429`; `RipRiskCard.tsx:406` (`ripNow.upcomingAlert.event`) |
| `nws.data.srfPeriods[].label` | NWS Surf Zone Forecast headers (`TODAY`, `FRIDAY`) | `nws.ts:125-136` | `RipRiskCard.tsx:401` (`periodLabel`) |
| `cityOfficial.data.noSwimAdvisory.title` | City alert-bar link text, scraped | `cityOfficial.ts:176-196` | `SafetyBanner.tsx:194,337` |
| `cityOfficial.data.updatedLabel` | City page date string (English) | `cityOfficial.ts:152-160` | `LifeguardReport.tsx:44` |
| `waterQuality.data.sites[].name` | FL DOH site names, title-cased | `waterQuality.ts:140-146` | `SafetyBanner.tsx:326` |
| `tides.data.observed.stationName` | NOAA CO-OPS metadata | `tides.ts:109` | `TidePanel.tsx:36` |
| `skyEvents...launch.name` | Launch Library 2 mission/rocket name | `launchLibrary.ts:134` | `SkyEventsCard.tsx` title |
| `skyEvents...launch.status`, `.netPrecision` | LL2 enums | `launchLibrary.ts:89-113` | Mapped by `LAUNCH_STATUS_WORD` in `SkyEventsCard.tsx:267` (display words are ours) |
| `sargassum.data.note`, `sargassum.cams[].note` | AI vision model, English, <=8 words (`scripts/cam_seaweed.py:264-303`) | `sargassum.ts:209` | `nerdInfo.ts:538` |
| `busyness.data.note` (live read), `crowdNote` | Same vision job | `busyness.ts:565` | `BusynessCard.tsx:102,123` |
| `clarity.data.note` (live read), `perCam[].waterNote` | Same vision job | `clarity.ts:365,376` | Clarity tile sub-line (`clarityTileCopy`, passes through `compactGateNote`) |

These need machine translation at generation time or at runtime, or must stay English with a label. Note the AI notes share the field `note` with our own gate notes. A UI cannot tell them apart without string equality (3A-16).

### 2D. How the text travels

| Hop | Where | Locale-blind? |
|---|---|---|
| Build | `lib/conditions.ts:171-398,505-541` | Yes. No locale argument. |
| Server cache | `unstable_cache(["conditions", slug], 120 s)` `:445-460` -> KV (`open-next.config.ts`) | Key has slug only |
| SSR | `app/page.tsx:47-60`, `app/[slug]/page.tsx:62-103` pass `initial` to the client component | Hydration must match |
| Public API | `GET /api/conditions/[slug]`. `s-maxage=300, swr=600`; `?fresh=1` is `s-maxage=20` (`route.ts:58-63`). **`ALLOWED_QUERY = {"", "?fresh=1"}`; any other query returns 400** (`route.ts:13,27-32`). No `Vary`. | Yes |
| Other pollers | `ConditionsDashboard.tsx:160,241`; Live Activity poll `BeachModeCard.tsx:688` | Same URL |
| Share image | `app/api/share/[slug]/route.tsx:508-526`. Cache key = request URL. `max-age=900`. Calls `getConditions` -> `shareCardModel` -> satori. | Yes |
| History archive | `app/api/history/archive/route.ts:237` -> `lib/history/archive.ts:150-195` writes **`caps_json`, `factors_json` (labels + display), `rating`** into D1 `beach_hourly` | Persists English text |
| Push | `app/api/push/run/route.ts:396` | Out of scope |
| Client recompute | `deriveMetrics`, `applyLiveRipCap`, `explainScore`, `computeStormActivity`, `buildNerdInfo`, Plus `computePersonalScore` | Client-built strings mix with server strings in `caps[]` |

---

## 3. Code that depends on English wording

"Breaks" means what goes wrong silently if the string is Spanish at its source. Group A is first-party text matched by first-party code. Group E is third-party English matched on purpose; it only breaks if someone translates the adapter output.

### 3A. Our output matched by our code (translate-at-source breaks it)

| # | File:line | Matches | What breaks in Spanish |
|---|---|---|---|
| A1 | `lib/score.ts:1442,1465` | `RIP_CAP_LABEL_PREFIX = "rip current"`; `c.toLowerCase().includes(...)` over `base.caps` | The old rip cap is not removed. `applyLiveRipCap` appends a new rip label. Result: two rip lines, or a stale line after an alert ends. The live recompute exists to prevent exactly this. |
| A2 | `lib/score.ts:1488`; label built twice at `:1356-1360` (server cap) and `:1466-1471` (client re-label) | `otherCaps.includes(liveRipCapLabel)` (string equality; back-compat branch only) | Two copies of one sentence. If one copy is translated and the other is not, the page shows two rip lines (or none, via A1). Both copies must change together. |
| A3 | `lib/explain.ts:43` | `/seaweed\|sargassum/` over cap text -> hides the seaweed sub-score reason | Seaweed is explained twice (cap line and sub-score reason). |
| A4 | `lib/explain.ts:44` | `/thunder\|storm\|rain/` -> hides the sky reason | Rain/storm is explained twice. |
| A5 | `lib/explain.ts:49` | `/water quality\|no.?swim/` -> marks `waterQuality` covered | The comment at `:45-48` explains why this regex is narrow. In Spanish it matches nothing. |
| A6 | `lib/explain.ts:239-247` | 12 `includes`: seaweed, sargassum, lightning, thunder, raining, rain, flag, closed, advisory, no swim, severe, warning | Every cap falls through to the default warning icon. Icons stop meaning anything. (Note `"no swim"` never matches the real text `"no-swim"`; `"advisory"` catches it first.) |
| A7 | `components/ScoreCapBanner.tsx:8-10` | `SAFETY = /flag\|advisory\|lightning\|thunder\|rip current\|severe\|surf\|coastal[- ]flood\|closed\|no-swim/i` | Every safety cap is shown as a quality cap: amber, not rose. The "heed lifeguards and posted flags" suffix (`:59`) disappears. This is a safety-signal regression. |
| A8 | `lib/history/summary.ts:203,218`; persisted at `lib/history/archive.ts:192-195` | `Set<string>` dedupe + `.sort()` on archived cap strings; shown at `HistorySection.tsx:221-223` | Old rows stay English forever. A day shows both languages as duplicates. Sort order is English-alphabetical. |
| A9 | `lib/hazards/pointVsBeach.ts:54-58` | `reason.match(/^Lightning (.+?), (\d+) min ago$/)` then `.replace(/^(\d+(?:\.\d+)?) miles away$/,…)` and `.replace(/^within 5 miles$/,…)` | The match fails and the line degrades to `"Where you stand: lightning nearby"`. The distance and age are lost. |
| A10 | `lib/hazards/pointVsBeach.ts:64-65`; text written in 3 places: `hazards/assess.ts:152,157`, `app/api/hazards/route.ts:86`, `score.ts:1428` | `reason === "Raining right now"` and `=== "Rain in the last 20 minutes"` | The "where you stand" rain line never shows. `/api/hazards` sends the English `reason` to the client. |
| A11 | `lib/score.ts:1124` | `seaState(ft).label.toLowerCase()` embedded in the `waves` display | Fine if the label is translated, but the display is then a mixed fragment. It is copied to the share card (`shareCard.ts:121`). |
| A12 | `lib/shareCard.ts:57-60,114` | `s.replace(/~/g,"").replace(/\s*est\.?/gi,"")` on the sand display `"~101°F est."` (`score.ts:1153`) | A Spanish hedge word (`"aprox."`) is not stripped. The share image shows the hedge. |
| A13 | `lib/shareCard.ts:103,122` | `parseFloat` of `display` strings (`"78°F"`, `"7"`) (`score.ts:1089,1146`) | Holds only while the number comes first. A reordered template breaks the tile (it just drops). |
| A14 | `lib/explain.ts:224,227` | `v.label === "Barefoot fine"`, `v.label === "Scorching"` (`sandTemp.ts:432-435`) | Wrong sand sentence: "warm" text for scorching sand, or the reverse. |
| A15 | `lib/conditions.ts:537`; `lib/plus/personalScore.ts:72` | `today.dow === "Today"` | The "keep today's peak >= now-dot" fix is skipped. The day chip can read lower than the live dot. |
| A16 | `lib/sources/busyness.ts:324-325`; `camDayLabel` `:295-300` | `day.dayLabel === "today"`; `cap(day.dayLabel)` | The server sends `"today"`/`"yesterday"`/`"Friday"`/`"the last cam day"` as `dayLabel`. A translated `"hoy"` shows `"Hoy"` instead of the `"Earlier today"` branch. |
| A17 | `lib/sources/clarity.ts:424-430` | `note === NIGHT_NOTE / STALE_NOTE / NO_WATER_NOTE` (constants `:37-42`), where `note` crossed the server->client boundary in the payload | The compact tile text is replaced by the full 90-char sentence. The layout gate (`e2e/layout.spec.ts`) was added for exactly this overflow. A cached English payload against a Spanish constant also fails. |
| A18 | `lib/sources/busyness.ts:537`; `lib/sources/clarity.ts:317` | `note === NIGHT_NOTE` (same module) | Safe now. Breaks if the constant becomes locale-dependent at call time. |
| A19 | `components/SunQualityCard.tsx:167` | `b.horizonPath.startsWith("~")` (`sunQuality.ts:321-322`) | Picks the "estimated, not satellite-confirmed" note. A reworded template picks the wrong note. |
| A20 | `components/SunQualityCard.tsx:390` | `whenLine.replace(/(\d+h) (\d+m)/, "$1 $2")` on `formatDuration` output (`goldenHourTiming.ts:92-103`) | The no-break space is not inserted. The countdown can wrap mid-value. |
| A21 | `components/RipRiskCard.tsx:362-367` | `sentence(peakNote)` upper-cases char 0 and appends "." | Assumes a lower-case-first English fragment (`ripRiskCurve.ts:514`). |
| A22 | `lib/sharkContext.ts:257-269,305-307`; `lib/seasonalHazards.ts:160-161,213-215` | `factors.includes("murky water" \| "dawn/dusk" \| "near inlet")` | These are ids that look like English text. Translating the type literal changes the contract. |

First-party Group A count: **22** code sites.

### 3B. Forecast text matched by scoring math (hidden coupling)

`d.shortForecast` has two different sources. For the current snapshot it is NWS text (`score.ts:563`). For hourly buckets it is our own `wmoText` (`spotWeather.ts:7-24`, via `score.ts:1687`). So translating `wmoText` at source silently changes scores. The regexes need `thunder|storm`, `rain|shower`, `overcast`, `clear|sunny|fair`, `cloud`, `chance|slight|possible|isolated`.

| # | File:line | Regex | Consequence |
|---|---|---|---|
| B1 | `score.ts:486` | `/thunder\|storm/i` on `w.shortForecast` | The rain-corroboration storm signal is lost. A thunderstorm may cap at 25 instead of 15 (`:1418-1428`). |
| B2 | `score.ts:820-827` | `thunder\|storm` (min 45), `rain\|shower` (min 60), `overcast` (min 60) | Sky sub-score floors disappear. Every hourly score and best-window can move. |
| B3 | `score.ts:839-840` | `/clear\|sunny\|fair/i`, `/cloud\|overcast/i` | The "word vs number contradiction" guard (`"Clear · 98% cloud"`) stops working. |
| B4 | `score.ts:1246-1249` | `chance\|slight\|possible\|isolated`, `thunder\|storm`, `rain\|shower\|drizzle` | Text path of `rainSeverity`. `deriveMetrics` sets no `weatherCode`, so the **current** rain cap uses NWS text. Stays English while NWS stays English. |
| B5 | `score.ts:1420` | `/thunder\|storm/i` | "Thunderstorm — raining now" vs "Raining right now" choice. |
| B6 | `lib/safetyLine.ts:37` | `/thunder\|storm/i` | Safety line misses the storm wording. |
| B7 | `lib/explain.ts:85-87` | `/rain\|shower\|drizzle\|thunder\|storm/` | Wrong sky reason ("Partly cloudy" for a wet day). |

Group B count: **7**. B2 and B3 run on both paths: NWS English for the headline score, our `wmoText` labels for every hourly bucket. B5 reads NWS text for the headline and `wmoText` for the current-hour bucket (`weatherCode` is also checked first there). B1, B4, B6 and B7 read the current NWS text.

### 3C. Enum-like values that double as display text

| # | Value | Defined | Used as a key/logic at | Shown raw at |
|---|---|---|---|---|
| C1 | Rating words `Excellent/Good/Decent/Marginal/Poor/Unavailable` | `scoreBands.ts:33-37`, `score.ts:1183` | Stored in D1 `rating` (`archive.ts:153`); push (`lib/push/notify.ts:237`). The type comment (`push/notify.ts:41`, `types.ts:272`) still says `"Excellent \| Good \| Fair \| Poor"` (stale). | `ScoreWheel.tsx:270`; `DayOutlookStrip.tsx:116`; `shareCard.ts:156` |
| C2 | `SkyRatingLabel` `Poor/Fair/Good/Great/Amazing` | `sunQuality.ts:121-125`; `skyEventsTypes.ts:42` | `LABEL_RANK[label]` (`skyVisibilityQuality.ts:311`); `SUN_QUALITY_BANDS.find(b => b.label === label)` (`:215`); `SkyEventsCard.tsx:387` | `SkyEventsCard.tsx:124` |
| C3 | `StormActivityBand` `Calm/Unsettled/Stormy/Severe` | `stormActivity.ts:201-204` | `=== "Calm"` (`:275`); `BAND_TEXT_CLASS[band]` (`StormActivityMeter.tsx:10`) | `StormActivityMeter.tsx:51` |
| C4 | `UvBandWord` | `uv.ts:6-15` | none | `UvCard.tsx:117`; `shareCard.ts:123` |
| C5 | Enum ids shown by capitalising | `SargassumRisk`, `TrafficLevel`, `WaterQualityRating`, `BusynessLevel` (`types.ts`) | n/a | `ConditionsDashboard.tsx:930,1041,1063`; `BusynessCard.tsx:111,148`; `score.ts:1029`; `HistoryCharts.tsx:46`; CSS `capitalize` on tide type `TidePanel.tsx:173` |
| C6 | `cityOfficial` vocabulary words | `cityOfficial.ts:210-218` | n/a (no ids) | `LifeguardReport.tsx:34-44` joined with `", "` |
| C7 | `"Light"/"Dark"` | `ThemeToggle.tsx:64` | `switchTo === "Light"` (`:65`); `.toLowerCase()` inside `"Switch to ${x} mode"` | `:66,92` |

Group C count: **7**.

### 3D. Code that parses or reshapes formatted time and text

| # | File:line | What | Breaks with a non-en-US locale |
|---|---|---|---|
| D1 | `lib/format.ts:28` | `dayPeriod.toLowerCase().startsWith("p")` in `fmtTimeCompact` | `"6a"/"6p"` compact form is meaningless in 24-hour locales. |
| D2 | `lib/ripRisk/copy.ts:28`; `components/RipRiskCard.tsx:211` | `fmtTime(...).replace(/:00(?=\s)/, "")` | Assumes `"6:00 PM"` with a space. Drops nothing in `"18:00"`. |
| D3 | `components/TideCurve.tsx:135` | `fmtTime(...).replace(" ", "")` | Assumes space before AM/PM. |
| D4 | `components/SandTempPanel.tsx:287` | `fmtTime(...).replace(":00 ", "")` | Same. |
| D5 | `components/SunQualityCard.tsx:189-190`; `components/SkyEventsCard.tsx:381-382` | `fmtTime(...).split(" ")` to share one meridiem in `"7:18–8:03 PM"` | Spanish `"a. m."` splits wrong. 24-hour has no meridiem. |
| D6 | `lib/ripRiskCurve.ts:387-402` | `dayPeriod.toUpperCase()` equality, then `"2-4 PM"` | Spanish `"p. m."` -> `"P. M."`. Range logic still works, display is wrong. |
| D7 | `lib/sources/nws.ts:195-203` | `Intl en-US weekday:"long"` `.toUpperCase()` equals NWS `"SUNDAY"` | **Machine use.** A blanket `en-US` -> locale swap breaks SRF windows. |
| D8 | `lib/location/device.ts:206-207` | `/denied/i`, `/timeout/i` on a native error `message` | Only if the OS localises the message. Numeric `code` is checked first (`:202-205`). Low risk. |
| D9 | 36 `Intl` sites that are machine formats (section 4) | `en-CA` = `YYYY-MM-DD`; `en-US` + `hour12:false` = numeric hour | Must stay as they are. |

Group D count: **9**.

### 3E. Third-party English matched on purpose (keep these in English)

| # | File:line | Pattern |
|---|---|---|
| E1 | `score.ts:163-164` | `SEVERE_ALERT` list of NWS event names |
| E2 | `score.ts:631-636` | `SEVERE_ALERT.test(a.event) \|\| /^(Severe\|Extreme)$/i.test(a.severity)` |
| E3 | `score.ts:637-642` | `/beach hazards\|coastal flood advisory/i` |
| E4 | `score.ts:643-645` | `/high surf advisory/i` |
| E5 | `safetyTone.ts:79` | `/warning/i` on `alertEvents` |
| E6 | `safetyBannerRank.ts:67` | `/warning\s*$/i`; `severity === "Severe"/"Extreme"` |
| E7 | `ripRisk/types.ts:107-109` | `/rip current statement/i`, `/beach hazards? statement/i`, `/rip current/i` on headline+description |
| E8 | `SafetyBanner.tsx:98-99,177` | `/beach hazard/i` |
| E9 | `sources/nws.ts:54-58,123-136,187-203` | `"Actual"`, `Rip Current Risk … (Low\|Moderate\|High)`, `TODAY/TONIGHT/SUNDAY…` |
| E10 | `sources/cityOfficial.ts:59-196` | Flag colours, rating words, advisory/lifted regexes on city HTML |
| E11 | `sources/launchLibrary.ts:89-113`; `skyEvents.ts:234`; `SkyEventsCard.tsx:281,322` | LL2 `Minute/Hold/Cancelled/Success/Failure` etc. |
| E12 | `sources/waterQuality.ts:123,162-163` | DOH `"yes"`, site name case match |

Group E count: **12**. These keep working in Spanish. The risk is only that a translation pass "helpfully" rewrites adapter output.

### 3F. Composition and grammar (not a dependency, but cannot be translated word by word)

- Plurals by hand (no `Intl.PluralRules`): `score.ts:1205` (`factor`/`factors`), `plus/preview.ts:59`, `plus/entitlement.ts:122,125`, `sources/buoy.ts:332` (`"them"/"it"`). Components: `PlusOnboarding.tsx:253`, `SkyEventsCard.tsx:353-354`, `HistoryCharts.tsx:238`.
- Sentences glued from fragments: `ripRiskCurve.ts:514` (`"riskiest " + range + " " + reason`); `explain.ts:307-309` (`"Tuned for ${label}: ${a} and ${b} lead."`); `profile/resolve.ts:151` (`"${a} and ${b}"`); `vsAveragePhrase.ts:46` (`"about typical for a ${weekday}"`); `explain.ts:103` (our sentence + NWS English); `ThemeToggle.tsx:65`.
- Lists joined with an English "and" and an Oxford comma: `app/[slug]/beachDescription.ts:5-9`, `DataCoverageNote.tsx:40-44`, `sharkContext.ts:312-313`.
- Gendered or inflected phrases embedded in sentences: `profileLabel` words (`presets.ts:58-65`: `"dog walks"`, `"beach walks"`, `"kids"`).
- Same wording copied 3-5 times (drift risk). For example `"Double red flag — water access closed"` is in `score.ts:1297`, `safetyLine.ts:65,108`, `SafetyBanner.tsx:28`. `"Rip current warning in effect"` is in `score.ts:1358,1469`, `safetyLine.ts:78,115`, `ripRisk/copy.ts:60,62`. Sub-score factor names exist in `score.ts:1086-1157`, `plus/labels.ts:24-34`, `ScoreWheel.tsx:33-51` (short forms), `FACTOR_WORDS :879-891`.

### 3G. Persisted or cached English

| Store | Where | Content |
|---|---|---|
| D1 `beach_hourly` | `archive.ts:150-195` | `caps_json`, `factors_json` (`label`, `display`), `rating` |
| localStorage `bd:preview` | `plus/storage.ts:193,202`; `plus/preview.ts:66` | `PreviewRecord.label` = English profile phrase (`"snorkeling"`) |
| KV incremental cache | `conditions.ts:445-460` | Full English `ConditionsResponse` |
| Edge cache | `/api/conditions/[slug]` 300 s + 600 s SWR; `/api/share/[slug]` 900 s + 600 s | English JSON and PNG |

### 3H. Totals for this section

- First-party English-wording dependencies (A + B + C + D): **22 + 7 + 7 + 9 = 45 code sites**, in about 25 files.
- Third-party English matches (E): **12**.
- If only "break at the source" cases are counted (A + B), it is **29**.

---

## 4. Formatting helpers

### 4A. `lib/format.ts` and `lib/util.ts`

| Helper | Output | Call sites (files) | Locale handling |
|---|---|---|---|
| `fmtTime` (`format.ts:5-11`) | `"6:30 AM"` | ~47 call sites in 20 files (5 of them in `lib/alerts`) | `Intl.DateTimeFormat("en-US")` hard-coded |
| `fmtTimeCompact` (`:18-30`) | `"6a"`, `"6:30p"` | 7 (2: `DayOutlookStrip`, `RipRiskCard`) | en-US; letter `a/p` hard-coded (`:28`) |
| `fmtDate` (`:33-39`) | `"May 26"` | 8 in 3 files (`ConditionsDashboard` 2, `SafetyBanner` 4, `SkyEventsCard` 1) + 1 in `lib/alerts` | en-US |
| `fmtRelative` (`:46-54`) | `"just now"`, `"3m ago"`, `"2h ago"`, `"1d ago"` | 1 (`RelativeTime.tsx:49`; used by `SourceBadge`, `CamGrid`) | English words; no `Intl.RelativeTimeFormat` |
| `nextCamReadPhrase` (`:68-84`) | `"Next cam read in ~20 min"` | 5 (4 files) | English + `fmtTime` |
| `seaState` (`:92-104`) | 7 labels + 7 notes | 4 (3: `score.ts`, `explain.ts`, `WaveHeightCard`) | English; thresholds in code |
| `beachDayVerdict` (`:107`) | verdict | 4 (3: `ConditionsDashboard`, `shareCard`, `lib/push/notify.ts`) | English |
| `AQI_BANDS`, `aqiBand` (`:167-183`) | 6 EPA labels | 1 file (`AirQualityMeter.tsx`); `aqiCategory`, `aqiColor` have 0 callers | English |
| `scoreColor`, `scoreTextClass`, `interpolateColor` | colours | many | no text |
| `degToCardinal` (`util.ts:12-20`) | `N … NNW` (16) | 13 (11 files): `rainNowcast.ts:98`, `weather.ts:140`, `spotWeather.ts:58`, `launchLibrary.ts:378`, `score.ts:1098`, `nerdInfo.ts:191,709`, `SafetyBanner.tsx:361`, `WindCompass.tsx:104`, `LightningRadar.tsx:103,270`, `LightningCard.tsx:34` | English. Spanish West is `O`. `WindCompass.tsx:104` builds `"from WSW · blowing ENE"`. |
| `CARDINAL_WORDS` (`launchLibrary.ts:327-344`) | full English compass words | 1 | Second, separate English compass set |

No `Intl.NumberFormat`, `PluralRules`, `RelativeTimeFormat` or `ListFormat` is used anywhere. 35 `toFixed(` sites; one decimal point style.

### 4B. Local formatters outside `format.ts`

| Helper | File:line | Output |
|---|---|---|
| `fmtClock` | `ripRisk/copy.ts:27-34` | `"12 PM Fri"` |
| `fmtAriaTime`, `fmtRunLabel` | `RipRiskCard.tsx:209-214,31-35` | `"12 PM Fri"`, `"8 PM Wed"` |
| `hourParts`, `rangeLabel` | `ripRiskCurve.ts:384-404` | `"2-4 PM"` |
| `formatDuration`, `remainingPhrase` | `goldenHourTiming.ts:92-103` | `"2h 14m"`, `"23 min left"` |
| `fmtDurationShort` | `sunArc.ts:150-160` | `"2h 10m"` |
| `ageLabel` (x2) | `LightningCard.tsx:5`, `LightningRadar.tsx:41` | `"12 min ago"` |
| `weekdayDate`, `weekdayDateTime`, `fmtRange`, `coarseLaunchDate`, `meteorTimingLine` | `SkyEventsCard.tsx:244-306,360-385` | `"Wed, Oct 8"`, `"Q4 2026"` |
| `fmtRange` | `SunQualityCard.tsx:186-192` | `"7:18–8:03 PM"` |
| `mdLabel` | `DayOutlookStrip.tsx:73-80` | `"7/15"` (US order) |
| `hourLabel`, `fmtWeekday`, `fmtMD`, `fmtDayLong` | `HistoryCharts.tsx:44,73-85` | `"6a"`, `"Mon"`, `"7/15"` |
| `fmtChangelogDate` + `MONTHS` | `ChangelogSection.tsx` | `"Sep 28, 2026"` |
| `weekdayOf`, `weekdayLongOf`, `shortMonthDay` | `history/summary.ts:24-62` | hand-written arrays incl. `"Sept"` |
| `formatPreviewDate` + `MONTHS` | `plus/preview.ts:9,43-48` | `"Sep 1"` (a second month array) |
| `pillText` | `PullToRefresh.tsx:81` | `toLocaleTimeString(undefined,…)`. **Already uses the device locale**, unlike everything else. |
| `SHORT_WEEKDAYS` | `busyness.ts:263` | `"Wed"` (third weekday array; fourth is `vsAverage.ts:84`) |

### 4C. Every `Intl.DateTimeFormat` and `toLocale*` call (excluding `lib/alerts`, `lib/push`, `lib/liveActivity`)

53 sites. **17 are display text. 36 are machine formats and must keep their locale.**

Display (would need the active locale):
`format.ts:6,19,34`; `ripRisk/copy.ts:31`; `ripRiskCurve.ts:387`; `shareCard.ts:75,81`; `score.ts:1913` (writes `dow` into the payload); `sources/forecast.ts:29` (writes `forecast[].dow`); `SkyEventsCard.tsx:294,364` (+ year digits `:300,304`); `RipRiskCard.tsx:33,212`; `HistoryCharts.tsx:74,80`; `PullToRefresh.tsx:81` (device locale); `AdminConsole.tsx:182` (admin, device locale).

Machine, `en-CA` = `YYYY-MM-DD` key (19): `score.ts:1616,1822,1907`; `sources/sun.ts:220`; `tideAberration.ts:77`; `skyEvents.ts:377`; `sources/moonEvents.ts:229`; `sources/clarity.ts:557`; `sources/busyness.ts:627`; `sources/sargassum.ts:270`; `ripRisk/copy.ts:29`; `plus/preview.ts:14`; `PlusSettingsSheet.tsx:729`; `HistoryCharts.tsx:60`; `useAppOpenPing.ts:22`; `lib/db/scanFunnel.ts:53`; `app/api/admin/scans/route.ts:30`; `app/api/push/run/route.ts:74`.

Machine, `en-US` numeric parts (17): `conditions.ts:70`; `score.ts:1596,1869`; `sources/clarity.ts:98`; `camNextRead.ts:37`; `history/archive.ts:30`; `ConditionsDashboard.tsx:405,501`; `HistoryCharts.tsx:52`; `SkyEventsCard.tsx:249,297`; `sources/nws.ts:151,165,201`; `app/api/push/run/route.ts:72`; `app/api/devices/route.ts:46` (timezone validity probe).

### 4D. Units

Units are written into template strings. There is no unit layer. `util.ts:3-8` only converts metric -> imperial (`cToF`, `mToFt`, `msToMph`, `knotsToMph`, `kmhToMph`).

- `°F`, `mph`, `ft`, `mi`, `%`, `min` appear in user strings of `score.ts` (display + caps), `explain.ts` (~13 strings), `safetyLine.ts`, `waterTrend.ts`, `hazards/assess.ts`, `rainNowcast.ts`, `launchLibrary.ts` (degrees), `feelsLikeBeach.ts` (`"±N°"`), `sandTemp.ts`, `sharkContext.ts`.
- `WaveHeightCard.tsx:136,151` formats `toFixed(1).replace(/\.0$/, "")` + `" ft"`.
- Fixed-order `${number} ${unit}` templates: a unit or order change means editing each template.

---

## 5. Other server-rendered text

| Item | File | Rough strings | Notes |
|---|---|---|---|
| Root layout metadata | `app/layout.tsx:9-47` | 7 (title, template, description, applicationName, apple title, OG title/desc/siteName, twitter) | `<html lang="en">` fixed (`:89`). JSON-LD names (`:50-62`). |
| Beach metadata | `app/[slug]/page.tsx:12-14,32-46,76-92` | 6: title template, OG title, `"Home"`, `"Find your beach"`, description | `beachDescription.ts:11-17`: 7 fixed topic words + 3 conditional (`seaweed`, `crowds`, `water quality`, `lifeguard flags`) + Oxford-comma join (`:5-9`) |
| Home page | `app/page.tsx:20-35,60-91` | ~5: canonical, `"We couldn't load conditions"`, body, retry | `force-dynamic` (reads UA) |
| Find page | `app/find/page.tsx` | 10 | metadata + body (~210 words) |
| `BeachFinder` | `components/BeachFinder.tsx` | ~15 (component, listed for completeness) | `localeCompare` on names (`:80,82`); lower-case `includes` search (`:50-56`) |
| Support | `app/support/page.tsx` | 21 blocks, ~540 words, metadata 4 | static FAQ |
| Privacy | `app/privacy/page.tsx` | 23 blocks, ~1,200 words, metadata 4 | `EFFECTIVE_DATE = "September 28, 2026"` (`:5`) |
| Not found | `app/not-found.tsx` | 3 | |
| Error | `app/error.tsx` | 3 | |
| Global error | `app/global-error.tsx` | 3; `lang="en"` (`:25`) | |
| OpenGraph image | `app/opengraph-image.tsx:7,76,87` | 3: alt, headline, tagline | |
| Twitter image | `app/twitter-image.tsx` | 0 (re-exports OG) | |
| Share card image | `app/api/share/[slug]/route.tsx` + `lib/shareCard.ts` | ~13 labels, `"Is it beach day?"` (`:470`), `/100`, verdict, rating, `capNote`, 2 date/time labels | Text comes from the English payload. `Cache-Control: max-age=900` (`:526`) |
| Manifest | `app/manifest.ts:6-9` | 3: name, short_name, description | |
| Sitemap | `app/sitemap.ts` | 0 text; 4 static URLs + 40 beach URLs | No `hreflang` / language alternates anywhere (`rg hreflang` = none) |
| Robots | `app/robots.ts` | 0 | |
| JSON-LD | `app/layout.tsx:50-62`, `app/[slug]/page.tsx:76-92` | 6 names | `"Home"`, `"Find your beach"` |
| Dashboard footer | `ConditionsDashboard.tsx:1233-1292` | ~12 | In component; listed because it is in the SSR HTML |
| Inline helpers in the dashboard | `ConditionsDashboard.tsx:96-122` | 12 (`dewComfort` 6, `humidityNote` 5) | Text lives in the component file, not in `lib/` |

---

## 6. Totals and top 5

### 6A. Rough counts of distinct translatable strings or templates

| Section | Count | Comment |
|---|---|---|
| 1. `lib/` producers (excluding `nerdInfo`, `changelog`, admin `resolve`, push) | **~650** | ~100 are provider names, notes and attributions. ~42 are never rendered (marine stinger + shark). About 26 are repeated copies of weekday/month arrays (5 copies of 26 names). Net unique, rendered, translatable: **~470**. |
| 1H. Long prose | `nerdInfo.ts` ~220 long strings (53.6 KB); `changelog.ts` 122 entries (37.7 KB) | Separate project |
| 2A. Payload text that is ours and rendered | **~190** | caps 19, sub-score labels 11 and displays 11, ratings 6, weekdays 8, WMO labels 13, moon phases 8, nowcast 4, cardinals 16, trend notes 4, peak-note fragments 8, cam words/notes ~25, vocab 6, sky 2+16+7+5, source/attribution ~25 |
| 2B. Payload text that is ours but never rendered | **~90** | Candidates for removal |
| 2C. Third-party or AI text in the payload | **12 fields** | Not catalog-translatable |
| 3. English-wording dependencies | **45 first-party + 12 third-party** | A 22, B 7, C 7, D 9, E 12 |
| 4. Formatters | **~25 helpers**, 53 `Intl`/`toLocale` sites (17 display, 36 machine), 16 + 16 compass words, 4 weekday/month arrays | |
| 5. Other server-rendered text | **~110 strings** plus ~1,750 words in Support and Privacy | |

### 6B. Top 5 "this will bite us"

1. **Cap strings are identity, not display.** `ScoreResult.caps` is `string[]` with no code. Eight places match it (3A: A1-A8). A7 changes safety colour. A1/A2 duplicate the rip line. A8 plus the D1 archive means mixed-language history that never heals. The same strings are also written in 3-5 places each and in two runtimes (server `computeScore` and client `applyLiveRipCap`/Plus re-score). Translating at source breaks all of it. A code + params model is needed first.
2. **The pipeline is locale-blind end to end.** `?lang` or any new query is a 400 (`route.ts:13,27`). The edge cache key is the URL with no `Vary`. `unstable_cache` key is slug only. The share image cache key is the URL. D1 stores English caps and ratings. SSR must know the locale before hydration, or React #418 returns. Locale needs a path segment, a distinct cache key, and the archive must store codes.
3. **Hidden scoring coupling to forecast wording.** `score.ts:820-827,839-840,1420` regex our own `wmoText` labels on the hourly path (192 buckets); `:486,1246-1249` regex NWS text on the current path. Translating `wmoText` at source silently changes hourly sky scores, day peaks and best-time windows. Keep `weatherCode` as the logic key and move the label to the client.
4. **Enum-as-display and `dow === "Today"`.** Rating words, `SkyRatingLabel`, `StormActivityBand`, `UvBandWord`, capitalised enum ids, `dayLabel === "today"`, `dow === "Today"` (`conditions.ts:537`, `personalScore.ts:72`) are both id and text. Plus fragment-built sentences (`peakNote`, `Tuned for ${label}`, `"about typical for a ${weekday}"`) and hand plurals. These need ids plus per-language templates, not word swaps.
5. **`en-US`/`en-CA` are both display and machine.** 36 of 53 sites are machine parsing and must not change; 17 are display. Time strings are then edited by hand: `.replace(":00 ", "")`, `.replace(" ", "")`, `.split(" ")`, `startsWith("p")` (D1-D6). Spanish `a. m.`/`p. m.` and 24-hour breaks these. A blanket find/replace of `"en-US"` would break NWS SRF windows (`nws.ts:195-203`). Compass `W` -> `O` and `degToCardinal` text ride in 13 call sites plus a second English compass set.

Also worth knowing before design:
- ~90 shipped strings are never rendered. Remove them before translating.
- Three vision-job fields mix AI English text with our own gate-note constants in the same `note` field (`clarity.ts:343,365,376`; `busyness.ts:565`). They cannot be told apart except by string equality (A17).
- Facts that help: `lib/plus/api.ts:235-264` already follows "server sends code, client owns text". `SafetyBanner.tsx` ids (`"wq-advisory"`, `flag-*`) are stable keys. `WaterTrendCard.tsx:23-29` already builds its text from `status` and a number.
- Tests: ~94 test files assert English strings (`rg`), plus `e2e/layout.spec.ts` for overflow of the compact notes.
