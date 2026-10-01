# i18n research 03: push, native iOS/Android, App Store listing

Repo: /Users/yitzfrid/Projects/bocabeach. Research only. Nothing in the repo was edited.
All paths below are relative to the repo root. Line numbers are from the tree as read on 2026-09-30.

Bottom line: every push word is chosen on the server, as plain English strings, one device at a time, at a point where the full device record is already in hand. Adding a `locale` column is cheap. The real work is (1) making the copy builders locale-aware, (2) one cache that holds English text, (3) a trap in `listArmed`, and (4) all native Swift strings, which have zero localization infrastructure today. No dedupe key embeds our rendered copy.

---

## 1. Push notification copy

### 1.0 Transports (what exists)

- Native APNs (iOS): `lib/push/apns.ts:138` sends `aps: { alert: { title, body }, sound: "default" }, url`. Plain strings. No `title-loc-key` or `loc-args`, so iOS cannot localize on-device. The server must pick the language.
- Native FCM (Android): `lib/push/fcm.ts:106` sends `notification: { title, body }, data: { url }`. Plain strings. Same conclusion.
- Web push: does NOT exist. No VAPID, `PushManager`, or `showNotification` anywhere. `public/sw.js` is a kill-switch worker that unregisters itself. `components/ServiceWorkerRegister.tsx` only unregisters.
- ONE send chokepoint: `senderFor()` in `app/api/push/run/route.ts:340-368`. APNs send at 345-351, FCM at 359-363. Every push (digest, Excellent, coming-up, sun-color, at-beach hazard) goes through it as a `PushDecision {tag,title,body,url}` (`lib/push/notify.ts:287-292`).
- Live Activity pushes are a separate APNs path (`apns.ts:157+`, `sendLiveActivityUpdate`) and carry NO words. See section 4.
- Single cron entry: `workers/plus-cron/src/index.ts:60` and `.github/workflows/push-cron.yml` both POST `/api/push/run?mode=all`. The cron Worker holds no copy and needs no change.

### 1.1 Copy inventory, by file

Legend: S = static string, I = interpolated.

#### `lib/alerts/catalog.ts` (the at-beach and home alert catalog)

`bodyFor()` is at 241-286. `titleFor()` is at 295-298.

| Alert key | Lines | Kind | Interpolated values |
|---|---|---|---|
| lightning, escalated | 245 | S | none ("within 2 miles", hardcoded) |
| lightning, with distance | 246-247 | I | `miles(mi)` one decimal via `miles()` (236-238); "mi" abbreviation hardcoded |
| lightning, no distance | 248 | S | none ("within 5 miles", hardcoded) |
| thunder | 250 | I | beach name |
| severe | 252 | I | NWS event name (English, from the NWS feed) + beach |
| rain-soon | 254 | I | `Math.max(1, Math.round(etaMinutes))`; "minutes" is NOT pluralized (1 gives "1 minutes") |
| rain-clearing | 256 | S | none |
| wind-gust | 258 | I | beach; "25 mph" is HARDCODED (not read from `GUST_ALERT_MPH`, `lib/alerts/evaluate.ts:40`) |
| flag, double-red | 261 | I | beach |
| flag, red, informational (surfer) | 263-264 | I | beach |
| flag, red, alarm | 265 | I | beach |
| rip, informational | 268-269 | I | `level.toLowerCase()` ("high"/"moderate") + beach |
| rip, alarm | 270 | I | `level` capitalized + beach |
| water-advisory | 273 | I | beach |
| score-excellent | 275 | I | beach + score ("N/100") |
| sun-color body | 278-284 | I | "Sunrise"/"Sunset" (from the English `kind` enum), `eventTimeLabel`, beach, `bandLabel`, `peakLabel`, `leadPhrase`. Three sentences in one template. |
| Titles | 295-298 | I | `⚠️ ${beach}` for alarms, bare `${beach}` otherwise. Sun-color title is `${bandLabel} ${kind} coming` (296). It interpolates the RAW English enum `kind` ("sunset"), so word order and gender will break in Spanish. |
| coming-up, tide | 306-310 | I | `whenLabel`; 3 sentences |
| coming-up, eclipse | 311-317 | I | "Total"/"Partial" label (324 in `comingUp.ts`) + whenLabel + peak time OR visible range; optional " Sky rating: X." suffix. 2 headline variants. |
| coming-up, meteor | 318-321 | I | showerName + whenLabel; optional rating suffix |
| coming-up, supermoon | 322-327 | I | whenLabel + `overWaterLine` + closest-of-year clause. 2x2 variants. |
| coming-up, launch | 328-329 | I | launch name + whenLabel; "Status: Go." hardcoded |

Rough count in `catalog.ts`: about 28 distinct translatable templates or fragments (15 at-beach/home bodies, 2 sun-color, about 11 coming-up).

Embedded English data strings (from other modules, not catalog.ts):
- `ratingLabel`: `SkyRatingLabel = "Poor"|"Fair"|"Good"|"Great"|"Amazing"` (`lib/skyEventsTypes.ts:42`).
- `bandLabel`: `lib/sunQuality.ts:118-124` `SUN_QUALITY_BANDS` labels (same 5 words).
- `overWater.line`: `"over the water"` is a hardcoded English string stored in the snapshot (`lib/sources/moonEvents.ts:370`).
- `showerName`: meteor shower names from sky-events data.
- Launch `name`: Launch Library mission name. Proper noun.
- NWS `event`: free English text. `isSevereAlert()` (`lib/push/notify.ts:58-64`) matches about 10 warning types + "Beach Hazards Statement"; any NWS event with Severe/Extreme severity also passes.

#### `lib/push/notify.ts` (morning digest)

| Item | Lines | Notes |
|---|---|---|
| `PHRASES` pro/con lexicon | 73-86 | 10 sub-score keys x pro/con = 20 fixed fragments ("warm water", "cold water", "calm surf", "rough surf", "quiet", "crowded", "sunny", "cloudy", "warm", "chilly", "light breeze", "windy", "no seaweed", "seaweed", "comfortable", "muggy", "cool sand", "hot sand", "low UV", "strong sun") |
| `conPhrase` | 101-107 | I: `${level} seaweed`. `level` is PARSED out of an English display string ("Moderate · ~12% covered") built at `lib/score.ts:1027-1031`, then `.toLowerCase()`. Coupling to English text. Fallback is `s.label.toLowerCase()` (English sub-score label). |
| `joinPhrases` | 134-141 | English-only join: `", "` and `" & "`, plus capitalizes the first letter. No Oxford comma. |
| digest title | 331 | I: `🏖️ ${verdictPhrase(score)} · ${score}/100`. `verdictPhrase` reads `scoreBand(score).push` |
| digest body lines | 321-328 | I: `☀️ pros`, `☁️ cons`, `🕓 Best time: ${bestWindow}` + optional ` (skip ${skipWindow})`. 3 templates. |
| `scoreBands.ts` push phrases | `lib/scoreBands.ts:33-37` | 5 strings: "Perfect/Great/Decent/Marginal/Rough beach day today". SHARED SOURCE OF TRUTH with the web (`verdict`, `rating` live in the same table), so the web i18n work must expose a push-phrase slot. |
| `PushSummary` | 37-53 | Carries `rating`, `verdict`, `pros[]`, `cons[]`, `bestWindow`, `skipWindow` as ALREADY-RENDERED ENGLISH STRINGS. |

About 30 fragments in `notify.ts` + 5 in `scoreBands.ts`.

#### `lib/alerts/sunColor.ts`

- `sunColorLeadPhrase` (152-164): 4 phrases ("the next half hour", "about two hours", "about three hours", "about an hour"). These are inserted into "X is {phrase} away." (catalog.ts:283), so the Spanish form needs different grammar ("falta aproximadamente una hora"), not just a swap of the noun phrase.
- `sunColorDecision` (187-212) formats times with `fmtTime` (208-209).

#### `lib/alerts/morning.ts`

- No copy of its own. It calls `buildAlert` for score-excellent (89-92). It owns the summary cache (see 2.1).

#### `lib/alerts/comingUp.ts` (formatting helpers, all en-US)

- `fmtWeekdayDate` 271-274: `${weekday} ${fmtDate(...)}` gives "Sun Mar 8". Month-day order is baked in by string concatenation.
- `fmtWeekdayDateTime` 277-279: "Thu Oct 15, 11:42 AM".
- `fmtTimeWeekdayDate` 282-284: "9:15 PM Wed Oct 8".
- `timeAndPeriod` 286-297: `en-US`, `hour12: true`, `.toUpperCase()` on `dayPeriod`.
- `fmtRange` 301-307: "1:10-1:42 AM" / "11:50 PM-12:10 AM". Compares `period` strings to decide whether to collapse AM/PM.
- `buildComingUpSubject` 315-373 pre-formats all of these into the subject, so `catalog.ts` stays "formatting-free". The subject holds finished English strings.
- Hardcoded English labels: `kindLabel: "Total"|"Partial"` (324).

#### Shared formatters (`lib/format.ts`)

- `fmtTime` line 5, `fmtDate` line 33. Both `Intl.DateTimeFormat("en-US", ...)`. Also used by the web UI.
- `fmtWindow` (`notify.ts:146-160`): `en-US`, `hour12: true`, reads `dayPeriod` ("AM"/"PM"), compares periods, joins with an en dash. Used for `bestWindow` and `skipWindow`.

#### No copy elsewhere

- `lib/alerts/rain.ts`: no push copy (just a rain read). `lib/alerts/evaluate.ts`: no copy (builds subjects, calls `buildAlert` at 300). `lib/ripRisk/copy.ts`: web only (`RipRiskCard`, `SafetyBanner`); push wording for rip lives in `catalog.ts`. `lib/sunAlert.ts`: prediction only.
- `app/api/push/run/route.ts`: no wording of its own. It only concatenates bodies with `"\n\n"` (178, 801) when it appends or coalesces a coming-up body.
- A manual test send exists: `POST /api/push/run?force=morning` (route.ts:233). It uses the same digest builder.

#### Timezones and formatting helpers

- Every displayed time is formatted in the BEACH timezone (`loc.timezone` from `config/locations`), never the phone's. `route.ts:149-150` states this rule. `sunColorDecision` takes `tz: loc.timezone` (route.ts:912); `buildComingUpSubject(selection, loc.timezone)` at 684; `summarizeForPush(res, {tz: loc.timezone})` at 584.
- English-specific logic to translate or replace:
  - plural: none handled ("1 minutes" at `catalog.ts:254`; `mi` never pluralizes).
  - fragment joining: `joinPhrases` (", " + " & "), `Sky rating:` suffix append, "{headline} — the closest full moon of the year." clause append, `\n\n` append of coming-up to the digest.
  - hardcoded unit words: "mi", "mph", "miles" (imperial). Fine for US Spanish speakers.
  - AM/PM `dayPeriod` string comparisons (`notify.ts:157`, `comingUp.ts:304`). `es-US` returns "a. m." / "p. m." with a narrow no-break space; the equality logic still works but the `.toUpperCase()` and the `"–"` join would look wrong.

### 1.2 Rough string count (push)

- Templates and fixed fragments: about 28 (catalog) + about 30 (notify) + 5 (scoreBands) + 4 (lead phrases) + about 5 (labels: Total/Partial, Sunrise/Sunset, 5 rating words) = about 70 translatable fragments.
- Data-derived English text that is NOT ours to translate but appears in bodies: NWS event names (about 12 common), meteor shower names (about 8), launch names (open set), "over the water" (1).

---

## 2. How a push is addressed to a device

### 2.1 Flow, cron tick to send

```
workers/plus-cron  (every 5 min, up to 3 passes)  --POST x-cron-secret-->  /api/push/run?mode=all
  app/api/push/run/route.ts POST (215)
  1. import legacy KV subs into D1        route.ts:243-249  (listNativeSubs -> store.importLegacy)
  2. housekeeping prunes                   route.ts:255-276
  3. store.listPushable()                  route.ts:278     (every device with push_token + ios/android, ANY plan)
  4. HOME LOOP (mode != safety), route.ts:546-1006
       per beach:  countedGetConditions(slug)   once per beach
       per device in group (615):
         `if (!entitled(sub.device, nowMs)) continue;`   route.ts:619   <- free devices stop HERE
         personalSummary(res, place, sub.device, nowMs, summaries)   route.ts:626   (memoized)
         coming-up:  buildComingUpSubject + buildAlert           route.ts:684-685  (per device)
         digest:     deliverMorning -> decideNotifications       route.ts:728, 152-158 (per device)
         Excellent:  excellentDecision -> buildAlert             route.ts:792 (morning.ts:89)
         sun-color:  sunColorDecision -> buildAlert              route.ts:908-914
         every send: senderFor(sub)(msg) -> APNs/FCM             route.ts:340-368
  5. AT-BEACH ENGINE (mode != morning), route.ts:1017 -> runAtBeachAlerts (lib/alerts/run.ts:252)
       store.listArmed(now)                 run.ts:290   (plus + armed presence only)
       store.listPushable()                 run.ts:475-476
       per armed device (583):  evaluateAtBeach(...)   run.ts:633-642  -> buildAlert per subject
       splitByDedup -> claimSend -> deps.deliver(sub, {title, body...})   run.ts:649-697
       deliver = senderFor(sub)(msg)        route.ts:1022-1026
```

### 2.2 Answers

**(a) Built per device or once per beach?**

Per device, in every path. Each builder runs inside a per-device loop, with the `DeviceRecord` (`sub.device` or `device.device`) in hand:
- At-beach: `buildAlert` is called per device per run (`evaluate.ts:300`, called from `run.ts:633`). Only conditions, rain and the lightning feed are shared across devices.
- Digest: `decideNotifications` (route.ts:152) per device. BUT the text it renders from comes from a shared artifact: `PushSummary` from `personalSummary()` (`lib/alerts/morning.ts:44-60`), memoized in `SummaryCache` (route.ts:547) under key `` `${slug}|${personal ? JSON.stringify(profile) : "everyone"}` `` (morning.ts:53). That summary holds `pros`, `cons`, `bestWindow`, `skipWindow`, `rating` as ENGLISH TEXT. This is the one place where text is built once per (beach, profile) and fanned out.
- Excellent: per device (route.ts:792). Coming-up: per device (route.ts:684-685, even though `selectComingUpEvent` could be hoisted per beach). Sun-color: per device (route.ts:908-914).
- Coalescing happens after rendering: the coming-up body is built first (route.ts:685), then appended as `"\n\n" + body` to the digest (178) or the Excellent push (801). Locale is per device, so the pieces always match.

**(b) What changes for per-device locale choice**

Thread a `locale` argument from the device record down to each builder:
1. `lib/alerts/catalog.ts`: add `locale` to `AlertContext` (217-233). Make `bodyFor`/`titleFor`/`comingUpBody` (241, 295, 304) look up templates by locale instead of literals. Move the pre-formatted pieces to locale-aware helpers.
2. `lib/alerts/comingUp.ts:315` `buildComingUpSubject(selection, tz)` gets a `locale` param, or better returns RAW values (ISO instants, enums) so `catalog.ts` formats. Also `lib/format.ts:5,33` (`fmtTime`, `fmtDate`, web-shared) need a locale param. Callers: route.ts:684, `sunColor.ts:206-209`.
3. `lib/alerts/sunColor.ts:152` `sunColorLeadPhrase` and `:187` `sunColorDecision` take locale. `sunQualityBandMeta().label` (`sunQuality.ts:118-124`) is English; needs a key-to-text map per locale.
4. `lib/push/notify.ts`: make `PushSummary` locale-free (store phrase KEYS, the window start/end ISO pair, and the score) and render per device in `decideNotifications` (301). `decideNotifications` currently takes only `{prefs, sent}` (`Notifiable`, 31-34); it must also get `locale`. Otherwise add `locale` to the `SummaryCache` key (`morning.ts:53`) so Spanish and English devices never share an entry. Also `fmtWindow` (146) and `conPhrase` (101-107, which parses English text) must stop reading English display strings.
5. `lib/alerts/evaluate.ts:46-72`: `AtBeachInput.device` gets `locale`; pass it into `buildAlert` at 300. `run.ts:633-641` passes `device.device.locale`.
6. `lib/alerts/morning.ts:85-93` `excellentDecision` passes locale through (it already receives `device`).
7. Storage and API: see (c).
8. TRAP: `d1Store.ts` `listArmed` (653-690) hand-builds a `DeviceRow` from an explicit column list. A new `locale` column MUST be added to that SELECT and row builder. If missed, `toRecord` falls back to the default and every at-beach hazard alert stays English, silently. (Existing proof of the pattern: the `sun_color_*` columns are also absent from `listArmed`.) `listPushable` (857) and `getDevice` use `DEVICE_COLS`, so they pick up new columns when added there. `memoryStore.ts` (`listArmed` 270) must be checked the same way.
9. Tests: about 270 test cases across `lib/alerts/*.test.ts`, `lib/push/notify.test.ts`, `app/api/push/pushRoutes.test.ts` (counts: catalog 23, sunColor 58, notify 11, morning 15, comingUp 36, evaluate 43, run 30, pushRoutes 57). Many assert English literals. Default locale `en` keeps them green if the new param is optional.

**(c) D1 tables and columns, migrations, and request body shapes**

- Highest migration: `migrations/0012_sun_color_prefs.sql`. The next file is `0013_*.sql`. Full list: 0001_init, 0002_scan_log, 0003_grant_sources, 0004_send_claims, 0005_scan_funnel, 0006_history, 0007_live_activities, 0008_device_tokens, 0009_app_opens, 0010_surf_ft, 0011_coming_up_deliveries, 0012_sun_color_prefs. Applied with `wrangler d1 migrations apply` (D1 tracks once-only application). Previous ALTER style: `ALTER TABLE devices ADD COLUMN ...;` (nullable, no CHECK; validation in the route; unknown values resolve to a default on read). A `locale TEXT` column fits this exactly.
- `devices` table (0001 + 0003 + 0008 + 0012): `id` PK, `platform`, `push_token`, `tz`, `home_slug`, `profile_json`, `prefs_json`, `plan`, `entitlement_until`, `trial_used`, `preview_seen`, `sent_json`, `created_at`, `updated_at`; + `store_until`, `code_until`, `trial_until` (0003); + `token_hash`, `token_issued_at`, `token_used_at` (0008); + `sun_color_min_band`, `sun_color_lead_min` (0012). Indexes on `push_token`, `home_slug`, `token_hash`.
- Other tables the push path touches: `presence` (armed windows), `alert_log` (PK device_id+alert_key), `send_claims` (0004), `coming_up_deliveries` (0011), `live_activities` (0007).
- Row and type plumbing for a new column: `lib/db/types.ts` `DeviceRow` (184), `DevicePatch` (306), `DeviceRecord` (261), `newDeviceRow` (422), `applyPatch` (494), `toRecord` (532). `lib/db/d1Store.ts`: `DEVICE_COLS` (101-104), `UPSERT_COLS` (206-209), `UPSERT_DEVICE` (216-247, positional binds `?1..?31`; append `?32` value and `?33` present-flag, same trick 0012 used), `upsertBinds` (249-290).
- `POST /api/devices` request body (`app/api/devices/route.ts`): `{ deviceId, platform?, tz?, homeSlug?, profile?, prefs?, previewSeen?, sunColorMinBand?, sunColorLeadMin? }`. Parsed in `patchFromBody` (~47-105): platform in {ios, android, web}; tz must pass `Intl`; unknown keys ignored. This is where `locale` is added and validated (closed list `"en" | "es"`, normalize `es-US`/`es_MX` to `es`). Response: `okDevice(device, {installToken?})`.
- Client side, single choke point: `baseFields()` at `lib/plus/client.ts:369-377` is spread into every `saveDevice` call (lines 459, 635, 822, 833, 842, 910, 948, 975, 1004). Add `locale` there and every write keeps it fresh. Type: `DevicePatchBody` at `lib/plus/api.ts:27-38`.
- `POST /api/push/register-native` (`app/api/push/register-native/route.ts`): body `{ slug, token, platform, prefs?, deviceId? }` (type at 28-34). It upserts `{platform, pushToken, tz: loc.timezone, homeSlug, prefs?, sent}` at 96-103. This is the call that creates or adopts a device row from a push token and is often the first write from a fresh install. It should also accept `locale`. Client call: `lib/push/native.ts:196-202` (`enableNative`).

**(d) Two populations?**

Not quite as framed. In current code there is ONE store for who gets pushed (D1 `devices`), and KV is a read-only legacy feeder:

1. D1 device rows (all current registrations).
   - `register-native` writes straight to D1 (`store.upsertDevice`), with `deviceId` or a synthetic `legacy:<base64url(token)>` id (`register-native/route.ts:65`; `lib/db/legacy.ts:20-22`).
   - `listPushable()` (`d1Store.ts:857`) returns EVERY device with `push_token IS NOT NULL AND platform IN ('ios','android')`, free or Plus.
   - Free devices: skipped before any copy is built (`route.ts:438` in `slugConditionsNeed`; `route.ts:619` in the loop). The at-beach engine's `listArmed` SQL requires `plan='plus' AND entitlement_until > now` (`d1Store.ts:~662-668`). Every alert is Plus-only ("Every alert is Plus", route.ts:616-618). So free devices get NO push copy today. They should still get a stored `locale`, since they may upgrade.
   - Plus devices (`entitled()`): get the digest, Excellent, coming-up, sun-color, and (when armed) hazard alerts.
2. Pre-Plus KV subscriptions (`lib/push/nativeStore.ts`, `NativeSub`: `{token, platform, slug, tz, prefs:{morning,safety}, createdAt, sent}`; Cloudflare `PUSH_KV`, shared namespace with the OpenNext cache).
   - NOTHING writes KV anymore: `putNativeSub` has zero callers (grep). It is only read by `listNativeSubs()` at the start of each run (route.ts:243-249) and imported via `importLegacy` (`d1Store.ts:820-847`) as `legacy:<b64url(token)>` rows. `legacyPatch()` (`legacy.ts:48-57`) carries no locale and no grants, so these are FREE rows and receive nothing until Plus.
   - KV records are never deleted after import (only on unregister or prune), so the whole list is re-read every run.
   - A legacy row can pick up a locale in two ways: `register-native` called with the token (the web bundle is loaded live from `app.isitbeachday.com`, so even an OLD native shell sends new web code), or when the row is adopted by a real `deviceId`.
3. Web-only devices (platform `web`): no push token, no web push. Nothing to localize on the push side.

---

## 3. Dedupe and ledger keys that embed text

Result: NO key or comparison embeds a rendered title or body. Changing a device's language cannot cause a double send. Nothing in `lib/alerts`, `lib/push`, `lib/db`, or `app/api/push` compares `title` or `body` (grep for `.title ===`, `.body ===`, `.includes` found nothing outside tests).

`alert_log.alert_key` (PK is device_id + alert_key). Built in `lib/alerts/catalog.ts:347-388`:
- `lightning`, `lightning:2mi`, `thunder`, `wind-gust`, `water-advisory`, `rain-soon`, `rain-clearing`: bare enums, then scoped with `@<slug>` by `scopeKey` (342-344, 385-388).
- `flag:red|double-red` (354). `rip:<CAP alert id>` or `rip` or `rip:moderate` (362).
- `severe:<NWS event name>` (352): the ONLY key containing words. It is NWS's own English event string from the feed (e.g. "Tornado Warning"), not our wording, so it is unaffected by language. Caution: when translating the BODY of a severe alert, never translate the value that goes into this key. Same for `rain-wet@<slug>` (`run.ts:616`).
- `score-excellent:<YYYY-MM-DD beach-local>` (`morning.ts:90`).
- Coming-up: `eclipse:<peak-iso>`, `tide:<stationId>:<episode-start>`, `meteor:<showerId>:<year>` (uses `showerId`, not `showerName`; `comingUp.ts:210-213`), `supermoon:<full-moon-iso>`, `launch:<ll2Id>` (`comingUp.ts:237,244,250,257,263`).
- `sun-color:<kind>:<beach-local date>` (`sunColor.ts:118-123`).
- `meta_json` does store some English words, only for debugging, never compared: `bandLabel` (`catalog.ts:410`), `event` (400).

`send_claims.key` (`lib/db/sendClaims.ts:26-28`): `<deviceId>:<alertKey>:<window>`. Examples: `:morning:<date>` (route.ts:173), `:score-excellent:<date>` (798), `:sun-color:<dedupKey>` (916), at-beach `<dedupKey>:<floor(now/repeatMs)>` (`run.ts:687`), `liveactivity-end:<activityId>:<window>` (`run.ts:352`), `liveactivity:<activityId>:<reason>:<hash>` (`run.ts:793-797`). `hash` = `hashContentState()` (`lib/liveActivity/state.ts`), JSON of quantized numbers and enums. Text-free.

`coming_up_deliveries (device_id, event_key)`: same event keys as above.
`devices.sent_json` (`SentState`, `lib/db/types.ts:~95`): `morningDate`, `comingUpCheckedDate`, `sunColorCheckedKey`, `sunColorDeferUntilMs`: dates and keys only.

One adjacent hazard, not a text key but locale-sensitive code that must NOT change: date and hour KEYS are produced with `Intl.DateTimeFormat("en-CA")` and `("en-US", hour12:false)` at `route.ts:70-79`, `lib/score.ts:1596,1616,1822,1869,1907`, and `lib/history/archive.ts:30`. These produce `YYYY-MM-DD` and 0-23 for dedupe and bucketing. A blanket "replace en-US with the user's locale" refactor would silently break `morningDate`, claim windows and `sun-color:<kind>:<date>`. Only DISPLAY formatters (`fmtTime`, `fmtDate`, `fmtWindow`, `comingUp.ts` helpers) should take a locale.

---

## 4. Live Activity and Dynamic Island

### 4.1 Which strings does the server or web send? None.

The content state is text-free (`lib/liveActivity/state.ts:44-67`): `score` (int), `windMph`, `gustMph`, `windDeg`, `waveFt` (numbers), `clarity` ("clear"|"murky"), `seaweed` ("low"|"moderate"|"high"), `nextTideAt` + `nextTideKind` ("high"|"low"), `sunsetAt`, `lightning {active, latched, miles, bearingDeg, observedAt, holdUntil}`, `updatedAt`, `unavailable`, plus `v`, `seq`, `ended`. The Swift file says it explicitly (`BeachSessionAttributes.swift:42-43, 254-259`): verdict word, compass, rising/falling are derived on-device. The native plugin whitelists enum values and rejects anything else (`BeachSessionActivityPlugin.swift:650-660`), so server-chosen text would need a schema bump.

The only text in the whole chain is `attributes.beachName` (static, set once at start): `components/plus/BeachModeCard.tsx:883` (`armedTarget.name`), then `lib/plus/liveActivity.ts` (`BeachSessionAttributesWire`), validated at `BeachSessionActivityPlugin.swift:578` (non-empty, at most 200 chars). A proper noun from `config/locations`. It stays English unless beach names are localized.

Web-side Lock Screen row messages (`BeachModeCard.tsx:237, 241, 248`: "Update the app to show this on your Lock Screen.", "Needs iOS 16.2 or later.", "Live Activities are off for this app — turn them on in iPhone Settings → Is It Beach Day → Live Activities.") are WEB strings. They belong to the web researchers, flagged here only because they describe a native surface. Note the third one names the iOS Settings path and the app display name.

Language implication: the Live Activity language is whatever the OS gives the widget extension. The server needs no change for it. If the web app ever offers a language picker that differs from iOS's language, the Lock Screen would NOT follow it (push would, via stored `locale`). Decision needed: derive the stored `locale` from the iOS language only, or add an optional field to `ContentState`/attributes (new fields must be optional per the versioning rule, `BeachSessionAttributes.swift:9-12`).

### 4.2 Hardcoded Swift strings (all user-visible, none localized)

`ios/App/Shared/BeachSessionAttributes.swift` (shared by both targets):

| Line | String(s) |
|---|---|
| 266-270 | Verdicts: "Absolutely!", "Yes — good beach day", "Decent", "Likely not", "Definitely not". A third copy of the web/push verdict table; mirrors `lib/scoreBands.ts:33-37`; keep in sync by hand (comment 262-263). |
| 289-290 | 16 compass abbreviations `N NNE NE ... NNW` (visible, in stats and lightning row). Spanish uses O for W and E for Este. |
| 299-304 | 16 spoken directions "north", "north-northeast", ... (VoiceOver only) |
| 317-322 | "Rising" / "Falling" (`tideTrend`, UNUSED dead code, grep found no caller) |
| 327-328 | "Clear", "Murky" |
| 330, 340 | `.capitalized` fallbacks on unknown codes |
| 336-338 | "Low seaweed", "Some seaweed", "Heavy seaweed" |

`ios/App/BeachSessionActivity/BeachSessionActivityLiveActivity.swift`:

| Line | String |
|---|---|
| 96 | unit word "mile"/"miles" (needs plural rules) |
| 97 | `"Lightning \(n) \(unit)\(dir). Get out of the water."` (VoiceOver) |
| 99 | "Lightning near you. Get out of the water." (VoiceOver) |
| 153 | "now" |
| 155 | "passed" |
| 229 | "Beach score \(score) out of 100" (VoiceOver) |
| 260 | "Session ended" |
| 261 | "Conditions unavailable" |
| 262 | "Beach score" |
| 271 | `"\(wind) mph"` + compass |
| 275 | `"%.1f ft"` |
| 289 | "Session ended" / "Score for the beach" |
| 297 | "High tide" / "Low tide" |
| 321 | "to sunset" |
| 357 | `"Lightning %.0f mi%@ — leave the water"` |
| 359 | "Lightning near you — leave the water" |
| 402 | "Conditions unavailable — showing the last known session." |
| 415 | "Thanks for checking in. This session has ended." |
| 434, 491 | accessibility "Session ended" / "Conditions unavailable" |
| 456, 493 | "⚡" (emoji, no translation) |
| 458 | `"%.0f mi"` |
| 467 | "Sunset in " (zero-width, VoiceOver only) |
| 514, 522 | "Session ended", "Conditions unavailable" |
| 537, 543 | "Beach score", "Beach score N out of 100" |
| 566 | "Sunset in" (zero-size, VoiceOver only) |
| 596, 599 | `"\(wind) mph"`, `"%.1f ft"` |

Count: about 30 distinct user-visible phrases + 32 compass strings (can be generated from the locale instead of translated) + 5 verdicts counted above. About 35 phrases of real translation work.

Swift-specific traps:
- `Text("literal")` is a `LocalizedStringKey`, so it is auto-localized once a string catalog exists. But many strings flow through helpers returning plain `String` (`BeachSessionVerdict.verdict`, `BeachSessionFormat.*`, `headerVerdictText` 259, `mainText` 354, `lightningAccessibilityLabel` 92, `shortVerdict` 130). Passed to `Text(someString)` they are verbatim, NOT localized. Each needs `String(localized:)` or a rewrite.
- `shortVerdict` (130-136) splits the verdict on the exact string `" — "` to shrink "Yes — good beach day" for the narrow Dynamic Island region. A Spanish verdict must keep that separator, or the split silently stops working and the text truncates.
- Mixed `mph`/`ft`/`mi` units are hardcoded imperial. A product decision; US Spanish speakers use imperial.
- `Text(timerInterval:)` countdowns are formatted by the OS and localize on their own.
- `BeachSessionDemo.swift:51` `beachName: "South Beach"` is debug-only (launch-argument demo). Not shipped UI.
- `BeachSessionActivityPlugin.swift` `reason:` strings (lines 147-312, e.g. "activities-not-enabled") are developer codes returned to JS, not shown to users.

### 4.3 Localization setup in the Xcode project: none

- No `*.lproj` except `ios/App/App/Base.lproj` (`LaunchScreen.storyboard`, `Main.storyboard`; a grep for visible text in both found none).
- No `.strings`, `.xcstrings`, or `.stringsdict` anywhere under `ios/` (excluding build output).
- `ios/App/App.xcodeproj/project.pbxproj:238` `developmentRegion = en`; `240-243` `knownRegions = (en, Base)`.
- `CFBundleDevelopmentRegion = en` in both Info.plists (`ios/App/App/Info.plist:7-8`; `ios/App/BeachSessionActivity/Info.plist:5-6`). No `CFBundleLocalizations` key anywhere.
- `SWIFT_EMIT_LOC_STRINGS = YES` is set (pbxproj:522, 551, the widget extension target configs), so Xcode can extract `Text("...")` literals once a catalog exists. The widget deploys at iOS 16.2 (pbxproj:511, 539); the app target at 15.0.
- The widget extension is a separate bundle and needs its OWN catalog (the shared Swift file compiles into both targets, so each target needs its own copy of the strings).

---

## 5. Other native strings

| Where | File:line | String | Notes |
|---|---|---|---|
| iOS app display name | `ios/App/App/Info.plist:9-10` | "Is It Beach Day" | Also used in the OS permission prompts and the iOS Settings path. `capacitor.config.ts:9`, `ios/App/App/capacitor.config.json:3` (`appName`, build config only) |
| iOS widget display name | `ios/App/BeachSessionActivity/Info.plist:7-8` | "Beach Session" | |
| Location prompt | `ios/App/App/Info.plist:31-32` `NSLocationWhenInUseUsageDescription` | "Is It Beach Day uses your location to open the beach you're near and to send beach alerts for where you are." | Needs `es.lproj/InfoPlist.strings` |
| Location prompt (Always) | `ios/App/App/Info.plist:36-37` `NSLocationAlwaysAndWhenInUseUsageDescription` | "...only while you have the app open, ..." | Required by Apple's scanner (ITMS-90683, see comment 33-35); must stay accurate in Spanish |
| Notification permission | none | | No Info.plist string for push. The system prompt is localized by iOS. |
| Offline fallback page | `mobile/www/index.html:2` `<html lang="en">`; `:6` `<title>Is It Beach Day?</title>`; `:24` `<h1>Is it beach day?</h1>`; `:25` "Can’t reach the ocean right now — check your connection."; `:26` button "Try again" | 4 strings + the `lang` attribute | Identical copies at `ios/App/App/public/index.html` and `android/app/src/main/assets/public/index.html`. Static HTML with no JS i18n; it can use `navigator.language` inline (works offline). |
| Swift alerts/dialogs | `ios/App/App/*.swift` | none | No `UIAlertController`, `NSLocalizedString`, or `String(localized:)` anywhere in app Swift. The `--demo-live-activity` launch args in `AppDelegate.swift:15-21` are debug-only. |
| Capacitor plugins | `capacitor.config.json` `packageClassList` | `GeolocationPlugin`, `PushNotificationsPlugin`, `PurchasesPlugin` | No custom user-visible strings. Geolocation uses the Info.plist strings above. Push has no UI. RevenueCat is headless; the StoreKit sheet and product names/prices come from App Store Connect and the OS. |
| Splash image | `ios/App/App/Assets.xcassets/Splash.imageset/` | glyph only, no text (checked visually) | |
| Android app name | `android/app/src/main/res/values/strings.xml:3-4` | `app_name`, `title_activity_main` = "Is It Beach Day" | Lines 5-6 are IDs, not shown. There is no `values-es/`. |
| Android manifest | `android/app/src/main/AndroidManifest.xml:13` | `android:configChanges="...locale..."` | App handles locale changes itself, fine. No `localeFilters` / `resConfigs`. |
| Android permissions | manifest 40-42 | `INTERNET`, `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION` | The OS prompt is localized by Android. No rationale text in the repo. |
| PWA manifest | `app/manifest.ts:6-9` | `name`, `short_name` "Beach Day", description | Web-side; flagged because it is install-time text. |

---

## 6. How could the web app learn the phone's language?

Grep result (repo source, excluding `node_modules`, builds, tests): there is NO use of `navigator.language`, `navigator.languages`, `Accept-Language`, `@capacitor/device`, `getLanguageCode`, `Locale.preferredLanguages` or `resolvedOptions().locale` anywhere in `app/`, `components/`, `lib/`, `config/`, `scripts/`, `ios/App/**/*.swift`, `android/app/src`. There is no `middleware.ts` or `src/middleware.ts`. `@capacitor/device` is not installed (`package.json` dependencies: `@capacitor/android|core|geolocation|ios|push-notifications`, `@revenuecat/purchases-capacitor`). `<html lang="en">` is hardcoded at `app/layout.tsx:89` and `app/global-error.tsx:25`. The only timezone read is `Intl.DateTimeFormat().resolvedOptions().timeZone` in `lib/plus/client.ts:372`.

Candidate signals (the first two need no native app update, since the shell loads the live site):
1. `navigator.language` / `navigator.languages` in JS. Cheapest; available in WKWebView and Android WebView.
2. `Accept-Language` request header on the server. The WebView's `fetch` to `/api/devices` and `/api/push/register-native` carries it, so the server could default `locale` with no client change. Weak as the only source: it can be absent or reordered.
3. `@capacitor/device` `Device.getLanguageCode()`. Needs a new native plugin, so a new app build.

WKWebView and Accept-Language, VERIFY BEFORE RELYING: my understanding is that WKWebView builds `navigator.language` and `Accept-Language` from the iOS preferred-language list, but iOS also picks per-app languages from the app bundle's declared localizations. With only `en` declared (today: `knownRegions = en, Base`, no `CFBundleLocalizations`), a device set to Spanish may still report `es` to the web view, or may be resolved to `en`. I could not confirm this from the repo. A 5-minute check: run the current build in a simulator set to Spanish and read `navigator.languages` via a debug page or Safari Web Inspector. Re-test after adding `es` to `knownRegions`, because adding the localization changes what iOS resolves.

Existing patterns a language preference can copy:
- Theme: `localStorage["theme"]`, applied pre-paint by an inline `THEME_SCRIPT` (`app/layout.tsx:85`; duplicated in `app/global-error.tsx:12`), toggled in `components/ThemeToggle.tsx:42-59`. Client-only; the server never sees it.
- Home beach: `lib/homeBeach.ts` key `bd:home-beach` (get/set/clear with SSR and private-mode guards). The device id is `lib/deviceId.ts` key `bd:device-id`. Other keys: `bd:open-day` (`lib/useAppOpenPing.ts:16`), `ibd:reloadTargetSha`, `native-push:<slug>` (`lib/push/native.ts:90`).
- Cookies: no preference cookie exists. `/get-app` reads a short-lived sticker cookie (`app/get-app/route.ts:61-69`); there is no cookie for any setting.
- BIG CAVEAT for SSR: `localStorage` is invisible to the server, so server-rendered pages cannot honor a stored language, and the static-first Next/OpenNext setup caches pages. A language choice the server must see at render time needs a cookie (or a URL segment such as `/es/...`), not just `localStorage`. Pushes are separate: they use the device row's `locale`, so a `localStorage` value synced to the server through `baseFields()` is enough for push.
- Sync back to the server: `baseFields()` (`lib/plus/client.ts:369`) and `enableNative` (`lib/push/native.ts:196-202`).

---

## 7. App Store listing: what is in the repo

Metadata text (listing name, subtitle, description, keywords, what's-new, promotional text) is NOT in the repo. Searched `fastlane/`, `docs/`, `scripts/ios/`, `marketing/`, `screenshots/`, `*.py`, `*.md`, `*.json`.

What does exist:
- App name used everywhere: "Is It Beach Day" (`Info.plist`, `capacitor.config.ts`, `app/manifest.ts`, Android `strings.xml`). Store URL: `https://apps.apple.com/us/app/id6779072992` (`lib/appStore.ts:10`). Bundle id `com.isitbeachday.app`; widget `com.isitbeachday.app.beachsession`.
- Subscriptions (`docs/BILLING_SETUP.md:43-50`): group "Beach Day Plus" (22367204); products `com.isitbeachday.app.plus.monthly` ($2.99, ASC id 6809597275) and `com.isitbeachday.app.plus.yearly` ($19.99, ASC id 6809597421); 3-day free-trial intro offers; "a localized name + description" is mentioned (line 103) but the actual display names and descriptions are not in the repo (they live in App Store Connect). RevenueCat entitlement `plus`, offering `default`.
- "What's new": the repo's `lib/changelog.ts` is the WEB page footer changelog (rule in `CLAUDE.md:36-42`), not App Store release notes. No ASC release-notes file.
- Fastlane (`fastlane/Fastfile`, `Appfile`): Google Play ONLY. `skip_upload_metadata: true`, `skip_upload_images/screenshots/changelogs: true`; the comment says listing copy and graphics are managed in the Play Console. No `fastlane/metadata/`, no `deliver` lane. `PLAY_PUBLISHING.md` is about the service account and uploads, not listing text.
- iOS shipping script: `scripts/ios/build-testflight.sh` (archive, export, `altool` upload; hardcoded ASC key id and issuer). No listing metadata. No `asc_*.py` scripts in the repo.
- Screenshots (`screenshots/appstore/`):
  - CURRENT set: `1.2/final/` (8 JPGs, 1290x2796, mtime 2026-09-28 16:49, newest): `01-know`, `02-lock-screen`, `03-own-score`, `04-rip-currents`, `05-lightning`, `06-cams`, `07-plan`, `08-sunset`. Contact sheet: `1.2/final-set-contact.jpg`. Raw captures: `captures-1.2/`; per-shot work folders `1.2/01-know`...`1.2/09-sand`; superseded variants in `1.2/final/_prev/`.
  - OLDER set: `final/` (8 PNGs, 1290x2796, 2026-09-28 03:07): `01-know`, `02-plan`, `03-storms`, `04-cams`, `05-trust`, `06-golden`, `07-sand`, `08-push`.
  - Every screenshot has an ENGLISH HEADLINE baked into the image (1.2 set, from the contact sheet): "KNOW BEFORE YOU GO", "SEE IT ON YOUR LOCK SCREEN", "GET YOUR OWN BEACH SCORE", "SPOT RIP CURRENTS HOUR BY HOUR", "TRACK LIGHTNING NEAR YOU", "WATCH YOUR BEACH LIVE", "PLAN THE BEST TIME EACH DAY", "CATCH THE PERFECT SUNSET", and the phone UI inside is the English web UI. A Spanish set means new headlines AND recapture of 8 shots with the Spanish UI. The generation pipeline scripts are not in the repo (only outputs).
- Per `CLAUDE.md` and user memory (not repo evidence): the 1.2 set awaited an owner look and ASC upload. Not verified here.

---

## 8. Totals and top risks

### Totals (rough)

| Area | Count |
|---|---|
| Push copy: templates and fragments | about 70 (catalog 28, notify 30, scoreBands 5, lead phrases 4, labels about 5) |
| Push: data-derived English words that show up in bodies | about 20+ (NWS events, shower names, launch names, "over the water") |
| Push: date/time/join formatting helpers needing locale | 8 (`fmtTime`, `fmtDate`, `fmtWindow`, 4 in `comingUp.ts`, `joinPhrases`) |
| Live Activity (Swift) | about 35 phrases + 32 compass strings (derivable) |
| Other native (plist, offline page, Android) | about 8 (2 usage descriptions, 2 display names, 4 offline-page strings) + 2 Android names |
| App Store listing | not in repo; 8 screenshots with baked English text |

### Top 5 risks

1. Cached English text shared across devices. `SummaryCache` (`morning.ts:53`) holds the `pros`, `cons`, `bestWindow`, `skipWindow` English strings once per (beach, profile). If locale is added without making `PushSummary` locale-free (or keying the cache by locale), Spanish users get English digests or the reverse. `conPhrase` (`notify.ts:101-107`) also parses an English display string from `score.ts:1027`; translating the display would break seaweed phrases.
2. Silent English fallback in `listArmed`. `d1Store.ts:653-690` hand-lists columns. Forget `d.locale` there and all hazard alerts (the safety-critical ones) stay English, with no error. `memoryStore.ts:270` needs the same check; tests that use the memory store will not catch a D1 miss.
3. Language-sensitive Intl calls mixed with key-producing ones. Display formatters use `en-US` (`format.ts:5,33`, `notify.ts:148`, `comingUp.ts:272,287`), while key/date-bucket code uses `en-CA`/`en-US` too (`route.ts:70-79`, `score.ts:1596-1907`, `archive.ts:30`). A global find-and-replace would corrupt `morningDate`, claim windows and `sun-color:<kind>:<date>`, causing double sends or missed digests. Also grammar: no plural handling today ("1 minutes"), word-order concatenation (`"${weekday} ${fmtDate}"`, `"${bandLabel} ${kind} coming"`, `"${beach}"` + clause appends), `" & "` joins, and the lead-phrase sentence "X is {phrase} away." will not translate by swapping words.
4. Live Activity and push can disagree on language. Widget text follows the OS and the widget bundle's own catalog; push follows the server-stored `locale`. The widget extension has no localization at all (`knownRegions = en, Base`; no catalog). String-returning Swift helpers are not auto-localized, `shortVerdict` depends on a literal `" — "`, and VoiceOver strings are separate. There are also now THREE copies of the verdict table (web `scoreBands.ts`, Swift `BeachSessionAttributes.swift:266-270`, push `scoreBands.ts` `push` field) to keep in sync.
5. Language signal is unproven and rows start empty. Nothing reads `navigator.language` or `Accept-Language` today, and whether WKWebView reports the iOS language when the app declares only `en` is unverified. Every existing device row (including legacy KV imports, which are free and idle) has no locale, so the default must be explicit (`NULL` means `en`) and the first write after the release must set it. Pre-existing devices only learn their locale when the app is next opened; a Spanish speaker who never reopens keeps getting English. Also: `/api/push/run` re-reads the whole KV list each run, so any new legacy handling adds per-run cost. Also store assets: the 8 screenshots have baked English text, and the usage-description strings and display name need `es.lproj/InfoPlist.strings`, and the offline page is a static English file.

### Smaller items worth tracking

- `wind-gust` copy hardcodes "25 mph" instead of `GUST_ALERT_MPH` (`catalog.ts:258`, `evaluate.ts:40`): change the threshold and the push text lies, in any language.
- `tideTrend` in Swift is dead code (no caller).
- APNs `apns-collapse-id` tags (`morning`, `excellent`, `coming-up`, `sun-color`, `safety:<hazard>:<slug>`) are text-free; unaffected.
- Android FCM shows the same server strings with no resource-based fallback; `strings.xml` has just the app name, so localizing Android native is trivial next to iOS.
