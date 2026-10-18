# Lighter page: payload and JavaScript (branch `perf-payload`)

Goal from the owner: the whole page, with all its data, in about 50 ms, and nothing broken.
This part makes the page lighter to download, parse and paint. Caching (`perf-edge-cache`)
and the service worker (`perf-sw`) are separate.

All "after" numbers come from one local production build (`next build` + `next start`),
measured against a build of `main` at `a567da23`. Local numbers show the size of the change.
They are not the production numbers. Run `scripts/perf_probe.sh` and
`node scripts/perf_page_probe.mjs https://app.isitbeachday.com / 9 phone` after a deploy.

## Result

| Measure (Boca Raton home page) | Before | After | Change |
|---|---:|---:|---:|
| Snapshot sent to the browser (JSON, bytes) | 160,849 | 53,876 | -66% |
| Same, brotli | 13,028 | 10,536 | -19% |
| Home HTML, uncompressed | 475,954 | 279,303 | -41% |
| Home HTML, brotli | 50,045 | 33,957 | -32% |
| Home HTML, gzip | 70,963 | 46,183 | -35% |
| RSC flight payload in the HTML | 202,632 | 82,288 | -59% |
| Server-rendered markup in the HTML | 269,731 | 194,540 | -28% |
| First-load JS for `/` (Next build report, gzip) | 276 kB | 222 kB | -20% |
| Largest app chunk (gzip) | 148.5 kB | 94.3 kB | -36% |
| Data download right after load | 158.7 kB | 0 | -100% |
| Share-card warm-up download | 2 PNGs, ~256 kB | 0 (HEAD) | -100% |

Browser probe (Chromium, iPhone 390 px, empty cache, PostHog loading as for a real visitor,
median of 9 runs; raw output in `payload-probe-raw.txt`):

| | Before | After |
|---|---:|---:|
| **Fast 3G + 4x CPU:** first/largest paint (LCP) | 728 ms | 636 ms |
| Fast 3G + 4x CPU: React finished hydrating | 2401 ms | 2049 ms |
| Fast 3G + 4x CPU: load event | 2178 ms | 1865 ms |
| Fast 3G + 4x CPU: bytes on the wire (local gzip) | 647 kB | 412 kB |
| Fast 3G + 4x CPU: JavaScript on the wire (incl. PostHog + Cloudflare beacon) | 389.5 kB | 337 kB |
| **Unthrottled:** LCP | 104 ms | 100 ms |
| Unthrottled: hydrated | 207 ms | 178 ms |
| Layout shift (CLS) | 0 | 0 |

Why LCP moved less than the bytes: the largest paint is the verdict text, which is in the
server HTML, so it waits only for the HTML and one 10 kB stylesheet. On a phone the time
before the page is *interactive* is mostly JavaScript download, and that is where the
saving shows (hydration 350 ms sooner). The server HTML already carried the score, verdict
and key factors before this work. The probe checks on every run that the verdict is in the HTML.

## What was in the payload

The home page sent the full conditions snapshot twice: once as rendered markup, and once as
RSC props (`initial=` for `ConditionsDashboard`) so the client could hydrate. The same
snapshot was then downloaded a third time by SWR the moment the page loaded.

Props for Boca, before (160,849 bytes for `initial`, plus 11 kB for `beaches`):

| Part | Bytes | Note |
|---|---:|---|
| `snapshot.hourly.data` | 78,398 | 216 hourly rows, every key repeated on every row |
| `snapshot.marine.data.hourlyWaves` | 21,402 | |
| `snapshot.buoy.data.waterTempHistory` | 8,527 | read only by the server |
| `multiDayWindows` | 8,444 | 6,462 of it is `peakBreakdown.subScores` |
| `snapshot.sargassum` | 6,908 | |
| `snapshot.ripNwps` | 6,379 | |
| `cams` | 4,661 | |
| `snapshot.busyness` | 4,512 | |
| `hourlyScores` + `hourlyForecast` | 3,094 | no client code reads them |
| everything else | ~19,000 | |

## What was cut

1. **Packed row arrays** (`lib/clientConditions.ts`, `toWire` / `fromWire`). Long arrays of
   flat rows become columns. Regular hourly timestamps become a start and a step. Repeated
   words (sky text, emoji) become a small dictionary. The dashboard unpacks once, so every
   card still reads a plain `ConditionsResponse`. The packing refuses to pack (and sends the
   rows as they were) if a row holds a real `null`, a nested value or a non-finite number, so
   it is lossless. Paths packed: hourly, marine hourly waves, NWPS hours, rip-risk hours,
   7-day forecast, seaweed and busyness by hour / by day / today's reads.
2. **Dropped fields no client reads:** `buoy.data.waterTempHistory`, `hourlyScores`,
   `hourlyForecast`, plus the server-only `budgetAborted` and `skyAlertCandidates`.
3. **Kept on purpose, although first paint does not read them:** `peakBreakdown.subScores`
   (read when a day chip is tapped), `cams[].weather` (read by the cam stamp), alert
   `description` (the rip-alert matcher reads it). A read-set probe on first paint alone
   would have cut these and broken taps. The tests below guard the result.
4. **Flip-card back faces are built on first flip** (`FlipCard` takes a function; the long
   "how we compute this" text lives in its own chunk, fetched when a pointer reaches a card).
   This took 23 hidden back faces, about 75 kB of markup, out of every HTML response.
5. **The page no longer re-downloads its own snapshot on load.** SWR's mount fetch and the
   first `pageshow` refetched the whole thing, and could replace fresh HTML numbers with an
   older edge copy. A snapshot younger than 3 minutes is trusted. An older one is fetched
   as before. The 5-minute poll, focus and resume refetch, and the 6 s / 20 s freshness retry
   are unchanged.
6. **Share-card warm-up uses HEAD.** Every page view downloaded both share PNGs (~256 kB) to
   fill a server cache. HEAD runs the same handler and fills the same cache entry.
   It is skipped on Data Saver.

## The API

`/api/conditions/<slug>` is **unchanged**. The README calls it a public endpoint, so its
shape and headers stay. The dashboard now polls a new route,
`/api/conditions/<slug>/lean` (same cache headers, same `?fresh=1` rule, same 400 for any
other query). It returns the packed form.

Consumers checked: `ConditionsDashboard` (moved to `/lean`), `BeachModeCard` Live Activity
poll (stays on the full route), the watch app (`/api/watch/*`, separate), the agent feed
(`/api/v1/*` and `/mcp`, separate). Nothing in `ios/`, `android/`, `mobile/`, `workers/` or `e2e/` calls it. Only the
probe `scripts/perf_probe.sh` does, and it still measures the full route.

| Beach | Full route | Lean route | Lean, brotli |
|---|---:|---:|---:|
| Boca Raton | 160,849 | 53,876 | 10,536 |
| Siesta Key | 142,615 | 40,056 | 7,706 |
| Jupiter | 148,721 | 45,578 | 9,201 |

## JavaScript

Found with `@next/bundle-analyzer` (installed with `--no-save`, not added to `package.json`).
The whole dashboard was one 494 kB (148 kB gzip) chunk. Moved out of the first load:

| Code | Loads when |
|---|---|
| `lib/nerdInfo.ts` (back faces, 40 kB parsed) | a pointer reaches a card |
| Beach Mode card | app only (the server knows from the User-Agent; app HTML is unchanged) |
| "Last N days" section and the day view | app only; day view on pick |
| Paywall, Plus settings, Plus onboarding | first open of a sheet, or app idle time |
| Cam zoom viewer and `ZoomableImage` | a pointer reaches a cam |
| Full changelog (45 kB parsed and growing) | "Show all" tap; the page carries the newest 3 entries |
| RevenueCat SDK | first purchase / restore call |
| PostHog (96 kB gzip) | after the load event and an idle moment (was: immediately) |

`lib/firstLoadGraph.test.ts` walks the static import graph from the dashboard and fails if
any of these returns to the first-load bundle.

No dead dependency was found. Each package in `package.json` has a caller.

## Fonts, images, first paint

* Fonts: the page uses the system font stack. Nothing to load, no layout shift.
* Images: every `<img>` has a width and height or an `aspect-video` parent. Cam images were
  already lazy. The two App Store band images are now lazy too (React was preloading them
  in the head of the page). No `fetchpriority` is needed: the LCP element is text.
* The score, verdict and factor wheel are in the server HTML.

## Tests added

* `lib/clientConditions.test.ts`: pack / unpack round trip; refuses lossy input; for two real
  beaches (fixtures in `lib/__fixtures__/`, dated 2026-10-18) the **server HTML from the lean
  form equals the HTML from the full form**, and `computePersonalScore` and `deriveMetrics`
  match for all 7 profiles at four clocks; the **size budget** (`<= 60,000` bytes of JSON
  for a beach, and under 45% of the full size); server-only fields never leak; no client
  reader of the dropped fields.
* `app/api/conditions/[slug]/lean/route.test.ts`: 404, wire form, cache headers, query rules.
* `lib/firstLoadGraph.test.ts`: the lazy modules stay out of the first-load graph.
* `lib/changelogPreview.test.ts`, `lib/conditionsFreshness.test.ts`: new pure helpers.
* `e2e/layout.spec.ts`: a new pass flips every card at 390 px and 768 px and scans each back
  for clipped text (the backs are no longer in the page for the old scan).

Checks run: `npx tsc --noEmit`, `npx vitest run` (305 files, 5,400 tests), the full
Playwright suite against `next build` + `next start` with no billing key, as CI does
(20 of 20), and `npx opennextjs-cloudflare build`, then a `wrangler dev --local` smoke test
(home, native-UA home, `/lean`, full route, HEAD on the share route).

## Risks and decisions for the owner

1. **New URL for the other crews.** `/api/conditions/<slug>/lean` (and `?fresh=1`) is what
   the page polls now. Edge-cache and service-worker rules that name `/api/conditions/`
   should cover it. It sits under that prefix on purpose.
2. **Hidden back faces leave the HTML.** They were `aria-hidden`, but search engines could
   read them. If the "how we compute this" text matters for search, tell me and I will
   render one short summary per card instead.
3. **PostHog starts later.** A visitor who leaves before the page finishes loading is no
   longer counted. The first page view is still recorded once it starts.
4. **The Refresh button reads "Refresh" in the server HTML.** It said "Refreshing..." and
   was disabled until the page hydrated. Server and client now agree, so hydration stays
   clean (a first attempt hit React error 418 on exactly this).
5. **Native app first open.** The Plus sheets, Beach Mode and the look-back section are
   split chunks now. The sheets are fetched at idle time in the app, and the first tap on a
   slow link may wait for a small chunk.
6. **The share warm-up depends on HEAD reaching the route handler.** It does under
   `next start` and under `wrangler dev --local`. Confirm once on production: the
   `/api/share/<slug>` render count in the logs should not fall.
7. **`owner-gate.spec.ts` was fixed.** It looked for a bare `role=alert`, which also matches
   Next's empty route announcer once the page hydrates fast enough. It now asks for the
   alert that has words.
8. **E2E rate limit.** `plus.spec.ts` redeems an unlock code. The local limiter allows 5
   tries per hour per IP, so many repeated local runs will fail with "Too many tries".
   Clear `.wrangler/state/v3/kv` to reset it.

## Not done, and why

* **Split `lib/score.ts` (24 kB parsed).** Its hourly and multi-day parts only run for Plus
  users, but the personal score is computed synchronously inside a hook. Loading it lazily
  would make the personal number appear late. Behaviour would change.
* **Move the seaweed / clarity / busyness helper functions out of `lib/sources/*`.** About
  4 kB gzip. Low value for the churn.
* **`beaches` prop (11 kB raw, ~3 kB brotli)** carries every beach's shore line for the
  nearest-beach feature. Moving it behind a fetch changes when that feature works.
* **Hydration of 195 kB of markup.** The page is one client component. Making the
  below-the-fold sections lazy would need fixed-height placeholders and would change the
  HTML that search engines see. Worth a design pass of its own.
* **`/find` prefetch** (about 9 kB, low priority) was left in place.

## How to repeat

```
npm run build && npm run start -- -p 3200
node scripts/perf_page_probe.mjs http://localhost:3200 / 9 phone   # Fast 3G + 4x CPU
node scripts/perf_page_probe.mjs http://localhost:3200 / 9 none
```

The probe cancels the share-card warm-up requests (they cost seconds of CPU on a single
local server and slow the next run). It counts them and prints their method:
`GET,GET` before, `HEAD,HEAD` after. It hides `navigator.webdriver` so PostHog loads as it
does for a visitor. Set `PROBE_ANALYTICS=0` to leave that flag alone.
