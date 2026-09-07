# Beach Day Plus — Build Spec (binding contracts)

Read `docs/PREMIUM_ROADMAP.md` first for intent. This file is the contract every agent builds to: types, routes, schema, file ownership. If you must deviate, say so in your report.

## Ground rules

- Free users see byte-identical behavior. `lib/score.test.ts` (92 cases) passes untouched.
- Adapters and API routes never throw to the client. Errors are JSON `{ ok: false, error: "<slug>" }`.
- No new npm dependencies except `@capacitor/geolocation` (Agent C).
- Tests: vitest with fixtures, no network. `npm test` and `npx tsc --noEmit` must pass before you report.
- Copy: plain English. Never say "AI". Never say "Algae" (it is "Seaweed").
- Do not touch the cam, vision, lightning, GOES, or MRMS pipelines or their workflows.
- UI at 390 px: no clipped text. A 2-column tile sub-line needs a `subShort`. Run `npm run check:mobile` if you touch UI.
- Dates: run `date` before writing any date anywhere.
- Report back in ≤300 words: files touched, test counts, deviations, anything the integrator must know.

## Identity

- `deviceId`: UUID v4 minted once on the client, localStorage key `bd:device-id` (`lib/deviceId.ts`, Agent C). Sent as the JSON body field `deviceId` on every Plus API call. No auth, same trust model as the push token today.
- Legacy KV push subscriptions (keyed by push token) are imported into D1 as `id = "legacy:" + base64url(token)` on the first run-route execution. When a client later registers push with a `deviceId` and the same token, the legacy row is deleted and its prefs/sent state moves to the new row.

## D1 — binding `DB`, database `isitbeachday-plus`, `migrations/0001_init.sql` + `0003_grant_sources.sql`

```sql
CREATE TABLE devices (
  id TEXT PRIMARY KEY, platform TEXT, push_token TEXT, tz TEXT, home_slug TEXT,
  profile_json TEXT, prefs_json TEXT,
  plan TEXT NOT NULL DEFAULT 'free', entitlement_until INTEGER,       -- DERIVED, see below
  store_until INTEGER, code_until INTEGER, trial_until INTEGER,       -- the three grant sources
  trial_used INTEGER NOT NULL DEFAULT 0, preview_seen INTEGER NOT NULL DEFAULT 0,
  sent_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX devices_push_token ON devices(push_token);
CREATE INDEX devices_home_slug ON devices(home_slug);
CREATE TABLE presence (
  device_id TEXT PRIMARY KEY, slug TEXT NOT NULL, lat REAL, lon REAL, accuracy_m REAL,
  fix_at INTEGER, armed_until INTEGER NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE alert_log (
  device_id TEXT NOT NULL, alert_key TEXT NOT NULL, sent_at INTEGER NOT NULL, meta_json TEXT,
  PRIMARY KEY (device_id, alert_key)
);
```

**Grant sources (added by `migrations/0003_grant_sources.sql`).** Plus can come
from a store purchase, an unlock code, or the trial — three independent
nullable epoch-ms columns, none of which can shorten another. Effective
access is `MAX(store_until, code_until, trial_until)`; `plan` and
`entitlement_until` are DERIVED from that max on every write (never written
directly) and kept for every existing reader: `entitled(device, now) = plan
=== 'plus' && entitlement_until > now` still holds exactly as before. A route
only ever patches the ONE grant column it owns — `/api/devices/purchase` →
`storeUntil`, `/api/devices/unlock` → `codeUntil`, `/api/devices/trial` →
`trialUntil` via `claimTrial` — so it can only move access up for its own
source, never take away what another source granted.

Store (`lib/db/store.ts`, Agent B): one `DeviceStore` interface, two backends — **D1** (via `getCloudflareContext().env.DB`) and **memory/file** (tests, and `next dev` without bindings; persist to `.plus-store.json` like the old KV file fallback). Methods: `getDevice(id)`, `upsertDevice(id, patch)` (one atomic write per call — a field left out of `patch` is guaranteed to survive a concurrent write to some other field), `claimTrial(id, until)` (atomic "grant the trial iff `trial_used` is still 0"; returns the sentinel `"trial-used"` instead of a record when it was already spent), `clearPushToken(id, expectedToken)` (clears the token only if it still matches — used to clean up a dead token without erasing a concurrently-registered fresh one), `findByPushToken(token)`, `deleteDevice(id)`, `listDevices()`, `listArmed(nowMs)` (devices ⋈ presence, `armed_until > now`, entitled only), `setPresence(deviceId, p)`, `clearPresence(deviceId)`, `getSent(deviceId)` / `setSent(deviceId, sent)`, `lastAlert(deviceId, key)` / `markAlert(deviceId, key, at, meta?)`, `importLegacy(subs)` (idempotent).

## Types

Agent A owns scoring types (in `lib/types.ts` / `lib/profile/types.ts`). Agent B owns device types (`lib/db/types.ts`).

```ts
type ProfileId = "swim" | "kids" | "sun" | "snorkel" | "dog" | "walk" | "surf";
type ScoreProfile = {
  profiles: ProfileId[];                 // 1 or 2; two blend
  heat: "cooler" | "normal" | "hot";
  crowds: "low" | "normal" | "high";
  advanced?: {
    mult?: Partial<Record<SubKey, 0 | 0.5 | 1 | 2 | 3>>;   // multipliers on the profile weight
    airIdeal?: [number, number]; waterIdeal?: [number, number];
    wavePref?: "calm" | "some" | "surf";
  };
};
// SubKey gains "clarity".
type ScoringOptions = {
  weights: Record<SubKey, number>;                       // sums to 1 before renormalization
  ideals: { airPlateau: [number, number]; waterPlateau: [number, number]; windPlateau: [number, number]; waveMode: "calm" | "some" | "surf" };
  capPolicy: "water" | "shore" | "surf";
};
DEFAULT_SCORING: ScoringOptions   // reproduces today exactly
resolveScoring(profile: ScoreProfile | null): ScoringOptions   // null → DEFAULT_SCORING

type AlertKey = "lightning" | "thunder" | "severe" | "rain-soon" | "rain-clearing" | "wind-gust"
              | "flag" | "rip" | "water-advisory" | "morning" | "score-excellent";
type AlertPrefs = Record<AlertKey, boolean>;             // defaults: all true

type DeviceRecord = {                                    // API shape, camelCase
  id: string; platform: "ios" | "android" | "web" | null; tz: string | null; homeSlug: string | null;
  profile: ScoreProfile | null; prefs: AlertPrefs;
  plan: "free" | "plus"; entitlementUntil: number | null;  // both DERIVED — see grant sources above
  grants: { storeUntil: number | null; codeUntil: number | null; trialUntil: number | null };
  trialUsed: boolean; previewSeen: boolean;
  presence: { slug: string; armedUntil: number; source: "auto" | "manual" } | null;
};
```

### Cap policies (Agent A)

- **weather caps** (every policy): lightning ≤5 mi, thunder, nowcast rain, rain forecast, severe NWS, wind > 20 mph, seaweed ceiling.
- **swim caps**: double-red, red flag, water-quality advisory, city no-swim, rip high/moderate, surf / coastal-flood advisory.
- `water` = weather + swim. `shore` = weather only. `surf` = weather + double-red + water-quality advisory + no-swim (red flag, rip, surf advisory are NOT caps for surfers).

### Safety lines (Agent A, `lib/safetyLine.ts`, pure)

- `swimSafety(d, snapshot)` → `{ level: "safe" | "caution" | "stay-out", reasons: string[] }`. stay-out: double-red, red flag, lightning ≤5 mi, severe, no-swim, water advisory. caution: rip moderate/high, waves > 4 ft, thunder, surf advisory.
- `surfConditions(d, snapshot)` → `{ level: "go" | "experienced" | "closed", reasons }`. closed: double-red, lightning ≤5 mi, severe. experienced: red flag, rip high, high-surf advisory, waves > 6 ft. (water advisory → reason, level stays.)

### Wave curves (Agent A)

`calm` = today's curve. `some` = 100 at 1–3 ft, gentle falloff both sides. `surf` = 100 at 2–5 ft, ~30 below 1 ft, ~40 above 7 ft.
Clarity sub-score = `snapshot.clarity.data.pct` (0–100) when present, else `null` (drops out; weights renormalize).

## HTTP API (Agent B) — POST JSON unless noted; success `{ ok: true, device: DeviceRecord }`

| Route | Body | Behavior |
|---|---|---|
| `POST /api/devices` | `{deviceId, platform?, tz?, homeSlug?, profile?, prefs?, previewSeen?}` | Upsert; only provided fields change |
| `GET /api/devices?deviceId=` | — | Read |
| `POST /api/devices/trial` | `{deviceId}` | Atomically (`claimTrial`), if `!trial_used`: trialUntil=now+3 d, trial_used=1. Else `error:"trial-used"` (409) |
| `POST /api/devices/unlock` | `{deviceId, code}` | `code === env.PLUS_UNLOCK_CODE` → codeUntil=now+365 d. Else 403 `error:"bad-code"` |
| `POST /api/presence` | `{deviceId, slug, lat, lon, accuracyM, fixAt, armedUntil, source}` | 403 `error:"not-entitled"` if not entitled; clamps `armedUntil ≤ now+8 h`; unknown slug → 400 |
| `DELETE /api/presence` | `{deviceId}` | Disarm |
| `POST /api/push/register-native` | existing + optional `deviceId` | Same response as today; writes D1 |
| `POST /api/push/unregister-native` | existing | Same |
| `POST /api/push/run?mode=all\|morning\|safety` | header `x-cron-secret` | Agent B ports to D1 with identical behavior; Agent F evolves it |

Rate/abuse: none in v1. Validate shapes; reject > 8 KB bodies.

## Cron — `workers/plus-cron` (Agent B)

Separate tiny Worker, same pattern as `workers/uw-frame`: `wrangler.jsonc` with `triggers.crons: ["*/5 * * * *"]`, `scheduled()` does `fetch("https://app.isitbeachday.com/api/push/run?mode=all", { method: "POST", headers: { "x-cron-secret": env.CRON_SECRET } })` and logs the JSON. Fable deploys it and sets the secret.

## Client Plus state (Agent E, `lib/plus/*`)

localStorage keys: `bd:device-id` (C), `bd:home-beach` (C), `bd:first-run-done` (E), `bd:profile` (ScoreProfile), `bd:plus` (`{plan, until, checkedAt}`), `bd:preview-seen`.
Hooks: `usePlus()` → `{ entitled, device, loading, refresh(), startTrial(), unlock(code), saveProfile(p), savePrefs(p) }`; `usePersonalScore(res, profile, nowMs)` → `{ score: ScoreResult, hourly, windows, safety }` memoized, debounced 150 ms for sliders. Entitlement is re-checked on `visibilitychange` and after every Plus action; the cached value is trusted for at most 6 h.

### Screens / components (Agent E, `components/plus/`)

- `PersonalizeCard` — door under the score. Free + no profile: "Personalize my score". Free + profile: locked pill "🔒 Your score" (+ reminder line if a preview delta was saved). Plus: hidden (headline is personal; toggle lives in the score area).
- `PlusOnboarding` — sheet: Q1 profile chips (1–2), Q2 heat, Q3 crowds → `RevealScreen` ("Your score today N · Everyone's M · tuned for …", computed client-side ONCE, then `previewSeen=true` saved local + server) → `Paywall`.
- `Paywall` — price line "$2.99/mo · $19.99/yr", primary "Start 3-day free trial" (calls `/api/devices/trial`), secondary "Have a code?" → unlock. Web: same, plus "Get the app for alerts". If trial used: "Subscribe" (native: store purchase placeholder that explains billing is coming; do not fake a purchase).
- `ScoreToggle` — Plus only: "Your score / Everyone's".
- `PlusSettingsSheet` — profile chips, heat, crowds, Advanced (per-factor 5 stops, air/water ideal ranges, wave pref), home beach picker, alert toggles (native only), "Have a code?", Restore.
- `NearYouChip` — "📍 1.2 mi from Boca Raton" or "Nearest covered beach: Deerfield, 38 mi"; tap → /find.
- `FirstRunBanner` — one-line "Find my nearest beach" → location → home beach → `router.replace`. Shown once (`bd:first-run-done`).
- `BeachModeCard` — Plus: within 2 mi → "You're at X. Safety alerts on for 4 h" auto-armed with Extend/Off chip; manual "Heading to the beach" (6 h). Free: the card is a door to onboarding. Native only (alerts need push).
- `NotifyButton` becomes the **Alerts** door: free → onboarding; Plus → enable push (existing flow) + settings.

## Alerts engine (Agent F, `lib/alerts/*`)

Every run with `mode=safety|all`: `store.listArmed(now)` → for each device: hazard geometry (lightning distance, rain) comes from the device's OWN fix only when it is fresh (≤ 30 min old), accurate (≤ 500 m when reported) and within 15 km of the armed beach — `lib/alerts/run.ts`'s `fixOf`; otherwise it falls back explicitly to the beach centroid, and the evaluated context records which one (`fixSource: "device" | "beach"`). Lightning from that fix via `summarizeStrikes(feed, lat, lon, now)` (`lib/sources/lightning.ts`); rain from MRMS for the presence slug when the feed has it, else Open-Meteo `minutely_15` precipitation for the 0.05° cell containing the fix (one fetch per cell per run, cached in-run); thunder / severe / flag / rip / water advisory / wind gust from `getConditions(slug)` (one per beach per run). Keys per catalog; `alert_log` dedup with a 30-min repeat; lightning escalation uses key `lightning:2mi` when nearest ≤ 2 mi. Respect `prefs`. Honor `PUSH_SAFETY_ALERTS` as a kill switch (flip the wrangler var to `"on"`).

Each at-beach hazard collapses (`apns-collapse-id` / the FCM equivalent) on its own id, `safety:<hazardKey>:<slug>` — different hazards, or the same hazard at two different beaches, never share a collapse window; a repeat update of the SAME hazard at the SAME beach (including a lightning escalation replacing the plain notice) does. The morning digest and "just turned Excellent" keep their own stable tags (`morning`, `excellent`).

`mode=morning|all`: 08:00 in the **BEACH's own local time** (`config/locations.ts`'s `timezone` for the device's home beach) once per day, **entitled devices only** (owner decision: all alerts are Plus), personal score via `resolveScoring(profile)`, copy in the user's number; free devices get nothing. This is deliberately NOT the phone's timezone — the device row's `tz` rides along for display only and never drives scheduling (see #13). The precheck (`slugNeedsConditions`), the actual send, and the daylight/date input for "just turned Excellent" all read the same beach-local hour and calendar date.
`score-excellent`: once per day (a calendar day in the BEACH's timezone) when the personal score for the home beach crosses ≥ 90 during daylight.

**Atomic send claims** (`send_claims`, migrations/0004_send_claims.sql — `key TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL, sent_at INTEGER`): both schedulers (the Cloudflare cron every 5 min, and the GitHub Actions hourly backstop — both stay enabled) can call `/api/push/run` close enough together that two runs read "not yet sent" from `alert_log` before either writes it. Before sending a morning digest, an Excellent alert, or an at-beach hazard, the sender claims `<deviceId>:<alertKey>:<window>` with `INSERT ... ON CONFLICT DO NOTHING` (`DeviceStore.claimSend`) and sends only if it won; it marks `sent_at` (`DeviceStore.markSent`) once the send actually succeeds. A claim with no `sent_at` after 10 minutes is abandoned and may be re-claimed by a later run (a crash or timeout must not wedge that alert shut forever). The dedup window in `alert_log` / `sent_json` is still the durable record of "was this sent" — the claim is only the concurrency guard underneath it, and is pruned opportunistically once it is 3+ days old.

## File ownership (no overlaps — if you need a file you do not own, put a note in your report instead)

- **A (Opus) scoring:** `lib/score.ts`, `lib/explain.ts`, `lib/types.ts`, `lib/profile/*`, `lib/safetyLine.ts`, their tests.
- **B (Opus) backend:** `lib/db/*`, `migrations/*`, `wrangler.jsonc` (bindings), `workers/plus-cron/*`, `app/api/devices/*`, `app/api/presence/*`, `app/api/push/register-native/*`, `app/api/push/unregister-native/*`, `app/api/push/run/route.ts` (port only), `lib/push/nativeStore.ts` (legacy reader), `next.config.mjs` (dev bindings), `.env.example`, tests.
- **C (Sonnet) location + native config:** `package.json` + lockfile, `ios/App/App/Info.plist`, `android/app/src/main/AndroidManifest.xml`, `npx cap sync`, `lib/location/*`, `lib/homeBeach.ts`, `lib/deviceId.ts`, `components/BeachFinder.tsx`, tests.
- **E (Opus) Plus UI:** `lib/plus/*`, `components/plus/*`, `components/ConditionsDashboard.tsx`, `components/NotifyButton.tsx`, `app/layout.tsx` (mount only), `e2e/plus.spec.ts`.
- **F (Opus) alerts:** `lib/alerts/*`, `lib/push/notify.ts`, `app/api/push/run/route.ts` (after B), `wrangler.jsonc` `vars` only, tests.
- **D (Sonnet) docs, last:** `docs/architecture.md`, `app/privacy/page.tsx`, `lib/changelog.ts`, `docs/HANDOFF.md`.
