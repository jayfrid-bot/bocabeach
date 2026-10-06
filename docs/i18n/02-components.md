# i18n inventory 02: React components and pages

Repo: `/Users/yitzfrid/Projects/bocabeach`. Scope: every non-test `.tsx` file under `components/` and `app/`. Skipped on purpose: `components/admin/AdminConsole.tsx` and `app/admin/yf/page.tsx` (owner-only, stay English).

Text that comes from `lib/` (score explanations, nerd-back builders, changelog, plus labels, share-card copy) is not counted here. Section 3 lists which components pull text from which `lib/` module, so the lib inventory can be matched against this one.

## 0. Summary

| Measure | Value |
|---|---|
| Files in scope | 79 (16,226 lines) |
| Distinct user-visible strings in these files | about 923 (908 after removing 2 dead components) |
| English words in those strings | about 6,700 (privacy 1,130, support 470, the three nerd-back cards 1,500) |
| Client files (`"use client"`) | 42 |
| Server entry files (layout, pages, routes, OG image) | 10 |
| No directive, but only used inside the client tree | 27 (they run on the client) |
| Complexity (H / M / L) | 18 / 33 / 28 |
| Dead code found | `components/MoonPanel.tsx`, `components/AdvisoryStrip.tsx` (no importer; 15 strings) |
| Existing React context | none (`createContext` / `useContext` appear nowhere in `app/`, `components/`, `lib/`) |
| Text outside `.tsx` that also needs work | `mobile/www/index.html` (3 strings), `public/app-store-badge.svg` (English badge art), `e2e/*.spec.ts` (about 40 English selectors) |

How the counts were made. A TypeScript AST pass collected JSX text, string props, aria text, template strings and state-set messages. That gave 1,113 raw candidates. I then read every file and removed CSS classes, keys, URLs and duplicates. Counts for the 15 largest files (marked with a star in the table) are exact to my reading. Counts for the others are within about 10 percent. One template string counts once, even if it has several variables. One long nerd-back paragraph counts once.

## 1. Per-file table

Legend. Kind: `client` has a `"use client"` directive. `server` is a route, page, layout or image route. `client tree*` has no directive, but only client files import it, so it runs on the client and may call hooks. Strings: distinct user-visible strings. Words: rough English words from an automated pass (use for sizing only). Group: work group from section 4 (`dead` = skip). Cx: complexity (L, M, H).

Sorted by line count, largest first.

| # | File | Lines | Kind | Strings | ≈Words | Group | Cx | Notes |
|---|---|---:|---|---:|---:|---|---|---|
| 1 | `components/ConditionsDashboard.tsx` | 1347 | client | 62 | 183 | G1 | H | ★ counted. Page owner. 20 FlipCard labels, about 20 tile note words (dew point, humidity, cloud, status), 15 footer strings; plus ~12 enum/lib values shown raw (:930,:1041,:1063 etc.). |
| 2 | `components/plus/BeachModeCard.tsx` | 1322 | client | 31 | 200 | G6 | H | ★ counted (1,322 lines, 31 strings - mostly logic). Pure `lockScreenRowState` returns English `message` (:233-249, unit-tested); name of iOS Settings path baked into a sentence (:248). |
| 3 | `components/plus/PlusSettingsSheet.tsx` | 812 | client | 60 | 204 | G5 | H | ★ counted (812 lines). Sentence from two times (:739), `Reset to {chip}` (:357), lead labels `1 h` (:713-717), duplicates ~11 strings with Paywall (code entry, restore notes, support ID); alert labels live in lib/plus/labels.ts. |
| 4 | `components/RipRiskCard.tsx` | 586 | client | 34 | 609 | G2 | H | ★ counted. ~610 words: 5 long nerd-back paragraphs (:442-480), 11 computation templates, SVG `now` text (:176-186), band words reused as keys. `sourceLabel()` strings (:16-28) are dead (only truthiness used). |
| 5 | `components/plus/HistorySection.tsx` | 586 | client | 32 | 124 | G6 | H | ★ counted. Own AM/PM + a/p (:39-48); stats joined with " · " (:54-63); fixed 64/80 px day cells with 7-10 px text (:133-168); exported `recordTiles` (unit-tested). |
| 6 | `components/SunQualityCard.tsx` | 547 | client | 41 | 511 | G3 | H | ★ counted. ~510 words nerd-back; duration regex `(\d+h) (\d+m)` (:390); AM/PM parse (:186-192); tests pin `cardTitle` + band labels. |
| 7 | `app/api/share/[slug]/route.tsx` | 535 | server | 3 | 36 | G6 | H | Share-card PNG via satori (535 lines, almost no literal text). Copy comes from lib/shareCard.ts. Cached by full URL (`s-maxage=900`, :507-533), so locale must be in the URL or cache key. |
| 8 | `components/plus/Paywall.tsx` | 524 | client | 38 | 214 | G5 | H | ★ counted. Billing/App Review copy; price `{price}/{PER}` (:315); `key={b.title}` (:333); e2e selects 7 strings. |
| 9 | `components/TideCrossSection.tsx` | 478 | client | 6 | 19 | G3 | H | ★ counted (478 lines, 6 strings). SVG labels in a `preserveAspectRatio="none"` box (:364-472): `high`/`low`, `normal high`/`normal low`, `High 3:42 PM`. |
| 10 | `components/PullToRefresh.tsx` | 457 | client | 4 | 24 | G1 | M | ★ counted (457 lines, 4 strings). Exported pure `pillText` (:78-83, unit-tested) uses `toLocaleTimeString(undefined)` (:81). |
| 11 | `components/ScoreWheel.tsx` | 454 | client | 37 | 424 | G4 | H | ★ counted. 11 factor labels + 3 abbreviations + 11 explainer paragraphs; SVG <text> with width-fit algorithm (`LABEL_CHAR_W`, :63-130); tested `planLabel`. |
| 12 | `components/SafetyBanner.tsx` | 442 | client | 28 | 147 | G2 | H | ★ counted. NWS event text matched by regex (:98,:99,:177); `truncate` headline (:291); +N more joins (:217-219,:243-248); plural (:373). |
| 13 | `components/SkyEventsCard.tsx` | 408 | client | 45 | 157 | G3 | H | ★ counted. 4 exported pure helpers (unit-tested); plural days/hours (:353-354); `Q{n} {year}` (:301); AM/PM `split(" ")` parse (:378-384); rating label used as colour key (:387). |
| 14 | `components/DayOutlookStrip.tsx` | 302 | client | 19 | 121 | G4 | H | ★ counted. 7-column grid at 390 px (~48 px cells); `m/d` label (:76-82); aria label joined with ", " from 10 clauses (:84-99). |
| 15 | `components/SandTempPanel.tsx` | 300 | client | 8 | 57 | G3 | H | ★ counted. 4 zone labels absolutely positioned at 14/43/68/89.5 % with nowrap (:196-207); comment at :194 says 375 px already collides in English. |
| 16 | `components/NotifyButton.tsx` | 298 | client | 10 | 67 | G1 | M | Emoji inside accessible name "🔔 Alerts…" (:259-262) which e2e selects; native error text passed through (:159,:293). |
| 17 | `components/SunArc.tsx` | 294 | client | 9 | 28 | G3 | M | 7 SVG <text> nodes incl. emoji and moon phase line (:167-265); status label from lib/sunArc. |
| 18 | `components/HistoryCharts.tsx` | 292 | client | 23 | 103 | G4 | H | 4 chart titles/subtitles/aria; `read(s)` plural (:238); en-US weekday/month (:74-85); a/p hour label (:45); axis words also enum keys (:157,:203). |
| 19 | `components/LightningRadar.tsx` | 276 | client tree* | 11 | 58 | G2 | M | SVG <text> (:171,:198,:223); duplicate `ageLabel` (:41-46); 3 aria sentences (:97-105); `degToCardinal` (:103,:270). |
| 20 | `components/plus/PlusOnboarding.tsx` | 263 | client | 23 | 100 | G5 | M | Plural + above/below (:251-255); choices (:14-24) duplicated in PlusSettingsSheet; 8 e2e-selected strings. |
| 21 | `components/FlipCard.tsx` | 246 | client | 10 | 36 | G1 | M | Interpolates the card label into two English sentences (:99-103); NerdBack headings (:180-239). |
| 22 | `components/ClarityScene.tsx` | 230 | client tree* | 1 | 11 | G4 | L | SVG scene has no text; tile copy comes from lib/sources/clarity. |
| 23 | `app/privacy/page.tsx` | 229 | server | 38 | 1132 | G7 | H | Legal policy, ~1,130 words, 9 sections; needs legal review in Spanish. `EFFECTIVE_DATE` English long date (:7). Paragraphs split around mailto links (:125, :214). |
| 24 | `components/FeelsLikeCard.tsx` | 220 | client tree* | 28 | 372 | G4 | H | Nerd-back paragraphs + 15 computation fragments with U+2212 minus and "+N°F" arithmetic (:131-157). |
| 25 | `components/CamGrid.tsx` | 212 | client tree* | 16 | 94 | G2 | M | Status overlays mix fragments + <RelativeTime> (:26-28, :75-81); several `title=` tooltips. |
| 26 | `components/plus/Sheet.tsx` | 207 | client | 1 | 2 | G1 | L | Dialog shell; "Close" aria x2 (:85,:107). Inline `fixed` element, NOT a portal. |
| 27 | `components/ShareCardSheet.tsx` | 196 | client | 15 | 83 | G6 | M | Strings also go to the OS share sheet (:74-75); format labels include `×` (:14-15) and feed aria/alt (:152,:173). |
| 28 | `components/TidePanel.tsx` | 185 | client tree* | 16 | 62 | G3 | M | Exported `observedChip` (unit-tested, :21-54); four anomaly badges (:75-103); `ft` units. |
| 29 | `components/TideCurve.tsx` | 175 | client | 1 | 1 | G3 | L | SVG "now" (:161-170) and time labels via `.replace(" ", "")` (:135). |
| 30 | `components/BeachFinder.tsx` | 171 | client | 13 | 52 | G6 | M | Search over `name region` lowercased (:56); state groups sorted with localeCompare (:80-82); `mi` unit (:25); mailto subject (:152). |
| 31 | `components/BusynessCard.tsx` | 167 | client tree* | 7 | 21 | G4 | M | Own AM/PM `hourLabel` (:10-13); `cap(level)` shows an enum as text (:111,122,148); phrases from lib/vsAveragePhrase and lib/sources/busyness. |
| 32 | `app/support/page.tsx` | 158 | server | 36 | 466 | G7 | H | Long-form FAQ prose (~470 words), sentences split around <Link>/<a> (:82-86, :111-115). References a "Notify me" button that no longer exists in the UI (stale copy). |
| 33 | `components/plus/FirstRunBanner.tsx` | 158 | client | 7 | 20 | G6 | M | e2e selects `Nearest beach`, `Find my nearest beach`, `Dismiss`; `router.replace` to /<slug> (:85). |
| 34 | `components/WaveHeightCard.tsx` | 157 | client tree* | 4 | 20 | G4 | M | Phone-width headline was already shortened once (:130-132). |
| 35 | `components/LevelBarChart.tsx` | 131 | client tree* | 1 | 5 | G4 | M | SVG <text> axis captions and `key={cap + i}` (:53-61). |
| 36 | `components/UvCard.tsx` | 126 | client tree* | 3 | 9 | G4 | L | Band label from lib/uv. |
| 37 | `app/[slug]/page.tsx` | 122 | server | 5 | 33 | G7 | M | beachTitle template (:11), JSON-LD breadcrumb names (:90-92); `beachDescription` is in a sibling file/lib. `[slug]` collides with a `[locale]` URL segment. |
| 38 | `app/layout.tsx` | 112 | server | 4 | 84 | G7 | M | Metadata only (title/description/OG/JSON-LD) plus hard-coded <html lang="en"> (:89). Metadata is static; needs generateMetadata per locale. |
| 39 | `components/WindCompass.tsx` | 110 | client tree* | 6 | 13 | G4 | M | SVG N/E/S/W letters (:63-66); `from {dir} · blowing {dir}` (:104). Spanish west is O. |
| 40 | `components/AppStoreBand.tsx` | 105 | client | 4 | 29 | G1 | M | `line-clamp-2` on phone (:71). Badge image is a static English SVG (public/app-store-badge.svg). |
| 41 | `components/ChangelogSection.tsx` | 98 | client | 18 | 22 | G7 | M | MONTHS array + "Mon D, YYYY" (:20-40); renders ~120 English changelog entries from lib/changelog.ts (800 lines, not counted here). |
| 42 | `components/ThemeToggle.tsx` | 95 | client | 6 | 11 | G1 | M | "Light"/"Dark" compared with === and lowercased into aria (:63-65,:92). |
| 43 | `components/MoonPanel.tsx` | 94 | client tree* | 13 | 24 | dead | L | DEAD CODE: no importer (replaced by SunArc readout). 8 phase names + 5 labels. |
| 44 | `components/ScoreExplainer.tsx` | 94 | client tree* | 5 | 25 | G1 | L | Body comes from lib/explain.ts (explainScore). |
| 45 | `app/opengraph-image.tsx` | 93 | server | 3 | 20 | G6 | M | Text baked into a generated PNG (:65-88). One shared image referenced by every page's OG metadata. |
| 46 | `components/StormActivityMeter.tsx` | 92 | client tree* | 7 | 31 | G4 | M | Band enum ("Calm"..."Severe") is both display text and CSS key (:10-15,:51,:64-67). |
| 47 | `app/page.tsx` | 91 | server | 4 | 24 | G7 | L | Home; passes `initial`/`beaches` to dashboard. Only inline text is the data-outage fallback (:78-90). |
| 48 | `components/AdvisoryStrip.tsx` | 88 | client | 2 | 12 | dead | L | DEAD CODE: no importer. Only e2e/layout.spec.ts:92 still names it. |
| 49 | `components/LifeguardFlag.tsx` | 87 | client tree* | 13 | 28 | G2 | M | FLAG_META label/short for 6 flags (:3-13); aria built from enum `flag.replace("-", " ")` (:49,:70). |
| 50 | `components/plus/PersonalizeCard.tsx` | 78 | client | 5 | 30 | G5 | L | e2e selects "Personalize my score"/"Your score". |
| 51 | `components/LightningCard.tsx` | 75 | client tree* | 12 | 61 | G2 | M | Duplicate `ageLabel` (:5-10); sentence assembled from counts (:34-38,:55). |
| 52 | `components/plus/SafetyLine.tsx` | 75 | client | 8 | 13 | G2 | M | Heading + word + first reason joined (:67-70); reasons from lib/safetyLine. |
| 53 | `components/LocalCoverage.tsx` | 71 | client tree* | 9 | 64 | G2 | M | Sentences split around bold lead-ins and a link (:36-65). |
| 54 | `app/global-error.tsx` | 70 | client | 3 | 18 | G7 | M | Renders its own <html lang="en"> (:25), so it sits OUTSIDE any layout-level provider; needs its own locale source. |
| 55 | `components/plus/PlusInAppCard.tsx` | 69 | client | 9 | 87 | G5 | M | Price line hard-codes USD + `3-day free trial` (:53); `key={line}` (:43); e2e matches the price string. |
| 56 | `components/AirQualityMeter.tsx` | 67 | client tree* | 2 | 11 | G4 | L | Band label from lib/format AQI_BANDS. |
| 57 | `components/ScoreCapBanner.tsx` | 63 | client tree* | 3 | 11 | G1 | M | Regex classifies cap text by English words (:7); caps joined " · " (:58). |
| 58 | `components/SeasonalHazards.tsx` | 63 | client tree* | 2 | 14 | G2 | L | Rows come from lib/seasonalHazards. |
| 59 | `components/Logo.tsx` | 62 | client tree* | 1 | 4 | G1 | L | Wordmark "Is it beach day?" (:58) - brand, probably keep. |
| 60 | `components/SunPanel.tsx` | 62 | client tree* | 12 | 17 | G3 | L | `key={r.label}` (:36). |
| 61 | `components/plus/ScoreToggle.tsx` | 60 | client | 4 | 11 | G5 | M | Two non-wrapping 40 px pills + gear in one row (:25-58); e2e selects 3 strings. |
| 62 | `components/MetricCard.tsx` | 59 | client tree* | 0 | - | G1 | L | Props only. Has the `subShort` phone-width pattern (:42-49) other tiles may need. |
| 63 | `app/find/page.tsx` | 58 | server | 10 | 110 | G7 | M | ISR (`revalidate = 300`, :8) so reading cookies/headers would make it dynamic. `{n} beaches` count sentence (:41). |
| 64 | `components/plus/HomeBeachRedirect.tsx` | 56 | client | 0 | - | G6 | L | Redirect only; `router.replace('/${home}')` (:52) needs locale prefix if URL-based. |
| 65 | `components/WindSpinner.tsx` | 51 | client tree* | 0 | - | G4 | L | No text. |
| 66 | `components/RelativeTime.tsx` | 50 | client | 0 | - | G1 | L | Calls lib `fmtRelative` (English); placeholder "…". |
| 67 | `components/LifeguardReport.tsx` | 49 | client tree* | 5 | 15 | G2 | L | Data arrays (marine life, hazards) come from the city feed in English. |
| 68 | `components/DataCoverageNote.tsx` | 44 | client tree* | 7 | 15 | G1 | M | Sentence built from list join with English "and"/Oxford comma (:22-44). |
| 69 | `components/plus/HeaderSubtitle.tsx` | 44 | client | 3 | 12 | G6 | M | `truncate` line (:38); " away" + " · " + auto-tier note joined inline (:39-41). |
| 70 | `components/plus/NearYouChip.tsx` | 44 | client | 3 | 9 | G6 | L | Duplicate `miles()` (:9-11). |
| 71 | `components/WaterTrendCard.tsx` | 40 | client tree* | 3 | 26 | G4 | L | Three sentence templates (:24-29). |
| 72 | `app/error.tsx` | 38 | client | 3 | 16 | G7 | L | Error boundary inside layout (provider reaches it). |
| 73 | `components/SourceBadge.tsx` | 30 | client tree* | 5 | 2 | G1 | L | "Data sources" + status enum shown as tooltip (:21). |
| 74 | `components/ServiceWorkerRegister.tsx` | 25 | client | 0 | - | G1 | L | Unregisters old workers; no text (layout-level). |
| 75 | `components/NativePushInit.tsx` | 16 | client | 0 | - | G1 | L | Renders null (layout-level). |
| 76 | `app/not-found.tsx` | 15 | server | 3 | 16 | G7 | L |  |
| 77 | `components/AppOpenPing.tsx` | 9 | client | 0 | - | G1 | L | Renders null. |
| 78 | `components/ReloadOnNewVersion.tsx` | 9 | client | 0 | - | G1 | L | Renders null (layout-level). |
| 79 | `app/twitter-image.tsx` | 2 | server | 0 | - | G6 | L | Re-export of opengraph-image. |

Files with no strings of their own (9): `AppOpenPing`, `NativePushInit`, `ReloadOnNewVersion`, `ServiceWorkerRegister` (all render null), `MetricCard`, `RelativeTime`, `WindSpinner`, `HomeBeachRedirect`, `app/twitter-image.tsx` (re-export). Their text comes from props or `lib/`.

Big files with a small string surface: `BeachModeCard` (1,322 lines, 31 strings), `TideCrossSection` (478 lines, 6), `PullToRefresh` (457 lines, 4), `app/api/share/[slug]/route.tsx` (535 lines, 3). Do not size these by line count.

## 2. Hard cases

### 2.1 Sentences built from fragments, joins or conditional pieces

A flat key-to-string table does not fit these. Spanish word order, gender and number differ. Use message templates with named variables (ICU style) and keep the full sentence in one message. About 70 sites.

Dashboard and shell
- `ConditionsDashboard.tsx:1046-1048` seaweed sub-line is three pieces: `📷 {AM cams (pre-clean) | cams}` + ` · ~{n}% covered` + `seaweedVsAvgPhrase()` from lib.
- `ConditionsDashboard.tsx:1066-1067` `{n}% congestion near the beach` or `near the beach`.
- `ConditionsDashboard.tsx:1267-1277` footer: `v{ver}` + ` · build {n}` + ` ({sha})` + `last built {date}, {time}` + `data updated {date}, {time}`.
- `ConditionsDashboard.tsx:761-765` `Best time left today: {t}–{t}` (text + nowrap range).
- `ConditionsDashboard.tsx:557` aria: `{name} — choose a different beach`.
- `FlipCard.tsx:99-103` the card label is dropped into two English sentences: `Flip the {label} card for the data, math, and sources` and `Show the {label} reading again`. Gender and article agreement with `{label}` will break in Spanish.
- `DataCoverageNote.tsx:22-34` `{Limited|Partial} data: no {list} for this beach. estimated: {list}.` Joined by `formatWordList` (`:40-44`) with English "and" and an Oxford comma.
- `ScoreCapBanner.tsx:55-59` prefix + score + `caps.join(" · ")` + suffix chosen by tone.
- `HeaderSubtitle.tsx:39-41` `{distance} away` + `" · "` + `Auto-resolved — some local data pending`.
- `NearYouChip.tsx:31-33` two sentences with `{mi} from {name}` and `Nearest covered beach: {name}, {mi}`. Same shape at `FirstRunBanner.tsx:95`.
- `ThemeToggle.tsx:63-65,92` `Switch to {light|dark} mode` (the word is lower-cased by code), `{Light|Dark} mode`.
- `AdvisoryStrip.tsx:73-75` `Hide|Show the science behind the {label}` (dead file).

Safety
- `SafetyBanner.tsx:217-219` `{event} begins soon (+{n} more)`; `:243-248` `{text} +{n} more`.
- `SafetyBanner.tsx:326-328` water advisory: `High enterococci bacteria` + ` at {sites}` + `.` + ` Sampled {date}.` + attribution.
- `SafetyBanner.tsx:360-363` `Nearest strike {n} mi` + ` to the {dir}` + ` · {n} min ago` + `. NOAA GOES GLM.`
- `SafetyBanner.tsx:373` `NWS Beach Hazards {Statement|Statements} in effect`; `:380,:430` ` — until {date}`; `:399` ` begins {date}`.
- `LightningCard.tsx:34-38,55,71` headline `{n} mi{ dir} · {age}`; sub `{a} within 10 mi · {b} within 25 mi (last {n} min)`; ` · feed delayed — may be out of date`; ` · as of {age}`.
- `LightningRadar.tsx:101-104,268-270` three aria and caption variants built from distance, cardinal and age.
- `LocalCoverage.tsx:36-65` bold lead-in + rest of sentence in separate spans; one item has a link in the middle (`check the {program.name} ↗`).
- `LifeguardReport.tsx:43-45` `Official report from {attribution}{ · updated}. Always heed posted signs and lifeguards.`
- `CamGrid.tsx:26-28` and `:75-81` `📷 {time} · {relative}`, `Feed paused — ` + `Last feed {time} · {relative}`, `Refreshing… last data {relative}`.
- `StormActivityMeter.tsx:71-75` fixed sentence plus optional ` · rain observed by radar`.

Sky, sun, tide, sand
- `SkyEventsCard.tsx:199` `{base} Repeats through {when}.`
- `SkyEventsCard.tsx:206-210` `{Total|Partial} eclipse during the full moon`, `{day}, peak {t}`, `{day}, visible here {range}`.
- `SkyEventsCard.tsx:228-232` `{Rises over the water at | Moonrise at} {t}.` + optional `This is the closest full moon of the year.`
- `SkyEventsCard.tsx:282-284` `Window {range}, {date}`; `{coarse} — time not set`. `:301` `Q{n} {year}`. `:313-315` lines joined with `" "` (`Twilight launch…`, `Status: {word}.`).
- `SkyEventsCard.tsx:353-357` countdown: `Launches in {n} day(s), {m} hour(s).`, `Launches in {h}h {m}m.`
- `SunQualityCard.tsx:80,83` cloud lines; `:114-127` `Horizon path: …`, `→ {n}/100 ({band})`; `:131` `{Sunrise|Sunset} color potential`; `:179-181` `Peak color ~{t} ({m} min after|before {event})`; `:254-256` aria `Golden hour {range}, {event} {t}`; `:343,348-352` `{headline} · {badge}`, `{range} · {kind} {t}`; `:407-408` `{Sunrise|Sunset} color now`, `Upcoming {event} color`; `:518-519` `Golden hour {a}–{b} (20 min either side of the {event}[, estimated])`.
- `FeelsLikeCard.tsx:131-157` fifteen arithmetic fragments: `+{n}°F direct sun` + ` ({n}% cloud)` + `, sun {n}° up`; `−{n}°F wind cooling ({n} mph` + `, damped by humidity` + `)`. `:109` `drivers.join(" · ")`.
- `RipRiskCard.tsx:232-234` `{Level} now, rising to {Level} by {time}`; `:319` tooltip `{t}: {n}% ({Level})`; `:382-387,396-407,420-429` model/office/threshold lines.
- `TidePanel.tsx:37-41,51` `Observed: {h} ft — {rel} ({place} gauge)`; `:80-99` four anomaly badges with `≈{n} ft above normal`; `:174` `{High|Low} tide`.
- `TideCrossSection.tsx:168` SVG `{High|Low} {time}`.
- `SunArc.tsx:116-121,248,251,264,276` aria sentences, `🌅 {t}`, `{t} 🌇`, `{emoji} {phase} · {n}% lit`, `Tonight: {phase} ({n}% lit)`.
- `SunPanel.tsx:15,40-42` hint text `{n}° high`, label plus `({hint})`.
- `WindCompass.tsx:104` `from {dir} · blowing {dir}`.
- `WaveHeightCard.tsx:139,151-152` `{state.label} · estimated`; `{n} ft wave height · waves {s}s apart`.
- `WaterTrendCard.tsx:24-29` three templates with `{n}°F in 2 days`.
- `SandTempPanel.tsx:158,181` `~{n}°F`.

Score and forecast
- `ScoreWheel.tsx:279` `capped from {n}`; `:338-340` aria `{label}: {n} out of 100, {p}% of the score ({display})`; `:425-429` `adding {a} of {b} possible pts`, `costing {n} pts`; `:440-442` `Note: … ({caps.join("; ")}) — the score is held at {n} regardless of these points.`
- `DayOutlookStrip.tsx:84-99` aria label joined from ten clauses with `", "`; `:114-117` `{dow} {m/d} — anticipated score {n} ({rating})`; `:121` `Best window: {t}–{t}`.
- `HistoryCharts.tsx:147,257,279` tooltips `{Level} avg (~{n}) · {n} reads`, `{Level} avg (worst {Level}) · …`.
- `BusynessCard.tsx:111,122,156-157` `{day}: {Level}`, `Peaked {Level} around {hour}`, `{n} of {N} umbrellas · ~{n} people`.

Plus
- `BeachModeCard.tsx:1170-1171` `Measured from {beach} itself — no fresh position from this phone.`; `:1181` `Safety alerts on for {beach} until {t}`; `:1185` `Watching {beach} until {t}`; `:1228-1231` three-way text by state.
- `PlusOnboarding.tsx:251-255` `That is {n} {point|points} {above|below} the everyone score — …`.
- `PlusSettingsSheet.tsx:227` `Your score right now: {n}`; `:357` `Reset to {chip | the defaults}`; `:387` option `{name} — {region}`; `:739` `we'd wake you about {t} for a {t} sunrise` inside `:806` `For example, {…}.`
- `HistorySection.tsx:54-63` stats joined by `" · "` (`high N°`, `water N°`, `sand up to N°`, `surf to X ft`, `crowds peak N%`, `seaweed up to N%`); `:67-71` aria joined by `", "`; `:478` `Last {n} days`; `:573` `Records since {date}`; recordTiles subs `:261,270,286,299` (`{date}, {hour}`).
- `Paywall.tsx:315` `{price}/{PER[plan]}` (unit word from lib); `:327-329` intro; `:485-494` `Alerts need the app. {link}.`
- `ShareCardSheet.tsx:74-75` `{beach} — Is It Beach Day?` and `Today's conditions at {beach} — Is It Beach Day?` (go to the OS share sheet); `:152` `Use the {format} format`; `:173` `{beach} conditions card — {format} preview`.
- `BeachFinder.tsx:103` `📍 {Locating…|Nearest to you|Use my location}`; `:150-154` `No beach matches “{q}” yet.` + link + mailto subject `Add a beach: {q}`.
- `app/find/page.tsx:41-42` `{n} beaches across the US…`.
- `app/support/page.tsx:82-86,111-115` and `app/privacy/page.tsx:125,214` sentences split around `<Link>`/`<a>`.

### 2.2 English plural and list logic

Spanish needs `one/other` plural selection (and a separate form for some nouns). Items with real English plural code:

| Where | Code |
|---|---|
| `components/HistoryCharts.tsx:238` | `${n} read${n === 1 ? "" : "s"}` |
| `components/SafetyBanner.tsx:373` | `beachHazards.length > 1 ? "Statements" : "Statement"` |
| `components/SkyEventsCard.tsx:353-354` | `days === 1 ? "day" : "days"`, `hours === 1 ? "hour" : "hours"` |
| `components/plus/PlusOnboarding.tsx:253-254` | `=== 1 ? "point" : "points"` and `above`/`below` |
| `components/DataCoverageNote.tsx:40-44` | list join: one, two (`a and b`), three or more (`a, b, and c`). Spanish uses `y` and no Oxford comma. |

Count-bearing strings with no plural code at all (wrong at n = 1 or fine only by luck): `app/find/page.tsx:41` (`{n} beaches`), `BusynessCard.tsx:156-157` (`{filled} of {N} umbrellas`), `ChangelogSection.tsx:92` (`Show all ({n})`), `LightningCard.tsx:31,38` and `LightningRadar.tsx:101,268` (`last {n} min`), `UvCard.tsx:120` (`~{n} min to burn`), `HistorySection.tsx:478` (`Last {n} days`, n is 7, 14 or 30).

Gender and agreement risks: `WaveHeightCard.tsx:139` (`{label} · estimated`), `HistorySection.tsx:166,200` (`partial`, `partial day`), `PlusOnboarding.tsx:247` (`Tuned for {profileLabel}`, label is a lower-case activity noun from lib), `FlipCard.tsx:99-103`, `StormActivityMeter.tsx:64-67` (adjectives `Calm / Unsettled / Stormy / Severe`).

Spanish punctuation: 14 visible strings end in a question mark and need an opening `¿`: `Have a code?`, `Heading to the beach?`, `Do crowds bother you?`, `How do you like the weather?`, `What do you go to the beach for?`, `Want the beach closest to you?`, `Spot something off or have an idea?`, `Show a Beach Session on your Lock Screen while Beach Mode is on?`, `Don't see your beach?` (`app/find/page.tsx:48`), and the five support FAQ questions (`Why does a metric say “unknown”?`, `How fresh is the data?`, `Which beaches are covered?`, `How do notifications work?`, `How is the score computed?`). `ScoreExplainer.tsx:87` ends in `enjoy!` (needs `¡`).

### 2.3 Text baked into SVG, canvas or generated images

No `<canvas>`, no portals. Text in SVG `<text>` (the DOM text is real, but position and fit are tuned for English):

| File:lines | Text | Notes |
|---|---|---|
| `ScoreWheel.tsx:349-367` | 11 factor labels (`Air`, `Sky`, `Wind`, `Water`, `Waves`, `Humidity`, `Sand`, `Seaweed`, `Crowds`, `UV`, `Clarity`) | `planLabel` (`:109-131`) measures `text.length * 6.5px` and falls back to abbreviations (`Humid`, `Seaweed`, `Busy`, `:51-58`). Needs an abbreviation table per locale. Unit-tested. |
| `ScoreWheel.tsx:378-391` | score, rating word, `capped from {n}` | e2e finds `svg text` equal to the rating word. |
| `RipRiskCard.tsx:176-197` | `now`, 4 time ticks | fixed `fontSize=8`. |
| `SandTempPanel.tsx:252-261,279-288` | `{n}°`, time ticks | |
| `SunArc.tsx:167-172` | `golden hour` twice | `fontSize=7.5` in a 320 px viewBox. |
| `SunArc.tsx:190,247-252,259-265` | `peak {t}`, `🌅 {t}`, `{t} 🌇`, status label, moon phase line | status label sits centred between the two time labels. |
| `TideCrossSection.tsx:382-398` | `high`, `low` | right-aligned at the box edge. |
| `TideCrossSection.tsx:418-436` | `normal high`, `normal low` | left-aligned at x = 8; can meet the next label. |
| `TideCrossSection.tsx:458-472` | `High 3:42 PM` / `Low …` | `fontSize=11`, svg uses `preserveAspectRatio="none"`. |
| `TideCurve.tsx:128-136,161-170` | times, `now` | |
| `LevelBarChart.tsx:53-61,94-115` | axis words, hour and date labels | |
| `LightningRadar.tsx:171-189,198-200,223-237,251` | ring miles, `N`, band counts, ⚡ | |
| `WindCompass.tsx:63-66,94` | `N`, `E`, `S`, `W`, `?` | Spanish west is `O`. |

Generated images (server-rendered PNG):
- `app/api/share/[slug]/route.tsx` (satori `ImageResponse`, `:522`). Text comes from `lib/shareCard.ts` (`verdict` `:395`, `beachName` `:409`, `metaLine` `:422` = region · date · time, `capNote` `:440`, tile label/value `:267,:270`), plus `/100` (`:236`) and the wordmark (`:470`). The response is edge-cached by full URL (`:507-533`, `s-maxage=900`). Locale must be a query or path part, or two locales will share one cache entry. The warm-up fetch at `ConditionsDashboard.tsx:336` must send the same locale. Check that the default satori font covers `á é í ó ú ñ ¿ ¡`.
- `app/opengraph-image.tsx:65-88` and `twitter-image.tsx`: `isitbeachday.com`, `Is it beach day?`, `Live beach conditions, scored. 🌊`, plus the `alt` export (`:7`). One image serves every page's OG tags (`app/layout.tsx:30-45`, `app/find/page.tsx:21`, `app/[slug]/page.tsx:39`, support, privacy).
- `public/app-store-badge.svg`: English badge art (`Download on the App Store`). Used at `AppStoreBand.tsx:85-91` and `app/support/page.tsx:132`. Apple publishes a Spanish badge.
- Out of scope but linked: iOS `Info.plist` strings, push and Live Activity text built on the server.

### 2.4 Layout-sensitive text (390 px phone, Spanish about 20-30 percent longer)

Width model at 390 px: page content is 358 px (`px-4`). A two-column reading tile is about 173 px wide, 141 px of text after `p-4`. A day-outlook cell is about 48 px. A history day cell is 64 px (`w-16`, `HistorySection.tsx:133`). Elements with `truncate` do not fail the layout e2e (it skips `.truncate`, `e2e/layout.spec.ts:148`), so those clip silently. `line-clamp` and fixed boxes do fail it.

| Risk | Where | Why |
|---|---|---|
| High | `SandTempPanel.tsx:196-207` | four `whitespace-nowrap` labels at fixed 14 / 43 / 68 / 89.5 percent, 10 px. The code comment at `:194` says English already collided at 375 px (`barefoot · <95°`, `warm · 95°`, `sandals · 115°`, `burn · 130°+`). |
| High | `AppStoreBand.tsx:71` | `line-clamp-2` on phone. English is 1.7 lines; the Spanish sentence is about 2.1 lines. The e2e clip check would fail. |
| High | `MetricCard.tsx:25`, `ClarityScene.tsx:178`, `ConditionsDashboard.tsx:964` | tile label is `truncate` in about 141 px (about 20 characters at `text-sm`). `Temperatura del agua`, `Temperatura del aire`, `Probabilidad de lluvia` hit the limit. Silent ellipsis. |
| High | `MetricCard.tsx:39-41`, `ConditionsDashboard.tsx:970` | tile sub-line is `line-clamp-3`. Long subs such as the seaweed line (`:1046-1048`) grow past 3 lines. MetricCard already has a `subShort` option for phones; most tiles do not use it. |
| High | `TideCrossSection.tsx:382-472` | SVG labels in a stretched box; `Pleamar 3:42 p. m.` next to `alta normal` at x = 8. |
| High | `SafetyBanner.tsx:291` | `truncate` headline, `Double red flag — water access closed` is 37 characters, the Spanish is about 43. The lower line (`:295-299`) is `flex-nowrap overflow-hidden` with truncating text plus flags. |
| Medium | `HistorySection.tsx:139-168` | day cell: weekday 9 px uppercase truncate, `best 3 PM` at 8 px truncate, `partial` at 7 px. `mejor 3 p. m.` is about 50 percent longer. |
| Medium | `HeaderSubtitle.tsx:38` | `truncate` line: `5.2 mi away · Auto-resolved — some local data pending` is about 52 characters at 12 px against 358 px. |
| Medium | `SunArc.tsx:259-265` | status label centred between two time labels in a 320-unit viewBox. |
| Medium | `FeelsLikeCard.tsx:108` | `line-clamp-3 sm:line-clamp-2` for the drivers line (text from lib). The clip check catches it. |
| Medium | `ScoreWheel.tsx:63-130` | label-fit algorithm assumes 6.5 px per character. |
| Medium | `FirstRunBanner.tsx:109-123` | the code comment says the button label is "nearly a phone-width wide". `Buscar la playa más cercana` is longer. |
| Medium | `PullToRefresh.tsx:427-435` | `✓ Actualizado · datos de las 3:42 p. m.` is about 40 characters in a pill with no max width. |
| Medium | `DayOutlookStrip.tsx:140` | detail rows `truncate` the factor label plus display text next to a score pill. |
| Low | `DayOutlookStrip.tsx:215-219` | 3-letter weekdays at 9 px in 48 px cells. Spanish short weekdays are also 3 letters. `m/d` becomes `d/m`, same width. |
| Low | `ScoreToggle.tsx:25-58` | two non-wrapping 40 px pills plus gear. `Tu puntuación` + `Todos` still fits (about 270 px). |
| Low | `UvCard.tsx:112-122`, `WaveHeightCard.tsx:139` | text wraps (no clamp) next to a 56 px ring or inside a half tile. Cards grow taller. |
| Low | `StormActivityMeter.tsx:63-67` | four 10 px labels in a full-width row (326 px). Fits. |

Not at risk: all `SkyEventsCard` text (`break-words`), the Plus sheets (chips use `flex-wrap`, buttons are full width), icon-only header buttons (`NotifyButton`, `ShareCardSheet`, `ThemeToggle`, their words live in `aria-label` and `title`).

### 2.5 Strings used as display text AND as a key, comparator, id or test selector

Code that compares or keys on display text:

| Where | Problem |
|---|---|
| `ThemeToggle.tsx:63-65,92` | `switchTo` is `"Light"` or `"Dark"`: compared with `===`, lower-cased into the aria label, shown in `{switchTo} mode`. |
| `StormActivityMeter.tsx:10-15,51,64-67` | `StormActivityBand` is the English word (`Calm`…`Severe`). It is the CSS lookup key and the shown label. |
| `HistoryCharts.tsx:157-158,203-204` and `:147,193,257,279` | axis words `empty / packed / none / high` equal the level enum; `b.level in BUSY_RANK`; `${b.level}` shown raw. |
| `BusynessCard.tsx:7,111,122,148`; `ConditionsDashboard.tsx:509,930,1041,1063`; `HistoryCharts.tsx:46` | `cap(level)` shows an enum value as text. Six display sites, three copies of `cap()`. |
| `SkyEventsCard.tsx:387` and `:123-124` | rating label (`Poor/Fair/Good/Great/Amazing`) is used to look up a colour (`SUN_QUALITY_BANDS.find(b => b.label === label)`) and is also shown. |
| `ScoreCapBanner.tsx:7-10` | regex `/flag|advisory|lightning|thunder|rip current|severe|surf|coastal[- ]flood|closed|no-swim/i` classifies English cap text from lib. A translated cap string would lose the red "safety" tone. |
| `SafetyBanner.tsx:98,99,177` | `/beach hazard/i.test(a.event)`; NWS event names come from api.weather.gov in English. |
| `SunQualityCard.tsx:167` | `b.horizonPath.startsWith("~")` parses a lib string. |
| `LifeguardFlag.tsx:49,70` | aria uses the enum: `flag.replace("-", " ")` gives `double red flag`. |
| `SunQualityCard.tsx:390` | regex `(\d+h) (\d+m)` on a lib-built duration. |

React keys built from display text (change when text is translated; harmless for correctness but cause remounts when locale flips): `Paywall.tsx:333` (`b.title`), `PlusInAppCard.tsx:43` (`line`), `SunPanel.tsx:36` (`r.label`), `SunQualityCard.tsx:299` (`t.text`), `TideCrossSection.tsx:370,407` (`g.label`, `b.label`), `LevelBarChart.tsx:54` (`cap + i`), `DayOutlookStrip.tsx:129` and `HistorySection.tsx:225` (`c`, cap text), `PlusSettingsSheet.tsx:401` (`group.title`), `SafetyBanner.tsx:183,378,397,428` (ids and keys from `a.event`).

Same text passed twice: the dashboard gives each card the same string for `FlipCard label` and `MetricCard label` (`ConditionsDashboard.tsx:804/810, 832/838, 921/926, 943/948, 983/988, 995/1000, 1007/1012, 1028/1030, 1057/1062`). One message key per card avoids drift.

Playwright specs that select English UI text (`e2e/layout.spec.ts`, `e2e/plus.spec.ts`):

| Spec line | Selector | Component line |
|---|---|---|
| layout:65 | heading `Find your beach` | `app/find/page.tsx:38` |
| layout:46,72; plus:75,182 | regex `/build\s+\d+/` is the page-ready signal | `ConditionsDashboard.tsx:1268` (the word "build" in the footer) |
| layout:59,73; plus:23,77 | `svg text` matching `/^(Excellent\|Good\|Decent\|Marginal\|Poor\|Unavailable)$/` | `ScoreWheel.tsx:378-391`, words from `lib/scoreBands.ts` |
| layout:203-210 | tap-target allow list: `↻ Refresh(ing…)`, `Show (all\|less)`, `Support`, `Privacy`, `iPhone app`, `hello@isitbeachday.com`, `Tell us where to add next`, `Clear` | `ConditionsDashboard.tsx:1288-1291,1248-1263,1243`; `ChangelogSection.tsx:92`; `app/find/page.tsx:53`; `BeachFinder.tsx:125` |
| layout:216 | aria allow list `^(Show\|Hide) the science behind` | `AdvisoryStrip.tsx:73-75` (dead) |
| layout:299 | benign hydration warning pattern with `aria-label="Search beaches"` | `BeachFinder.tsx:94` |
| plus:136 | region `Personalize your score in the app` | `PlusInAppCard.tsx:33` |
| plus:138 | link `Get Is It Beach Day for iPhone` | `PlusInAppCard.tsx:62` |
| plus:142,262 | text `$2.99/mo · $19.99/yr · 3-day free trial`; `$2.99/mo · $19.99/yr` | `PlusInAppCard.tsx:53` |
| plus:143,220,270,279,294 | button `Personalize my score` | `PersonalizeCard.tsx:42` |
| plus:145,309 | group `Which score to show` | `ScoreToggle.tsx:28` |
| plus:146,269,287,311 | button `Your score` | `ScoreToggle.tsx:37`, `PersonalizeCard.tsx:67` |
| plus:149 | heading `Explore the details` | `ConditionsDashboard.tsx:793` |
| plus:151 | text `/^(Swim safety\|Surf conditions):/` | `plus/SafetyLine.tsx:43,49,67` |
| plus:175-179 | region `Nearest beach`; buttons `Find my nearest beach`, `Dismiss` | `FirstRunBanner.tsx:139,122,149` |
| plus:201,205,212 | buttons `Get alerts where you stand`, `/🔔 Alerts/` (emoji in the accessible name) | `BeachModeCard.tsx:1133`; `NotifyButton.tsx:262` |
| plus:209,224,289 | text `What do you go to the beach for?` | `PlusOnboarding.tsx:144` |
| plus:227,282 | button `See my score` | `PlusOnboarding.tsx:184` |
| plus:230,235,296 | button `Snorkeling`; plus:281 `Swimming` | `lib/profile/presets.ts` (`profileChip`) |
| plus:231,239 | button `Hot`; plus:240 `Just right`; plus:232 `Not really` | `PlusOnboarding.tsx:14-23` |
| plus:253-255 | `Your score today`, `/Everyone's score today is/`, `/Tuned for snorkeling/` | `PlusOnboarding.tsx:238,244,247` |
| plus:258,298 | button `Keep my score` | `PlusOnboarding.tsx:259` |
| plus:261,288 | text `/Billing isn't available in this build/` | `Paywall.tsx:385` |
| plus:263 | button `Start 3-day free trial` | `Paywall.tsx:395` |
| plus:264,303 | button `Have a code?` | `Paywall.tsx:434`, `PlusSettingsSheet.tsx:465` |
| plus:305 | button `Unlock Plus` | `Paywall.tsx:428` |
| plus:319-320 | button `Everyone's` | `ScoreToggle.tsx:45` |
| plus:326 | button `Beach Day Plus settings` | `ScoreToggle.tsx:51` |
| plus:328-329 | text `What you come here for`; label `Home beach` | `PlusSettingsSheet.tsx:243,371` |
| plus:331-333 | buttons `Save alerts`, `Saved` | `PlusSettingsSheet.tsx:645,640` |
| plus:357 | button `Share` (aria-label) | `ShareCardSheet.tsx:106` |
| plus:361 | dialog named `Share today's conditions` | `ShareCardSheet.tsx:127` |
| plus:378 | text `Tap to preview` | `ShareCardSheet.tsx:183` |
| plus:385-386 | buttons `/Use the Square/`, `/Use the Story/` | `ShareCardSheet.tsx:152` + labels `:14-15` |

`playwright.config.ts` has one project (`chromium`, `:34`). The layout spec (clip, tap-target, horizontal scroll at 390, 768, 1280 on `/`, `/find`, `/deerfield-beach`) is the best automatic overflow gate for Spanish, but it needs a second project that forces the Spanish locale, and its selectors need locale-neutral hooks (`data-testid` or ARIA ids).

Unit tests that assert English text returned by exported component helpers (they must pass `locale` or `t` after the change):

| Test | Asserts | Helper |
|---|---|---|
| `components/PullToRefresh.test.ts:81,87-88` | `✓ Updated · data as of …`, `Couldn't refresh — showing the last data` | `pillText` |
| `components/ScoreWheel.test.ts:33,39` | `Humid`, `Seaweed` | `planLabel` |
| `components/SkyEventsCard.test.ts:148-207` | titles, `Repeats through`, `visible here`, `Moonrise at`, … | `describeRow`, `countdownLabel`, `launchTimeLine`, `meteorTimingLine` |
| `components/SunQualityCard.test.ts:7-17` | `Upcoming sunrise color`, `Sunset color now`, band labels | `cardTitle`, `SUN_QUALITY_BANDS` |
| `components/TidePanel.test.ts:17,28,37` | `Observed: 0.8 ft — 0.5 ft above predicted (Lake Worth Pier gauge)`, `right on prediction` | `observedChip` |
| `components/plus/HistorySection.test.ts:103-112` | `Quietest time`, `Mon Sept 28, 3 PM`, `since Sept 20` | `recordTiles` |
| `components/plus/BeachModeCard.test.ts` | logic only (no copy assertions found) | `lockScreenRowState` returns English `message` (`:233-249`) |

### 2.6 Emoji and symbols inside strings

- Emoji inside a string that is read or matched: `NotifyButton.tsx:259-262` (`🔔 Alerts — enabling…`, `🔔 Alerts — try again`, `🔔 Alerts`, used as aria-label and title; e2e matches `/🔔 Alerts/`), `ConditionsDashboard.tsx:1046` (`📷 …` inside the seaweed sub-line), `CamGrid.tsx:26-28,97,108` (`📷 {time}`, `📷 Snapshot`), `PullToRefresh.tsx:80-82` (`✓ Updated`), `DayOutlookStrip.tsx:129,244` (`⚠️ {cap}`, `💧{n}%`), `SafetyBanner.tsx:429` (`⚠ {event}`), `SunArc.tsx:248,251,264` (🌅, 🌇 and moon emoji inside SVG text), `ConditionsDashboard.tsx:1288-1291` (`↻ Refresh`).
- Emoji as separate `aria-hidden` spans (safe, no change): most card headers, `BeachModeCard.tsx:1129,1154,1177,1297`, `FirstRunBanner.tsx:143`, `SafetyBanner` icons.
- Arrows and marks in link text: `LocalCoverage.tsx:52` (`↗`), `BeachFinder.tsx:157` (`Request it →`), `not-found.tsx:11` and `privacy/support` back links (`←`).
- Typographic characters inside copy: em dash in about 60 strings, en dash in time ranges (`ConditionsDashboard.tsx:763`), `≈` (`TidePanel.tsx:80-99`), U+2212 minus (`FeelsLikeCard.tsx:152,155`), `×` in `Story (1080×1920)` (`ShareCardSheet.tsx:14-15`), curly quotes (`BeachFinder.tsx:150`), NBSP (`SunQualityCard.tsx:390`, `MetricCard.tsx:48`), `…` after `Refreshing`, `Checking`, `Locating`.
- Separator `" · "` joined in code: `HistorySection.tsx:62`, `FeelsLikeCard.tsx:109`, `ScoreCapBanner.tsx:58`, `HeaderSubtitle.tsx:40`, `SafetyBanner.tsx:248,362`, `CamGrid.tsx:26`.

### 2.7 Dates, times, numbers, units and compass directions formatted inline

The central helpers hard-code `en-US`: `lib/format.ts:5-6` (`fmtTime`), `:18-19` (`fmtTimeCompact`), `:33-34` (`fmtDate`). Every component using them is fixed by one change there, but several components then edit the result as English text (next table).

Components that bypass `lib/format.ts`:

| Where | What |
|---|---|
| `BusynessCard.tsx:10-13` | manual `{h} AM/PM` |
| `HistoryCharts.tsx:45` | manual `{h}a` / `{h}p` |
| `plus/HistorySection.tsx:39-48` | manual `{h} AM/PM` and `{h}a` / `{h}p` (third copy of the same logic) |
| `DayOutlookStrip.tsx:76-82`; `HistoryCharts.tsx:77` | `m/d` order (Spanish is `d/m`) |
| `HistoryCharts.tsx:52,60,74,80-85`; `ConditionsDashboard.tsx:405,501`; `RipRiskCard.tsx:33,212`; `SkyEventsCard.tsx:249,294-304,364`; `plus/PlusSettingsSheet.tsx:729` | `Intl.DateTimeFormat("en-US" or "en-CA", …)`; the `en-CA` ones only produce `YYYY-MM-DD`, keep them |
| `PullToRefresh.tsx:81` | `toLocaleTimeString(undefined, …)`, the only call that follows the device locale (not the app locale) |
| `ChangelogSection.tsx:20-40` | own `MONTHS` array and `Mon D, YYYY` |
| `app/privacy/page.tsx:7` | `EFFECTIVE_DATE = "September 28, 2026"` string |
| `PlusSettingsSheet.tsx:713-717` | lead-time labels `30 min`, `1 h`, `2 h`, `3 h` |

String surgery on formatted times (breaks silently when the format changes; Spanish uses `p. m.` with a space inside):
- `SkyEventsCard.tsx:378-384` and `SunQualityCard.tsx:186-192` (`fmtRange` copies): `a.split(" ")` and compare the meridiem part.
- `SandTempPanel.tsx:287` `.replace(":00 ", "")`; `TideCurve.tsx:135` `.replace(" ", "")`; `RipRiskCard.tsx:211` `.replace(/:00(?=\s)/, "")`; `SunQualityCard.tsx:390` regex on `1h 20m`.

Relative-time and duration wording built in components: `LightningCard.tsx:5-10` and `LightningRadar.tsx:41-46` (duplicate `ageLabel`: `just now`, `{n} min ago`, `{n}h ago`), `SafetyBanner.tsx:362` (`· {n} min ago`), `SunQualityCard.tsx:179-181` (`{n} min after/before`), `SkyEventsCard.tsx:353-357` (`{h}h {m}m`), `WaveHeightCard.tsx:152` (`{n}s apart`), `UvCard.tsx:120` (`~{n} min to burn`). The generic `fmtRelative` is in `lib/format.ts:46`.

Units. The app covers US beaches, so `°F`, `mph`, `ft`, `mi` should stay in Spanish (US Spanish also uses them). Only the unit word placement and the spacing change. Inline unit text is spread over 20 files (hot spots: `FeelsLikeCard.tsx` 13 lines, `TidePanel.tsx` 7, `LightningCard.tsx` 7, `SandTempPanel.tsx` 5, `SunQualityCard.tsx` 5, `WaveHeightCard.tsx` 4). `.toFixed(1)` is used in about 20 places; es-US keeps the `.` decimal.

Compass: `degToCardinal` (`lib/util.ts:21-24`, 16 points) is called at `LightningCard.tsx:34`, `LightningRadar.tsx:103,270`, `SafetyBanner.tsx:361`, `WindCompass.tsx:104`. The compass rose letters in `WindCompass.tsx:63-66` are literal. Spanish west is `O` (`ONO`, `OSO`, `NO`, `SO`).

Weekday names: `DayOutlookStrip` shows `dow` supplied by `lib/score` (`DayWindow.dow`) and `ForecastDay.dow`; `HistorySection` shows `weekday`, `weekdayLongOf`, `shortMonthDay` from `lib/history/summary`. Components also call `Intl` for weekdays (see table).

## 3. How components get data and props

Page owner and flow. `app/page.tsx` and `app/[slug]/page.tsx` are server components. Each calls `getConditions(slug)`, strips server-only fields and renders `components/ConditionsDashboard.tsx` (client) with `slug`, `initial`, `browseHref`, `isNativeApp`, `beaches`. The dashboard then runs `useSWR('/api/conditions/{slug}', fallbackData = initial)` (`:159-170`, refresh every 300 s), computes `d = deriveMetrics(snap, nowMs)` and passes `tz`, `nowMs`, `d`, `snap` slices and `plus` down as props. `usePlus()` (`:324`) is called once and passed as the `plus` prop. All the Plus sheets (`PlusOnboarding`, `Paywall`, `PlusSettingsSheet`) are children of the dashboard (`:1318-1343`).

Tree depth. Shallow: 3 to 4 levels.
- Dashboard → card (`FlipCard` → `MetricCard`, `NerdBack`): depth 2 to 3.
- Dashboard → `PlusSettingsSheet` → `Sheet` / `SunColorSettings` / `Chip`: depth 3 to 4 (deepest).
- Dashboard → `SafetyBanner` → `LifeguardFlag`; → `SkyEventsCard` → `SkyEventRow`; → `WindCompass` → `WindSpinner`: depth 2 to 3.
- About 40 direct children of the dashboard.

Context. None in the repo. State sharing today: SWR cache, module-level stores and hooks in `lib/plus/client`, `lib/location/device` (`useDeviceFix`), `localStorage` (theme, dismissals, home beach). No `createPortal`.

Server and client. 42 client files, 10 server entries, 27 no-directive files in the client tree (list in section 1). Server pages that carry text and cannot use hooks: `app/layout.tsx` (metadata and `lang`), `app/find/page.tsx`, `app/support/page.tsx`, `app/privacy/page.tsx`, `app/not-found.tsx`, the data-outage fallback in `app/page.tsx:78-90`, the two image routes. They need a server-side `getT(locale)`, not a hook. `app/find/page.tsx:8` is ISR (`revalidate = 300`); reading cookies or headers there makes it dynamic. `app/page.tsx` and `app/[slug]/page.tsx` are already dynamic (`force-dynamic`, user-agent sniff in `lib/nativeRequest.ts:34`).

Cheapest way to give every component a `locale`:
1. One client `LocaleProvider` (React context) rendered in `app/layout.tsx` around `{children}`, with `locale` resolved on the server. Add `useLocale()` / `useT()`. This needs no signature change in about 55 components. The extra cost is one provider file and one hook.
2. Prop drilling is worse. The dashboard passes props to about 40 children, and `FlipCard`/`NerdBack`, `Sheet`, `Chip`, `LevelBarChart` sit 2 to 4 levels down. That is about 60 signature edits plus every unit test.
3. Context cannot reach the exported pure helpers (`pillText`, `describeRow`, `countdownLabel`, `launchTimeLine`, `meteorTimingLine`, `observedChip`, `recordTiles`, `planLabel`, `cardTitle`, `lockScreenRowState`, `weekdayDate`, `weekdayDateTime`). Those 12 take an explicit `t` or `locale` argument. The component calls them with the value from the hook. Their tests pass `"en"` and a Spanish case.
4. Hydration rule. `ConditionsDashboard.tsx:271-282` documents a past React #418 error from time-dependent first render. The locale must be known on the server and passed into the provider. Do not read `navigator.language` during the first render.
5. Locale source. A URL segment is awkward: `app/[slug]` would clash with a `[locale]` segment (`/es` could be a slug), and 18 hard-coded internal links and redirects would need a prefix (`app/page.tsx:84`, `ConditionsDashboard.tsx:548,1247,1251`, `BeachFinder.tsx:15`, `NearYouChip.tsx:37`, `FirstRunBanner.tsx:85`, `HomeBeachRedirect.tsx:52`, `Paywall.tsx:21`, `app/[slug]/page.tsx:60`, the support, privacy, find, not-found links). A cookie plus `Accept-Language` needs no routing change, works in the Capacitor web view (the app loads `https://app.isitbeachday.com`, `capacitor.config.ts`) and is the cheaper start. It gives Spanish no separate indexable URL.

Rendered outside the main tree:
- `app/layout.tsx:104-107` mounts `ServiceWorkerRegister`, `NativePushInit`, `ReloadOnNewVersion`, `AppOpenPing`. All four render null and hold no text. They need no locale.
- `app/global-error.tsx` replaces the layout and renders its own `<html lang="en">` (`:25`). A layout-level provider does not wrap it. It needs its own locale source (cookie read in an inline script, or a fixed bilingual message).
- `app/error.tsx` and `app/not-found.tsx` render inside the layout, so a provider in the layout reaches them.
- Sheets (`plus/Sheet.tsx:82`) are inline `fixed inset-0` elements, not portals. A provider above the dashboard reaches them. `PullToRefresh.tsx` comment (`:437-439`) keeps `transform: none` at rest so these fixed sheets do not break.
- `public/sw.js`: a kill-switch worker that unregisters itself. It holds no user-visible text.
- `mobile/www/index.html`: Capacitor offline fallback, static HTML with `<html lang="en">` and 3 strings (`Is it beach day?`, `Can’t reach the ocean right now — check your connection.`, `Try again`). It loads from the app bundle with no server, so it needs an inline script on `navigator.language` or two text variants.
- Native shell: `Info.plist` strings, push payload text (server routes under `app/api/push`) and Live Activity content states are outside this file's scope.
- The `<html lang>`, the theme script and `viewport` in `app/layout.tsx` are static today. `metadata` must become `generateMetadata`.

Text that arrives pre-built from `lib/` (not counted above). The component only shows it, so the lib work decides the language:

| `lib/` module | Used by | What |
|---|---|---|
| `format.ts` | 15 components | `fmtTime`, `fmtDate`, `fmtRelative`, `nextCamReadPhrase`, `seaState`, `beachDayVerdict`, `AQI_BANDS` labels |
| `score.ts`, `scoreBands.ts` | `ScoreWheel`, `DataCoverageNote`, `DayOutlookStrip`, `ScoreCapBanner`, dashboard | sub-score `label`/`display`, `rating`, `caps[]` |
| `explain.ts` | `ScoreExplainer` | `summary`, helping and hurting lines (333 lines) |
| `nerdInfo.ts` | `FlipCard` backs from the dashboard | 11 explainer, formula and source blocks (843 lines) |
| `ripRisk/copy.ts`, `ripRiskCurve.ts` | `RipRiskCard`, `SafetyBanner` | `ripCopy` lines, banner text |
| `rainNowcast.ts`, `sources/clarity.ts`, `vsAveragePhrase.ts`, `sources/busyness.ts`, `stormActivity.ts` | dashboard, `BusynessCard`, `StormActivityMeter` | chip text, tile copy, `vs average` phrases, band names |
| `seasonalHazards.ts`, `feelsLikeBeach.ts`, `sandTemp.ts`, `goldenHourTiming.ts`, `sunArc.ts`, `sunQuality.ts`, `uv.ts`, `waterTrend.ts` | the matching cards | band labels, drivers, verdicts, headlines and badges |
| `changelog.ts` | `ChangelogSection` | about 120 entries (800 lines) |
| `plus/labels.ts`, `plus/paywallCopy.ts`, `plus/api.ts` (`plusErrorMessage`), `plus/entitlement.ts`, `plus/saveStatus.ts`, `profile/presets.ts`, `safetyLine.ts`, `history/summary.ts`, `hazards/pointVsBeach.ts`, `push/native.ts` | Plus components | alert labels, plan CTA and fine print, error messages, profile chips, swim and surf reasons, weekday and month words, beach-mode hazard line, native push error text |
| `shareCard.ts` | share route | the whole card copy |
| `stateBeachPrograms.ts`, `config/locations` | `BeachFinder`, `LocalCoverage` | state names, program names, beach names and regions (data; keep English proper nouns) |
| external feeds | `SafetyBanner`, `LifeguardReport`, `CamGrid`, `SkyEventsCard` | NWS event names and headlines, city advisory titles, cam names, launch names. English only. |

## 4. Natural work split

Pre-work (one person, before the groups start, about half a day): the provider, `useT` and `getT`, message format, the dictionary files, the `lib/format.ts` locale parameter, one shared `hourLabel` / `cap` / `miles` / `ageLabel` / `fmtRange` in `lib/` (today 3, 3, 3, 2 and 2 copies), `app/layout.tsx` edits, `playwright.config.ts` Spanish project, test-id hooks for e2e. The groups below never edit the same file. Each group also updates the unit tests of its own files.

| Group | Files | Strings | ≈Words | Notes |
|---|---|---:|---:|---|
| G1 Dashboard shell | `ConditionsDashboard`, `FlipCard`, `MetricCard`, `ThemeToggle`, `NotifyButton`, `PullToRefresh`, `AppStoreBand`, `ScoreExplainer`, `ScoreCapBanner`, `DataCoverageNote`, `SourceBadge`, `RelativeTime`, `Logo`, `plus/Sheet`, plus the four null layout components | 118 | 410 | One 62-string file owns the page. Land the `useT` pattern here first. Tests: `PullToRefresh.test`. |
| G2 Safety and hazards | `SafetyBanner`, `RipRiskCard`, `LightningCard`, `LightningRadar`, `LifeguardFlag`, `LifeguardReport`, `SeasonalHazards`, `LocalCoverage`, `CamGrid`, `plus/SafetyLine` | 138 | 1,100 | `RipRiskCard` is half the words. Needs safety wording reviewed by a native speaker. |
| G3 Sun, sky, tide, sand | `SunQualityCard`, `SkyEventsCard`, `SunArc`, `SunPanel`, `TidePanel`, `TideCrossSection`, `TideCurve`, `SandTempPanel` | 138 | 850 | Most SVG text and the AM/PM parsing. Tests: `SkyEventsCard.test`, `SunQualityCard.test`, `TidePanel.test`. |
| G4 Score, forecast, tiles | `ScoreWheel`, `FeelsLikeCard`, `DayOutlookStrip`, `HistoryCharts`, `LevelBarChart`, `BusynessCard`, `StormActivityMeter`, `WaterTrendCard`, `UvCard`, `WaveHeightCard`, `WindCompass`, `WindSpinner`, `AirQualityMeter`, `ClarityScene` | 141 | 1,170 | Plural and enum cases. Test: `ScoreWheel.test`. |
| G5 Plus: onboarding, paywall, settings | `PlusOnboarding`, `Paywall`, `PlusSettingsSheet`, `PersonalizeCard`, `PlusInAppCard`, `ScoreToggle` | 139 | 650 | 8 e2e-selected strings. Billing and App Review wording needs care. Test: `Paywall.test`. |
| G6 Plus: Beach Mode, history, location; finder; share and OG | `BeachModeCard`, `HistorySection`, `FirstRunBanner`, `HeaderSubtitle`, `NearYouChip`, `HomeBeachRedirect`, `BeachFinder`, `ShareCardSheet`, `app/api/share/[slug]/route`, `app/opengraph-image`, `app/twitter-image` | 110 | 560 | Image routes need a locale in the URL or cache key. Tests: `HistorySection.test`, `BeachModeCard.test`, `share route.test`. |
| G7 Pages, chrome and long text | `app/layout` (strings only; edit owned by pre-work), `app/page`, `app/[slug]/page`, `app/find/page`, `app/support/page`, `app/privacy/page`, `app/error`, `app/global-error`, `app/not-found`, `ChangelogSection`, `mobile/www/index.html` | 127 | 1,920 | Words are prose. Split into G7a (privacy and support: translation and legal review, little code) and G7b (the rest) if you want two people. `ChangelogSection` also needs a decision on the 120 lib entries. |

Totals check: 118 + 138 + 138 + 141 + 139 + 110 + 127 = 911 (908 live strings in `.tsx` plus the 3 in `mobile/www/index.html`). `MoonPanel` and `AdvisoryStrip` are dead: delete them or skip them (15 strings).

Order. Pre-work, then G1 (pattern), then G2 to G6 in parallel, G7 any time after pre-work. Lib text (`nerdInfo`, `explain`, `changelog`, `plus/labels`, `shareCard`, …) is a separate crew: G3, G4 and G6 depend on its API for the same cards.

## 5. Totals and the top 5 painful findings

Totals
- Files: 79 in scope (plus 2 admin files skipped), 16,226 lines.
- Distinct strings: about 923 (908 live, 15 in dead code). About 6,700 English words. Add 3 strings in `mobile/www/index.html`.
- Not counted but required: the lib-side text listed in section 3 (more than 3,000 lines of English-bearing source) and about 40 English selectors in `e2e/`.
- Fragment or join sites: about 70. Real plural code: 5 sites. Hard-coded `en-US` / `en-CA`, manual AM/PM and `m/d` sites in components: about 25. Time-string surgery sites: 6. SVG `<text>` sites: 30 in 9 files.

Top 5 painful findings
1. **Sentences are assembled in code.** About 70 sites build a sentence from pieces, plus 5 English plural conditionals, an English list join, and templates that embed a label inside a sentence (`FlipCard.tsx:99-103`, `FeelsLikeCard.tsx:131-157`, `SkyEventsCard.tsx:353-357`, `SafetyBanner.tsx:217-248,360-363`). Use whole-sentence messages with variables and plural rules. A key to plain-string lookup will not do.
2. **Pure string helpers live inside components and tests pin their English output.** 12 exported helpers (`pillText`, `describeRow`, `countdownLabel`, `observedChip`, `recordTiles`, `planLabel`, `cardTitle`, `lockScreenRowState` and others) cannot call a hook. Their 6 test files assert exact English. They need an explicit `t` or `locale` argument and new tests.
3. **Time and date text is hand-made and then edited as a string.** `fmtTime` is hard-coded to `en-US` (`lib/format.ts:5-6`). Three copies of manual AM/PM, `m/d` in 3 places, and 6 sites that split or regex the formatted result (`SkyEventsCard.tsx:378-384`, `SunQualityCard.tsx:186-192,390`, `SandTempPanel.tsx:287`, `TideCurve.tsx:135`, `RipRiskCard.tsx:211`). Switching to `es-US` breaks these quietly (`p. m.` has a space).
4. **Display text doubles as data.** Enum words are shown as text and used as keys (`StormActivityMeter`, `HistoryCharts`, `ThemeToggle`, `SkyEventsCard.tsx:387`, six `cap(level)` sites). Regexes classify English text (`ScoreCapBanner.tsx:7`, `SafetyBanner.tsx:98`). About 13 React keys come from copy. The e2e suite selects about 40 English strings and uses the footer word `build` as its "page is ready" signal (`ConditionsDashboard.tsx:1268`). Split value from label before translating; add locale-neutral test hooks.
5. **Text baked into fixed-size art and tight boxes.** 30 SVG `<text>` sites sized for English (`ScoreWheel` fit algorithm, `SandTempPanel` percent-positioned labels, `TideCrossSection` labels), the share-card PNG cached by URL with no locale in the key, a single OG image for all pages, an English App Store badge, and 6 high-risk 390 px spots (`SandTempPanel.tsx:196-207`, `AppStoreBand.tsx:71`, tile labels, `SafetyBanner.tsx:291`, tile sub-lines, `TideCrossSection`). `truncate` hides overflow from CI.

Also worth knowing: `app/privacy/page.tsx` is a 1,130-word legal text that needs legal review in Spanish; `app/support/page.tsx:92` and `app/privacy/page.tsx:65` name a "Notify me" button that no longer exists (the UI says `🔔 Alerts`), so fix the English before translating; `ChangelogSection` shows about 120 English entries from lib; `MoonPanel` and `AdvisoryStrip` are dead code.
