# Sky & sea events — "Coming up" card (build plan, no code)

Status: research + plan only, per owner request 2026-09-28. Nothing in this
doc has been implemented. NOT committed — file is untracked in this working
copy. Revision 3: incorporates every required change from Codex's round-2
design review (REVISE, close); source facts re-verified live 2026-09-28
where the changes depend on them (tide datum, LL2 fields/orbit allowlist,
alert defaults, Boca→Cape bearing — see inline citations).

## 1. What we're building

One new card per beach page/app screen, "Coming up," styled like the
existing sunrise/sunset color card (`lib/sunQuality.ts`,
`components/SunQualityCard.*`). **Exactly 3 rows max**, nearest first,
chronological after merging related events into one row (e.g. "Total
eclipse during the full moon" instead of two rows) — but a rare eclipse or
a validated launch reserves a row rather than getting bumped by routine
events. Each row is: event name + local date/time, one short line, and an
optional one-word sky-quality rating (Poor/Fair/Good/Great/Amazing,
`SUN_QUALITY_BANDS` styling). No "tonight" — always an explicit
weekday/date/time (§9, §10). One shared footer: "Forecasts and launch times
can change." The card is **hidden entirely** when there are no genuine
events for that beach — never an empty or placeholder card.

A missing rating is never "check back" — it's a quiet "Forecast later" or
no badge at all (§5).

Owner rules honored throughout: free data only, one card (not a wall of
cards — each event is a row inside the single "Coming up" card, not its own
card), never the words "AI" or "Algae" in any copy, alerts Plus-only.

## 2. Repo facts this plan is built on

- **39 beaches** (fixed from an earlier miscount of 38): 3 hand-curated in
  `config/locations.ts` (Boca Raton, Deerfield Beach, Fort Lauderdale — the
  only ones with `coast`/`coastNormalDeg` set today, confirmed by reading
  the file) + 36 in `config/locations.generated.json` (auto-added, `tier:
  "auto"`, no `coastNormalDeg`/`coast` field on any of them, confirmed
  `node -e` count = 36). All 39 carry `noaaTideStationId` and `timezone`.
  `coastNormalDeg` is not exposed on the client-facing location shape
  (confirmed: no `coastNormalDeg` reference anywhere under `app/`) — any
  code that needs it for a seaward/moonrise check must run server-side
  (§4).
- Proven pattern for "don't hit a rate-limited/heavy source per request":
  `.github/workflows/rip-nwps.yml` + `scripts/rip_nwps.mjs` +
  `lib/sources/ripNwps.ts` — cron job preprocesses, publishes one small JSON
  to its own orphan data branch, app adapter fetches from
  `raw.githubusercontent.com`. **Each feed gets its own branch** — the repo
  has a hard-won lesson here: `sargassum.yml`/`backfill-pct.yml` force-push
  `sargassum-data` as a single-commit orphan every ~10 min and silently wipe
  anything else published there (it happened once already). New branches
  needed: `moon-data` is NOT needed (computed locally, see §4); `launch-data`
  and `king-tide-data` are needed (own orphan branches each, §7).
- **GitHub cron is unreliable, not just slow** — re-read
  `.github/workflows/sargassum.yml`'s own header comment: its `*/10`
  schedule was verified (Aug 26-28 2026) to actually fire only ~4-5x/day at
  unpredictable times, not the ~84x/day the cron string implies. The fix
  already proven there (and in `lightning.yml`): the workflow doesn't read
  once and exit — it loops *inside* the job on its own cadence for as long
  as the job has wall-clock time, with `concurrency: cancel-in-progress:
  true` so a new cron fire replaces rather than duplicates a running loop.
  The launch feed adopts this exact pattern (§7).
- `lib/sunQuality.ts` already has the exact rating scale to reuse: bands
  `dud/plain/good/vivid/epic` → labels **Poor/Fair/Good/Great/Amazing**
  (confirmed current in `SUN_QUALITY_BANDS`), colors. Sky events get their
  own pure `skyVisibilityQuality` function (§5) that reuses only these
  labels/colors, not `sunEventQuality`'s sun-specific horizon/aerosol logic.
- `lib/sources/sun.ts` already computes sunrise/sunset/twilight/golden hour
  locally (NOAA solar-position algorithm, no network) and a **basic**
  `moonPhase()` (synodic-month approximation: phase name + illumination %
  only — no perigee/apogee distance, no moonrise/moonset time, no eclipse
  search). It is not being replaced; the new moon-event code lives
  alongside it.
- `lib/alerts/catalog.ts` is the alert spec/copy/dedupe source of truth;
  `AlertKey` is a closed union in `lib/db/types.ts:9`, and
  `defaultPrefs()` (`lib/db/types.ts:52`) currently turns every key **on**
  by default. Sky events add exactly **one** new key, `"coming-up"`, and it
  is the **first key in the catalog that must default to off** — an
  explicit override in `defaultPrefs()`, not a blanket rule change (§8).
  `tier: "home"` on the existing `score-excellent`/`morning` entries
  (confirmed in `CATALOG`) means "not gated to being physically at the
  beach," not "part of the digest" — `score-excellent` is its own
  standalone push. `coming-up` needs the same distinction made explicit in
  its spec comment so a future reader doesn't assume `tier: "home"` alone
  routes it into the morning message (§8).
- `lib/db/sendClaims.ts` already has the atomic claim model this feature
  extends: `sendClaimKey(deviceId, alertKey, window)`,
  `ABANDONED_CLAIM_MS` (10 min) for reclaiming a crashed run, and
  `CLAIM_RETENTION_MS` for pruning. Sky-event alerts reuse this shape
  rather than inventing a second claim mechanism (§8).
- `lib/alerts/budget.ts`: Workers Free = 50 subrequests/request; the push
  run already reserves margin (`DEFAULT_PUSH_RUN_BUDGET = 44`). Every new
  live fetch this feature adds to a request must be budgeted through the
  same `SubrequestBudget`/`runWithBudget` machinery — see §7.
- `docs/architecture.md` has 3 Mermaid diagrams (request path, scheduled
  jobs, Plus alerts) updated in the same commit as any wiring change — this
  feature touches diagrams 1 and 2, and adds an alert row to diagram 3.

## 3. Event 1 — Tides: validated high-tide flooding, and very-high-tide

**Datum bug caught and fixed in this revision.** The station-datum question
Codex flagged was real: I re-verified live against two stations.
`floodlevels.json` values are published in **STND (station datum)**, not
MLLW — confirmed by comparing Lake Worth Pier (8722670) predictions at
`datum=STND` (H≈33.3-33.7 ft) against its `floodlevels.json` (`nws_minor:
34.35`, same ~33-35 scale) versus the same station at `datum=MLLW` (H≈3.3-3.7
ft, a different vertical reference entirely). Confirmed again at Miami Beach
(8723214): `datum=STND` predictions (H≈12.9-13.0 ft) sit just under its
`nws_minor: 13.66` — a plausible non-flood day on a matching scale. **Every
station's predictions must be fetched at `datum=STND` to compare against its
own `floodlevels.json`** (or the station's own datum, re-checked per
station — never assume MLLW). Also confirmed live: `time_zone=gmt` (not
`time_zone=lst_ldt`) returns UTC timestamps directly, so predictions can be
parsed straight to UTC ISO instants without a local-time round-trip:

```
curl ".../datagetter?begin_date=20260928&range=24&station=8722670&product=predictions&datum=STND&time_zone=gmt&units=english&interval=hilo&format=json"
→ {"predictions":[{"t":"2026-09-28 01:11","v":"33.315","type":"H"}, ...]}

curl ".../mdapi/prod/webapi/stations/8722670/floodlevels.json"
→ {"nos_minor":34.82,...,"nws_minor":34.35,...}   // same STND scale
```

**A threshold is only valid for the exact station that produced the
prediction, and only after a human confirms that station is geographically
representative of the beach.** Coverage check (curled `floodlevels.json`
for all 39 beaches' own prediction stations, live 2026-09-28): only 11 of
39 return a real `nws_minor` (Naples 8725114, Nags Head 8652587, Galveston
8771450, Waikiki 1612340, Myrtle Beach 8661070, Miami Beach 8723214,
Wrightsville Beach 8658163, Santa Monica/Crescent Bay 9410840, La Jolla
9410230, Pismo Beach 9412110, Montauk 8510560) — the rest 404. Boca Raton's
own station (8722816) has no threshold; its documented fallback gauge
(8722670, Lake Worth Pier, 18 mi north) has one, and is the one station
`lib/sources/tides.ts` already treats as Boca's observed-level proxy — but
that precedent is not itself the "manual approval" Codex requires. Each
borrowed pairing (predictions station + threshold station, always the
*same* station so datum never mixes) needs its own explicit, hand-reviewed
`representative: true` flag in config before it's alert-eligible — never
auto-approved from proximity alone.

**Two card-eligible tiers, only one alert-eligible:**
1. **Validated flood-threshold crossing** (only stations flagged
   `representative: true`): predicted high ≥ that station's `nws_minor`
   (fallback `nos_minor` if NWS is null), same datum throughout →
   **"High-tide flooding possible."** Copy: *"The predicted astronomical
   tide reaches this station's minor flood level. Wind and weather can
   change the actual water level."* This is the **only** tide event that
   can trigger a push alert.
2. **Very-high-tide** (all 39 beaches, card-only, never alert-eligible):
   predicted high in the **top 1% of that station's own predicted highs**,
   computed from a fixed **station-local calendar-year** distribution (Jan
   1-Dec 31, not a rolling 365 days) — the feed fetches and precomputes the
   percentile for **both the current and the next station-local calendar
   year** (mirroring the meteor-shower table's current+next-year rule, §6),
   so a January event doesn't fall through a year-boundary gap late each
   December. A full year of `interval=hilo` predictions per station is
   **~700-1,500 rows** (semidiurnal stations run 2 highs + 2 lows/day,
   ~350-750 highs/year — not the ~370 total rows this doc assumed earlier),
   still the same "fetch-once, republish small" job the rip-nwps
   pattern was built for (§7). Copy: **"Very high tide — in the top 1% of
   predicted highs this year."** Never call this a "king tide" — that word
   is reserved for a date NOAA or a local authority's own tide calendar
   explicitly names as one; nothing here does that naming.

**Episode grouping — a deterministic merge rule, not a loose window**:
qualifying highs (either tier, at the same station) merge into one episode
when consecutive highs are **≤30 hours apart**; a merge chain stops, and a
new episode starts, once the running span from the episode's first high
would exceed **72 hours** total — so a long run of closely-spaced highs
still splits into bounded episodes instead of one card row spanning a
week. One card row per episode, spanning its first-to-last qualifying high,
not one row per high tide.

**Freshness**: every tide event carries the feed's own `validThrough`
timestamp and is only shown while still within it. Card data is shown from
a feed up to **30 days old**; a validated flood-threshold crossing is only
**alert**-eligible (§10) when sourced from a feed **≤14 days old** — a
tighter bar than the card's, since a push claims something actionable is
about to happen.

Beaches with neither a validated threshold nor a usable station get the
event omitted for them silently, same convention `ripNwps.ts` already uses
for unmapped beaches (never a fabricated placeholder).

## 4. Event 2 — Moon (full moon, supermoon, lunar eclipse, moonrise)

**Library decision unchanged: `astronomy-engine` (MIT, cosinekitty/astronomy,
npm 2.1.19, confirmed still current).** Bundlephobia: 105 KB minified / 42.5
KB gzip, zero dependencies — not yet a `package.json` dependency, confirmed.
Ships `SearchLunarApsis`/`NextLunarApsis` (perigee/apogee), `SearchLunar
Eclipse`/`NextLunarEclipse` (kind, magnitude, peak, and per-phase semi-
durations), `SearchMoonQuarter` (exact full-moon instants), `Illumination`
(phase %), `SearchRiseSet`/`Horizon` (moonrise time + azimuth). Everything
below is computed locally, deterministically — **server-only**: it never
ships in a client bundle (§7 acceptance criteria). NASA's GSFC eclipse
catalog and timeanddate.com remain citations for testing cross-checks, not
runtime dependencies.

**Definitions:**
- **Full moon**: `SearchMoonQuarter` quarter `2`.
- **Supermoon — Nolle closeness ratio, not a day-count proxy.** Codex
  correctly rejected "within one day of perigee" as too loose a proxy for
  Richard Nolle's actual definition. Use the ratio directly: find the
  full-moon instant and Earth-Moon distance; from `SearchLunarApsis`, take
  the perigee and apogee **bracketing that same anomalistic cycle** (the
  Moon's perigee-to-perigee orbit, ~27.55 days — not just "the nearest
  apsis in each direction," which can straddle two different cycles near a
  cycle boundary); compute
  `closeness = (apogee − fullMoonDistance) / (apogee − perigee)`; flag
  supermoon when `closeness ≥ 0.90`. Never say "closest and brightest of
  the year" — say **"closest full moon of the year"** (brightness isn't
  independently ranked) — and only when this full moon's distance is
  actually the year's minimum among all flagged supermoons — rank them and
  only the #1 gets that line. Test fixtures cross-check computed supermoon
  dates against a cited reference list (e.g. timeanddate.com's published
  supermoon calendar) for known years, not just internal consistency.
- **Lunar eclipse**: `SearchLunarEclipse` gives kind (penumbral/partial/
  total) and peak time plus each phase's semi-duration. **Only partial and
  total are shown — penumbral is never surfaced** (too subtle to be a
  "sky event" a beachgoer would notice). Compute the phase's contact
  interval — `[peak − semiDuration, peak + semiDuration]` for the partial
  or total phase, whichever is being shown — and, separately, the
  interval(s) where the Moon's altitude at the beach is ≥5° (a `Horizon()`
  sweep across the window, not a single point-in-time check). **Intersect
  the two.** The eclipse is only shown if that intersection is **≥15
  minutes** long. The card displays the **visible local interval** — the
  intersection's own start/end — not the eclipse's full, un-intersected
  duration. Copy says *"peak 1:58 AM"* only when the peak instant itself
  falls inside the visible interval; otherwise it says *"visible here from
  1:10-1:42 AM"* with no peak time claimed (§12 has both copy forms). Both
  the eclipse's sky-visibility rating (§5) and the alert-eligibility check
  (§10) are evaluated over this same visible interval.
- **Full-moon/supermoon viewing window — computed for every beach,
  regardless of shore-normal review.** The window is **the first nighttime
  interval near the full-moon instant where the Moon's altitude is ≥5°**
  (a `Horizon()` sweep starting at moonrise or at dusk, whichever is
  later, ending at moonset or dawn, whichever is earlier) — this is what
  §5's rating samples and §10's alert-eligibility check tests against, for
  **all 39 beaches**. It exists independently of `coastNormalDeg`.
- **"Over the water" copy — gated separately, curated beaches only.**
  Whether the copy may say *"rises over the water at 7:12 PM"* (moonrise
  bearing lands seaward of the beach) is a **second, independent check**
  layered on top of the viewing window above, and it's the only piece that
  needs a manually reviewed shore normal — today that's the 3 beaches with
  `coastNormalDeg` set (Boca Raton, Deerfield, Fort Lauderdale), confirmed
  live. Because `coastNormalDeg` isn't on the client-facing location shape
  (§2), this seaward check runs server-side, using the **circular** angle
  difference (bearings wrap at 360°): `min(|moonriseAzimuth −
  coastNormalDeg|, 360 − |moonriseAzimuth − coastNormalDeg|) ≤ 30°` — a
  naive absolute-difference check would wrongly reject, e.g., a
  350°-vs-10° pair that's actually 20° apart. The server attaches a
  precomputed boolean/line to the event, not the raw bearing math, to the
  client. Where it passes, full-moon copy **leads with the local moonrise
  time**: *"rises over the water at 7:12 PM"* is the first clause, not an
  afterthought after the phase name. The other 36 beaches still get the
  full moon/supermoon/eclipse event, viewing window, and rating — just
  without the "over the water" line — until their shore normals are
  reviewed and added (data entry, not research, tracked in §11).

## 5. Sky-visibility rating (shared across all event types)

A new, pure `skyVisibilityQuality` function — **not** a repurposing of
`sunEventQuality`'s sun-specific curve, since that curve is tuned for
color-at-the-horizon, not "can you see the sky at all." Rules: a clear sky
scores best; added cloud cover monotonically lowers the score (no
non-monotonic bumps); precipitation, fog, or heavy low cloud caps the score
at "Poor" outright regardless of the rest of the mix. It reuses only the
existing `Poor/Fair/Good/Great/Amazing` labels and colors from
`SUN_QUALITY_BANDS` — a new scoring curve, same presentation layer.

Each event type samples the **nearest actual forecast hours to its own
relevant observing window**, not a fixed lookup: a rocket launch uses the
most conservative (worst-case) hour across its launch window; a meteor
shower uses the best local interval where the shower's radiant is above
the horizon *and* the sky is dark (post-dusk, pre-dawn); a lunar eclipse,
full moon, and supermoon are each rated over their own **local
visible/viewing interval** (§4 — the eclipse's intersected visible window,
or the universal ≥5°-altitude viewing window for full moon/supermoon,
computed for all 39 beaches regardless of shore-normal review) rather than
a single instant; any other event uses the single nearest hour to its
instant. A moonlight penalty applies
**only when the Moon is actually above the horizon** during that window
(an `Illumination` × `Horizon` check together, not illumination alone) —
illumination >70% while the Moon is up caps the rating at "Fair" regardless
of cloud, the same rule as before, just gated correctly.

If the event falls outside the forecast horizon (Open-Meteo
`forecast_days=7`, `lib/sources/hourlyForecast.ts:154`) or the relevant
hourly rows are simply missing, the event shows with **no badge at all** —
never a guessed rating, and never the word "check back" (§1); the quiet
fallback line is "Forecast later."

## 6. Event 3 — Meteor showers

No live API — a static yearly calendar of the 7 major showers (IMO Meteor
Shower Calendar, imo.net/resources/calendar, and the American Meteor
Society's list, amsmeteors.org/meteor-showers/meteor-shower-calendar/, both
free/public, cited in the config file's header comment). Each shower entry
stores, per supported year: exact UTC peak instant, activity-window start/
end, the source edition/year it was transcribed from, and radiant
coordinates (RA/Dec) — not just a peak date — so the "radiant above horizon"
check in §5 has real inputs. `config/meteorShowers.ts` always carries data
for the **current year and the next year**; a CI check fails the build if
either is missing. A year outside the supported table is simply omitted for
that shower, never extrapolated. "Best after midnight" is computed per
beach from the shower's local activity window and the beach's own
sunrise/moonset, not hard-coded.

## 7. Event 4 — Rocket launches

**Source, verified live 2026-09-28** (id, net, net_precision, status,
pad.id, pad.location.id, and last_updated all present and stable):

```
curl "https://ll.thespacedevs.com/2.3.0/launches/upcoming/?mode=detailed"
→ {"id":"7d1afb26-...","net":"2026-09-28T12:15:00Z",
   "net_precision":{"name":"Minute"},"status":{"name":"Go for Launch","abbrev":"Go"},
   "pad":{"id":235,"location":{"id":143}}, "last_updated":"2026-09-28T03:40:54Z"}
```

**Fetch all launches in the next 14 days, not `limit=3`** — the old plan's
`limit=3` would silently drop launches beyond the third-soonest even when
several are within the window; the adapter fetches the full 14-day set and
lets card selection (§1) do the trimming. Match pads by **`pad.id`/
`pad.location.id`**, not by parsing the pad name string, so a range's
launches are never missed or double-counted from a name-format change.

**Validation before a launch is usable at all**: `net`, `window_start`/
`window_end`, `net_precision`, `status`, `pad.id`, `pad.location.id`, the
launch `id`, and `last_updated` must all be present and well-formed;
**reject** any launch whose `status.abbrev` is `Cancelled`, `Success`
(completed), `Failure`, or otherwise ended — only upcoming/active statuses
are shown.

**Range-specific eligibility** (per pad, cited to each range's public
location): **≤50 mi** — any launch, day/twilight/night. **50-200 mi** —
only *known orbital* launches, and only when the **observer's own** solar
altitude is below 0° (below the day/twilight line) at `net` — a daytime
150 mi launch is not shown, too faint to be visible regardless of the
pad's own light state. **>200 mi** — omitted entirely for v1, no exception.
This replaces the earlier flat "~300 mi night / ~50 mi day" radius pair
with the tiered rule above.

**"Known orbital," precisely**: a launch counts as orbital only when LL2's
own `mission.orbit` field (confirmed present, e.g. `{"name":"Low Earth
Orbit","abbrev":"LEO"}`) matches a small **allowlist** of named orbit
classes (LEO, MEO, GEO/GTO, SSO, HEO, etc.) — never inferred from the
rocket or mission name. A launch with a missing or unrecognized
`mission.orbit` is **excluded** at the 50-200 mi tier (treated as
not-known-orbital), never assumed orbital by default.

**Where to look**: the **great-circle bearing from the beach to the pad**
(a standard bearing calculation from the two known lat/lons), never a
"typical corridor azimuth" guess — that only gets mentioned as a
supplementary line, and only when a specific launch has an authoritative,
launch-specific published corridor (a range's own environmental filing for
that mission), not a generic per-pad table.

**Twilight, computed correctly**: solar altitude at the observer's location
and separately at the pad's location, both evaluated at the launch's own
`net` time — not a golden-hour window borrowed from `lib/sources/sun.ts`'s
local sunrise/sunset, since the observer and the pad can be in different
light states at the same instant. Three states, by solar altitude: **day**
= altitude ≥0°; **twilight** = −18° to <0° (civil+nautical+astronomical
twilight banded together); **night** = altitude <−18°. Copy for a twilight
launch: **"Twilight launch — a bright plume may be visible."** No
"jellyfish" language and no promise of what the plume will look like.

**Card display**: a countdown is shown **only** when `net_precision` is
`Minute` *and* the window is still in the future; anything coarser shows
**"[date/month] — time not set"**, no misleading countdown. `Hold` status
is shown **without** a countdown regardless of precision (a hold with a
stale minute-precision `net` would otherwise show a countdown ticking past
zero). The **same LL2 UUID always updates the same card row in place** —
a scrub/reschedule never spawns a duplicate.

**Alert eligibility** (separate, stricter gate than card display): only
when status is `Go`, `net_precision` is `Minute`, the feed itself is ≤45
minutes old at evaluation time (§8), and `net` is **2-12 hours ahead** of
now — far enough to be actionable, close enough to still be true. Copy uses
**"targeting"** wording ("SpaceX is targeting a 9:15 PM launch..."), never
a flat promise. **One alert per launch UUID, ever** — its lifetime, not per
day or per repeat window (§8's dedupe key enforces this).

## 8. Feed freshness — the long-running-loop pattern, per feed

GitHub's cron is unreliable, not just coarse (§2's re-read of
`sargassum.yml`'s header). The launch-feed workflow (and any other feed on
a cadence tighter than cron reliably delivers) uses the same fix already
proven for `sargassum.yml`/`lightning.yml`: once a run starts, it **polls
LL2 every 30 minutes for about 5 hours inside the same job**, with a
**unique `concurrency` group that cancels the previous loop** when a new
one starts, so overlapping fires never double the request rate. At 30-min
cadence this stays comfortably under LL2's published ~15 requests/hour
unauthenticated limit even counting retries.

**On failure, never republish stale data under a fresh `generatedAt`** — a
failed or partial pull leaves the last good publish in place untouched. A
**successful empty result** (genuinely zero qualifying launches right now)
*is* publishable with a fresh `generatedAt` — empty is a valid, honest
state; a failed fetch is not.

**Adapter-side staleness gates**: feed older than **6 hours** → hide
launches from the card entirely (don't show a launch that might have
scrubbed hours ago with no update). Feed older than **45 minutes** → no
launch *alerts* fire, even if the card still shows the (still-under-6h)
data — alerts need fresher data than the card does.

Each feed (`launch-data`, `king-tide-data`) publishes to its **own** orphan
data branch — never shared with `sargassum-data` or any other feed's
branch, per the force-push wipeout lesson in §2.

## 9. Card composition, SSR, and budget

- **SSR/hydration safety**: the existing snapshot convention, no
  exceptions. Every displayed time and every event-selection decision is
  computed against the conditions snapshot's own `generatedAt` — never
  `Date.now()`/`new Date()` inside a render or selection helper. All
  instants are stored and passed as UTC ISO; formatting into the beach's
  own IANA timezone happens only at the display edge. Astronomy-engine and
  tide/launch selection all take the snapshot's pinned instant as an
  explicit argument, same as `lib/sources/sun.ts`'s
  `computeSunTimes(lat, lon, y, m, d)`.
- **Fetch ordering**: launch and tide feeds are fetched **after** the core
  conditions sources, and only **in parallel with each other** when the
  push-run's subrequest budget still has **≥2 slots** left at that point;
  otherwise the build omits sky-event card data for that run rather than
  starving a core source. Both feeds go through the same counted-fetch
  seam and in-flight shared cache pattern `lib/sources/ripNwps.ts` already
  uses, and the push stage loads each feed **once per run**, never once
  per beach — no extra full-conditions builds are triggered just to
  populate this card.
- **Untrusted feed JSON**: both feeds are treated as untrusted input at the
  adapter boundary — schema/version check, a size limit, timestamp
  sanity, coordinate-range sanity, enum allowlists on status/precision
  fields, string cleanup, and a completeness check before any row is used.
- **Subrequest cost**: at most 2 extra outbound fetches per conditions
  build, both budgeted through `SubrequestBudget`/`runWithBudget`: one
  small `launch_data.json` and one small `king_tide_data.json`, both from
  `raw.githubusercontent.com`, same shape/cost as today's `rip_nwps.json`
  fetch. Moon and meteor-shower events cost zero extra fetches (pure local
  computation).
- **`astronomy-engine` is server-only** — acceptance criteria before this
  ships: before/after OpenNext bundle size comparison, `wrangler deploy
  --dry-run` passes, a grep/bundle-analysis confirms no astronomy-engine
  code reaches a client chunk, a CPU-time benchmark across all 39 beaches
  × 14 days of events completes within budget, and computed astronomy
  values are cache-deterministic keyed by date + location (same inputs,
  same outputs, safe to cache).

## 10. Alerts (Plus-only, capped, genuinely new mechanism)

**One new preference, `coming-up`, defaulting FALSE** — the only entry in
`AlertPrefs` that starts off; every existing key defaults on
(`defaultPrefs()`, `lib/db/types.ts:52`), and this one is an explicit,
commented override, not a rule change.

**Exactly one new `AlertKey`, not five.** `"coming-up"` is the single new
entry in the closed union (`lib/db/types.ts:9`) and gets **exactly one**
`lib/alerts/catalog.ts` `CATALOG` spec (`tier: "home"` — the spec's own
comment says plainly that here that means "not at-beach," not "part of the
morning digest," §2). What varies across the 5 sky-event kinds is the
**`AlertSubject`**: one new subject variant carrying an `eventType:
"eclipse" | "tide" | "meteor" | "supermoon" | "launch"` discriminant, with
five copy/dedupe branches switched on that field *inside* the one spec —
not five separate keys or specs.

**Selection**: at each 8:00 AM beach-local run, check eligibility per
`eventType` against the window `[current 8:00 AM, next 8:00 AM)` — i.e.
today's send through the instant just before tomorrow's — then pick **at
most one** eligible event by priority (**eclipse > validated
flood-threshold crossing (§3's tier 1 only — never the very-high-tide
tier) > major meteor peak > supermoon > launch**):
- **eclipse** — eligible when its visible interval (§4's intersection)
  **overlaps** `[current 8:00 AM, next 8:00 AM)` at all (it may already be
  under way at 8:00, or start later that window).
- **tide** — eligible when the episode's first qualifying high is
  **6-30 hours** ahead of this 8:00 AM run (an explicit range, not a
  window-overlap test).
- **meteor** — eligible when the shower's best local observing window
  (§5/§6) **starts within** `[current 8:00 AM, next 8:00 AM)`.
- **supermoon** — eligible when the universal ≥5°-altitude viewing window
  (§4) **starts within** `[current 8:00 AM, next 8:00 AM)`.
- **launch** — unchanged from §7: **2-12 hours** ahead of now, `Go`,
  `Minute` precision, feed ≤45 min old (an explicit range, like tide).

If the morning digest is already being sent to this device at 8:00, the
selected event is **appended to that same push**, not a second
notification. If the morning digest is off but `coming-up` is on, the
device gets **one standalone push at 8:00** instead. **No overnight
delivery** — an event that only becomes eligible outside an 8:00 AM run
simply gets no push that cycle; there is no separate ad-hoc send path for
sky events.

**Global caps**: **≤3 sky-event pushes per rolling 30 days**, and **≤1 per
24 hours**, per device — counting every **inclusion** of a sky event,
whether appended to the morning digest or sent as its own standalone push,
identically. An appended inclusion is not free; it counts against both
caps the same as a standalone push would.

**Dedupe keys** (the `event_key` the ledger below is keyed on, plus each
event's own `AlertSubject.eventType` branch, §10 above), each scoped to
avoid re-alerting the same underlying event:
`tide:<station>:<episode-start>`, `eclipse:<peak-iso>`,
`meteor:<shower>:<year>`, `supermoon:<full-moon-iso>`, `launch:<ll2-uuid>`
(§7 — one alert per UUID's whole lifetime, never per repeat window).

**Durable cap ledger — a new table, not a reuse of `send_claims`.**
`lib/db/sendClaims.ts`'s existing claims are pruned after
`CLAIM_RETENTION_MS` (3 days) — too short to answer "how many sky-event
pushes has this device had in the last 30 days," so `coming-up` gets its
own D1 table, **`coming_up_deliveries`**: `device_id`, `event_key` (the two
together are UNIQUE — one row per device per underlying event), `claimed_at`,
`sent_at` (null until confirmed), and a `claim_token`/status column.

An atomic claim **rejects on two independent grounds**: (a) `event_key`
already has a row in `alert_log` for this device — the once-ever dedupe
(§10's dedupe keys) that must survive `coming_up_deliveries` pruning, since
`alert_log` is the durable record, not this ledger; and (b) granting the
reservation would push `sent_at IS NOT NULL` rows **plus** still-live
(non-abandoned) reservations, within the trailing 24-hour or 30-day
windows, over the cap. Both checks and the reservation insert happen in
one atomic D1 statement. On send failure the reservation is **released**
immediately (only if the caller's token matches the stored one — see
below); if the run never reports back it **expires** on its own after the
same abandonment window `sendClaims.ts` already uses (`ABANDONED_CLAIM_MS`).
On confirmed success, setting `sent_at` and writing the `alert_log` row
happen together **in one D1 batch**, so a crash between the two can never
leave the ledger and the durable dedupe record disagreeing. **Device
deletion removes this device's rows**, same as every other per-device
table. **Pruning removes two kinds of row**: successful rows older than
**30 days** (the ledger's own retention window, distinct from
`send_claims`'s 3-day one, since the cap math needs the full 30-day
history), and abandoned **unsent** rows (past `ABANDONED_CLAIM_MS` with no
`sent_at`) regardless of age, so a crashed reservation doesn't sit forever.

**Store contract** (mirrors `sendClaims.ts`'s shape; every clock is an
explicit `nowMs` parameter injected by the caller — **no `Date.now()`
inside any store method**, same SSR-safety rule as §9):
- `claimComingUp(deviceId, eventKey, claimToken, nowMs)` — atomically
  reject-if-already-in-`alert_log` or reject-if-over-cap (24h/30d, computed
  against `nowMs`), else insert the reservation with the given token.
- `completeComingUp(deviceId, eventKey, claimToken, nowMs)` — only when the
  stored `claim_token` for this row matches the one passed in; sets
  `sent_at = nowMs` and writes the `alert_log` row in one D1 batch.
- `releaseComingUp(deviceId, eventKey, claimToken)` — only when the stored
  token matches; deletes or marks the reservation released immediately.
- `pruneComingUp(nowMs)` — deletes successful rows older than 30 days
  (relative to `nowMs`) and abandoned unsent rows past
  `ABANDONED_CLAIM_MS`, called on the same cadence other pruning already
  runs on.

The token match on complete/release exists so a second, racing caller that
doesn't hold the current reservation can never finalize or clear someone
else's claim.

**Scope of this phase's changes** (full list, so nothing is assumed
implicit): `lib/db/types.ts` (the one new `AlertKey` + `defaultPrefs()`
override), `lib/alerts/catalog.ts` (the one new spec + its 5 `eventType`
copy/dedupe branches), `lib/db/store.ts`/`d1Store.ts`/`memoryStore.ts` (the
four `*ComingUp` functions + the `coming_up_deliveries` table/in-memory
equivalent), a new D1 migration, device-deletion cleanup for the new table,
device API preference validation (the `coming-up` key round-trips through
the same validation the other 11 keys already go through), the settings UI
(a new toggle, off by default), `lib/plus/labels.ts` (whatever
subscriber-facing label the new toggle needs), the push route's 8:00
selection + append-vs-standalone logic, and tests for every piece above
(§13's Crew G owns this list in full).

## 11. Honest limitations (surface these in the UI, not just here)

- **Clouds**: the rating is a forecast, not a promise — 7-day cloud
  forecasts are meaningfully less reliable past ~3 days; the card's footer
  ("Forecasts and launch times can change.") covers this, no per-event
  caveat needed.
- **Scrubs**: rocket launches slip constantly; `status`/`net_precision`
  copy (§7) is the honesty mechanism, not a guarantee.
- **Light pollution**: none of these sources account for it; a meteor
  shower or moonrise rated "Amazing" for sky clarity can still be a
  washout at a boardwalk-lit beach. Out of scope for v1, no free
  machine-readable source at beach-level granularity.
- **Flood-threshold coverage**: only 11/39 beaches have a station with a
  published threshold, and of those, only the ones a human has flagged
  `representative: true` (§3) are alert-eligible — the rest of the 39 get
  the card-only very-high-tide tier. The two tiers use visibly different
  copy so a subscriber never reads percentile-tier confidence into a
  threshold-tier claim, or vice versa.
- **"Over the water" copy**: the full-moon/supermoon viewing window and
  rating are computed for all 39 beaches (§4), but the *"rises over the
  water"* line only appears at the 3 beaches with a manually reviewed
  `coastNormalDeg` today; extending it to more beaches is a data-entry
  pass (reviewing and adding a shore normal per beach), not a research
  problem, and each addition needs the same manual review before it's
  trusted.
- **Launch visibility**: the range tiers (§7) are heuristics cited to
  commonly reported viewing guides, not an authoritative NASA/FAA
  visibility model (none exists as a free API) — worded as "may be
  visible," never "will be visible."

## 12. UI copy examples (plain English, no "AI"/"algae")

- Validated flood crossing: "High-tide flooding possible Thu Oct 15, 11:42
  AM. The predicted astronomical tide reaches this station's minor flood
  level. Wind and weather can change the actual water level."
- Very-high-tide (card-only): "Very high tide Thu Oct 15, 11:42 AM — in the
  top 1% of predicted highs this year."
- Full moon: "Full moon, Fri Oct 3 — rises over the water at 7:12 PM. Sky
  rating: Great — clear skies expected."
- Supermoon (ranked #1 only): "Supermoon Fri Oct 3, rises over the water at
  7:12 PM — the closest full moon of the year."
- Supermoon (not ranked #1): "Supermoon Fri Oct 3, rises over the water at
  7:12 PM."
- Lunar eclipse (peak visible): "Total lunar eclipse Sun Mar 8, peak 1:58
  AM, visible here. Sky rating: Good."
- Lunar eclipse (peak not visible, partial window is): "Partial lunar
  eclipse Sun Mar 8 — visible here from 1:10-1:42 AM. Sky rating: Good."
- Meteor shower: "Perseids peak Wed Aug 12, best after midnight. Sky
  rating: Fair — a bright moon will wash out the fainter meteors."
- Rocket launch (twilight, from Boca Raton): "SpaceX Falcon 9 launch window
  9:15-10:30 PM Wed Oct 8 from Cape Canaveral, bearing 349° (nearly due
  north). Twilight launch — a bright plume may be visible. Status: Go."
- Rocket launch (coarse precision): "SpaceX launch targeting October from
  Cape Canaveral — time not set."
- No badge (missing forecast): "Full moon Fri Oct 3, 7:12 PM. Forecast
  later."

## 13. Phased build, file ownership (disjoint files for parallel crews)

**Phase 0 — shared contract (one owner, blocks nothing but itself, lands
first; DONE — see below):**
- `lib/skyEventsTypes.ts` (new — defines the **sky-event domain types
  only**; dependency-free except that it **imports the canonical
  `Wrapped<T>`** from `lib/types.ts` rather than redefining it): the
  merged event union (tide/eclipse/full-moon/supermoon/meteor/launch), and
  the `eventType` discriminant §10's `AlertSubject` variant also uses.
  Every later crew imports from here instead of agreeing on
  shapes ad hoc; changing it after Phase 1 starts means re-coordinating
  every crew, so it lands, reviewed, before Phase 1 begins.

**Phase 1 — data plumbing (can run in parallel, no shared files):**
- Crew A: `config/meteorShowers.ts` (new — peaks, windows, source edition/
  year, radiant coords, current+next year, CI-checked) + `lib/sources/
  meteorShowers.ts` (adapter) + tests.
- Crew B: `lib/sources/moonEvents.ts` (new — wraps astronomy-engine:
  full moon, Nolle-ratio supermoon, eclipse contact-interval visibility,
  moonrise) + **both** `package.json` **and** `package-lock.json` (the
  dependency add) + tests. Owns the one shared dependency addition —
  coordinate before anyone else assumes it's installed.
- Crew C: `config/launchPads.ts` (new — the 4 ranges' pad/location IDs and
  range-tier rules, §7) + `scripts/launch_library.mjs` (new preprocess
  script — **one-shot per invocation**; it fetches once and exits) +
  `.github/workflows/launch-library.yml` (new, `launch-data` branch — the
  workflow, not the script, owns the 5-hour/30-minute loop, §8, calling the
  one-shot script on each cycle) + `lib/sources/launchLibrary.ts` (adapter
  — pad/location-id matching, great-circle bearing, orbit-allowlist,
  validation) + tests.
- Crew D: an explicit tide config (e.g. `config/tideStations.ts`, new —
  per-beach prediction-station mapping and the hand-reviewed
  `representative: true` flag from §3, seeded before the script needs it)
  + `scripts/king_tide.mjs` (new preprocess script — STND-datum-matched
  predictions, current+next-year calendar percentile, deterministic
  episode merge) + `.github/workflows/king-tide.yml` (new,
  `king-tide-data` branch) + `lib/sources/kingTide.ts` (adapter) + tests.

**Phase 2A → 2B — rating, then card (2B depends on 2A's interface, not its
implementation; 2A's function signature is frozen before 2B starts
writing against it):**
- Crew E (2A): `lib/skyVisibilityQuality.ts` (new — pure clear-sky-best/
  cloud-monotonic/precip-cap rating, §5, including the eclipse/full-moon/
  supermoon visible-interval sampling) + tests. Its exported signature is
  the interface Crew F builds on.
- Crew F (2B, starts once Crew E's signature is frozen): `lib/skyEvents.ts`
  (new — merges all 4 sources into one ordered, 3-row-capped,
  episode-grouped "Coming up" list, using Crew E's rating function) +
  `components/SkyEventsCard.tsx` (new) + tests.

**INTEGRATION — a dedicated crew wiring the card into the app (after
Phase 1's adapters and Phase 2B's aggregator both exist; touches shared
high-blast-radius files no data/rating crew should also be touching):**
- Crew H: `lib/conditions.ts` (wires `skyEvents` into the conditions
  build, §9's fetch-ordering/budget rules), `lib/types.ts` (the snapshot
  shape gains the sky-events field), `components/ConditionsDashboard.tsx`
  (renders `SkyEventsCard`), and integration tests covering the whole
  wired path (not unit tests of an individual adapter — those stay with
  Phases 1/2). Crew H owns the **existing, shared** snapshot/API/page
  fixtures the rest of the app's tests already pin — it edits those, Crew
  G does not. Does **not** touch `docs/architecture.md` (see the final
  phase below).

**Phase 3 — alerts/prefs/claims (its own crew — larger scope than a single
file, touches shared high-blast-radius files, done after Phase 2B's event
shapes exist; can run alongside INTEGRATION, not blocked by it):**
- Crew G: `lib/db/types.ts` (the **one** new `AlertKey` + `defaultPrefs()`
  override), `lib/alerts/catalog.ts` (the **one** new spec + its 5
  `eventType` copy/dedupe branches, §10), `lib/db/store.ts` /
  `d1Store.ts` / `memoryStore.ts` (the four `claimComingUp`/
  `completeComingUp`/`releaseComingUp`/`pruneComingUp` functions and the
  new `coming_up_deliveries` table/in-memory equivalent, §10), a new D1
  migration + device-deletion cleanup for that table, device API
  preference validation for `coming-up`, the settings-UI toggle,
  `lib/plus/labels.ts` (the toggle's subscriber-facing label), the push
  route's 8:00 selection/append-vs-standalone logic, and tests for every
  piece above. Crew G's tests use **new, alert-local fixtures** (its own
  `coming-up`-scoped test data), never the shared snapshot/API/page
  fixtures Crew H owns — while INTEGRATION and Phase 3 run concurrently,
  **neither crew edits the other's test files**. Single-owner because
  `catalog.ts`/`types.ts`/`store.ts` are shared, high-blast-radius files
  every other alert type also touches. Does **not** touch
  `docs/architecture.md`.

**Phase 4 — integration/documentation + verification (ONE owner, only
after both INTEGRATION (Crew H) and Phase 3 (Crew G) have landed):**
- `docs/architecture.md` — **all** diagram updates (1, 2, and 3) happen
  here, in one pass, by one owner, after both crews' actual wiring exists
  to document — not split across their commits, so the diagrams describe
  the real merged state instead of each crew's guess at the other's shape.
- `lib/changelog.ts` entry, README/AGENTS.md/CLAUDE.md mention if the
  source-adapter list is enumerated there, `config/locations.ts`/
  `.generated.json`/the Phase 1 config files gain whichever
  `coastNormalDeg`/`representative` flags weren't already seeded (data
  entry, flagged not blocking), and the full test matrix: DST spring/fall
  transitions, year rollover, a Hawaii beach, a Pacific beach, an Eastern
  beach, stale feeds (>45 min, >6 h, and the tide-specific >14 d/>30 d
  gates from §3), failed and partial publishes (old data kept), a
  successful-empty publish (accepted), scrubbed launches, an eclipse
  visible only before/after its own peak (or not at all, §4's ≥15-min
  intersection), Moon below horizon during an eclipse window, and missing
  forecast hours (no-badge path).

No file is written by two crews in the same phase. Phases mostly wait on a
boundary rather than a specific crew — any crew within Phase 1, or Crews G
and H, finishing in any order is fine — with two explicit exceptions:
Phase 0 blocks all of Phase 1, and within Phase 2, Crew F (2B) waits on
Crew E's (2A) frozen interface, not on Phase 2 as a whole. Phase 3 remains
intentionally separate from INTEGRATION, not folded into it, because the
alert/pref/claim surface (D1 + memory store + migration + device API +
settings UI + catalog + push route + claims + tests) is large enough to
need dedicated, undistracted ownership, even though both crews can run
side by side once their shared prerequisites (Phase 1 + Phase 2B) land.
