# Edge cache for beach pages and conditions JSON (2026-10-18)

Branch `perf-edge-cache`. Code: `lib/edgeCache.ts`, `lib/edgeMarker.ts`, `worker.ts`.
Raw probe output: `edge-cache-raw.txt` (same folder).

## Bottom line

On a repeat request, the server's own time for a beach page drops from about
120–150 ms to about 0–10 ms. The conditions JSON drops from about 45–60 ms to about 0 ms.
On an open connection, the JSON now arrives in 40–48 ms (p50) and a page in 59–61 ms.
Those numbers are at the floor that this laptop's Wi-Fi allows: a static file from
Cloudflare took 50–51 ms (p50) in the same runs. On a wired connection, the same pages
should come in under 50 ms. A brand-new connection still pays about 35–45 ms for TCP and
TLS before the first byte. No server change can remove that.

## Results

All runs are from the owner's laptop on home Wi-Fi to the Cloudflare MIA colo.
`ping 1.1.1.1` at the time: min 10.7, avg 23.6, max 70.9 ms. That jitter is in every number.

**Reused connection** (`scripts/perf_probe_reuse.sh`, 20 rounds, TTFB p50). This is what a
browser sees after the first request: one round trip plus the server's time. Runs back to back.

| Path | Edge ON (preview 96af90b6) | Edge OFF (same build, preview 83bdde6a) | Production today (zone) |
|---|---|---|---|
| static file `/icon-192.png` (floor) | 50 ms | 51 ms | 52 ms |
| `/` | **60 ms** | 205 ms | 161 ms |
| `/siesta-key` | **59 ms** | 184 ms | 143 ms |
| `/jupiter` | **61 ms** | 170 ms | 187 ms |
| `/boca-raton` (308 to `/`) | **46 ms** | 71 ms | 60 ms |
| `/api/conditions/boca-raton` | **43 ms** | 109 ms | 87 ms |
| `/api/conditions/siesta-key` | **40 ms** | 94 ms | 93 ms |
| `/api/conditions/jupiter` | **48 ms** | 97 ms | 82 ms |

**New connection per request** (`scripts/perf_probe.sh <url> 10`, TTFB p50), as in
`baseline.txt`. This includes DNS, TCP and TLS (about 35–45 ms here) on every request.

| Path | Baseline (zone, `baseline.txt`) | Production now (zone) | Edge ON cold (run 1) | Edge ON warm (run 2) |
|---|---|---|---|---|
| `/` | 242 ms | 382 ms | 175 ms | **106 ms** |
| `/siesta-key` | 216 ms | 279 ms | 127 ms | **124 ms** |
| `/jupiter` | 1161 ms | 272 ms | 151 ms | **104 ms** |
| `/api/conditions/boca-raton` | 149 ms | 153 ms | 117 ms | **83 ms** |
| `/api/conditions/siesta-key` | 282 ms | 129 ms | 94 ms | **100 ms** |
| `/api/conditions/jupiter` | 126 ms | 167 ms | 115 ms | **104 ms** |

The cold run is a fresh version: the first request for each path is a MISS (a full render,
up to 1.3–2.0 s, the `ttfb_max` column). The other nine requests are HITs, so the p50 is
already low. `scripts/perf_probe_edge.sh` counts the answers. In the warm run, every
request was a HIT, except one MISS on `/boca-raton`.

Workers analytics: one production `GET /api/version` (a trivial Next route) used 88–108 ms
of CPU (`wrangler tail --ip self`). Each request that Next renders pays that cost. A HIT
does not run Next.

## What a preview URL can and cannot show

Preview URLs are on `*.workers.dev`. On `workers.dev`, the Workers Cache API
(`caches.default`) does nothing. Cloudflare documents this, and `lib/watchViewCache.ts`
already notes it. So the preview runs used only the in-isolate tier. They still hit on
every warm request, because my requests reached a few warm isolates in MIA.

On the custom domains (`isitbeachday.com`, `www`, `app.`), the second tier is also active.
That makes the zone at least as good as the preview:

- An isolate that does not hold a copy reads it from `caches.default`. That costs about
  1–5 ms (one `match` and a body read). It does not render again.
- The fingerprint memo (see below) is shared the same way. So a new isolate does not have to
  wait for D1.
- The Cache API is per datacenter. Each colo builds its own copy on its first request. There
  is no tiered cache for the Cache API.

I could not measure the zone without a deploy. Check it after the deploy with
`scripts/perf_probe_edge.sh https://app.isitbeachday.com 10` (look for `HIT`) and
`scripts/perf_probe_reuse.sh https://app.isitbeachday.com 20`.

## Design

`worker.ts` is now `withEdgeCache(withBufferedAgentResponses(openNext))`.

1. **Classify** the request (`classify`). Only these can use a copy:
   `GET`/`HEAD` of `/`, `/<beach-slug>` or `/api/conditions/<slug>`.
2. **Key** (`cacheKey`) =
   format version + **Worker version id** (`CF_VERSION_METADATA`, new in `wrangler.jsonc`) +
   kind + path + **web/native** variant (pages only) + **owner-override fingerprint**.
3. **Find** a copy: first the in-isolate LRU (8 MB, 64 entries), then `caches.default`.
4. **Freshness** (`freshness`):
   - *fresh*: stored ≤ 60 s ago, and its data was generated ≤ 5 min ago. Served as it is (`HIT`).
   - *stale*: stored ≤ 10 min ago. Served (`STALE`), and one background refresh starts with
     `ctx.waitUntil`. There is one refresh in flight per key per isolate, and at most one try
     per 15 s per key.
   - *expired*: older. The request renders inline (`MISS`), as before this change.
5. **Store**, after the response is complete (`store`), only when all of these are true:
   - status 200 (or a 301/308 to a same-site path, for the flagship's `/boca-raton`);
   - no `Set-Cookie`, no `Content-Encoding`;
   - `text/html` for pages, `application/json` for the API;
   - body ≤ 2 MB;
   - the **complete-build marker** says `ok=1`. Pages render
     `<meta name="ibd-edge" content="v1;gen=<ISO>;ok=1">`. The JSON sends the header
     `x-ibd-edge` with the same value. `ok=0` means a budget-aborted build or
     `score.dataAvailable === false`. A page without the marker is not a beach page, or it is
     the "couldn't load conditions" fallback. Such a response is never stored.
   On a MISS, the body is split (`tee`): the visitor gets the stream as before, and the copy is
   read in `waitUntil`.

There are no scheduled pre-builds. A copy is built only because someone asked for that beach.
Open-Meteo load can only go down: today every page view runs the route, and with this change
a beach runs it at most about once a minute per colo, and only while people use it.

## Every bypass rule

A request goes straight to the app, unchanged (same `Request` object, no added header),
when any of these is true:

| Rule | Why |
|---|---|
| Method is not GET or HEAD | Only reads are cached. |
| Any query string, even an empty `?` | `?fresh=1` (the client's freshness retry), `?_rsc=` (Next's client navigation), `?ref=` (sticker QR), `utm_*`. Next writes the URL with its query into the page's router data, so the HTML differs. |
| Header `RSC`, `Next-Router-State-Tree`, `Next-Router-Prefetch`, `Next-Router-Segment-Prefetch`, `Next-Action` or `Next-Url` | Next's client router and server actions. The answer is a flight payload, not HTML. |
| Header `Authorization` | Credentials. No beach route reads one, but we never cache a credentialed request. |
| Header `Range` | Partial responses. |
| Path is not `/`, `/<slug>` or `/api/conditions/<slug>` | This covers `/admin/*`, `/find`, `/privacy`, `/support`, `/get-app` (reads the ref cookie), `/sticker` (sets it), `/mcp`, `/llms.txt`, every other `/api/*`, `/_next/*`, images, `robots.txt` and `sitemap.xml`. |
| The slug is not lowercase words with dashes, or is a reserved top-level name | The reserved names are `admin`, `api`, `find`, `get-app`, `mcp`, `privacy`, `sticker`, `support`, `opengraph-image`, `twitter-image`, `icon`, `apple-icon`, `manifest`, `robots`, `sitemap`, `_next` and `favicon`. A test checks this list against the `app/` folder. |
| No `CF_VERSION_METADATA` id | Without a build identity, we cannot prove that a copy matches this deploy. |
| The owner-override lookup failed or timed out (400 ms) | The answer gets `x-edge-cache: BYPASS`. Nothing is read or written. This is the same rule that `lib/watchLoad.ts` uses. |
| Any error inside the cache code before the route runs | Plain render, with no tag. |

These do **not** bypass, on purpose:

- **Cookies.** No beach route reads a cookie. A test scans `app/page.tsx`, `app/[slug]/page.tsx`,
  `app/layout.tsx` and `lib/nativeRequest.ts` for `cookies()`, `searchParams`, `draftMode`
  and `connection()`. Bypassing on any cookie would turn off the cache for most visitors,
  because the sticker `ref` cookie and the analytics cookies are common.
- **A client `Cache-Control: no-cache`** (a hard reload). The copy is at most 10 minutes old,
  and the page refreshes its own data.

Per-user state was checked:

- **Plus, install token, owner session, theme, home beach, nearest beach.** All of these live
  on the device (localStorage, the native layer) or in other routes. They never live in the
  page HTML.
- **A/B tests.** These run in PostHog, on the client.
- **Locale.** There is none. Beach time zones come from the beach, not from the request.
- **Native app.** The only request input that a page reads is the User-Agent
  (`IsItBeachDayApp`). It is a key variant. A test checks it against `lib/nativeRequest.ts`.

## Freshness stays honest

- The page does its first render on the snapshot's own `generatedAt` clock, and it switches
  to the live clock after mount (`components/ConditionsDashboard.tsx`). So a copy hydrates
  exactly like a fresh render: it is the same bytes.
- After mount, "updated X ago", the cam "Live" badge (`lib/camFreshness.ts`: data older than
  10 min is `data-stale`) and the safety text all use the real clock. A copy that is 9 minutes
  old says so.
- On mount, SWR fetches `/api/conditions/<slug>`, which is also cached. If the data is more
  than 10 minutes old, the client asks `?fresh=1` at about 6 s and about 20 s. That request
  always bypasses the edge cache, so it reaches the conditions cache as before.
- The 5-minute data rule refreshes a copy early when the page was built from old data. This
  can happen when the 120-s conditions cache served a stale entry after a quiet period.

## Owner corrections and cam takedowns

- **Seaweed verdicts** change the owner-override fingerprint, which is part of the key.
  The edge cache runs the same query as `lib/quality/overrides.ts`. The query now lives in
  `lib/quality/overridesFingerprintSql.ts`, a file with no imports, so both bundles share it.
  - The fingerprint is reused for 30 s with no D1 read.
  - From 30 s to 3 min, it is reused while a background read updates it.
  - After 3 min, the request waits for D1.
  - So a correction reaches every visitor in about 30 s, plus one request.
  - The memo is shared per colo through `caches.default`.
- **Cam takedowns** are a config change plus a deploy. A deploy is a new version id, so no
  copy from before the takedown can be found again.
- **D1 consistency.** D1 sessions or read replicas are not in use. So the edge read and the
  page's own read both go to the primary. If read replication is turned on later, a replica
  that lags could make the edge store a pre-correction page under the new key, for up to 10 min.

## Deploys

- The key holds the Worker version id. A page stored by one deploy is never served by another.
  This is important because the hashed `/_next/static` chunks of the old build are not
  served after a deploy: OpenNext skew protection is off, and Workers static assets belong to
  one version.
- Rollbacks and gradual deployments work. Each version reads only its own copies.
- After a deploy, each colo renders each beach once on its first request.
- A tab that is already open with old HTML can still miss an old lazy chunk, as before this
  change. `ReloadOnNewVersion` handles that.

## The flagship redirect `/boca-raton` → `/`

Who requests `/boca-raton`:

- push taps (`lib/push/notify.ts` and `lib/alerts/run.ts` build `/${slug}`);
- the national picker's links (`components/BeachFinder.tsx`).

The sitemap, the share card and the iOS start URL (`https://app.isitbeachday.com`) already
use `/`. We keep the 308, so there is one canonical URL. Serving the home page's HTML at
`/boca-raton` would give Next's client router a tree for `/` under the URL `/boca-raton`.
The 308 is now a cached answer: it costs one round trip and no server render (46 ms p50,
before 60–71 ms). A follow-up can remove the round trip completely: make the two push URL
builders and BeachFinder link to `/` for the flagship.

## Headers

- Browsers get exactly the `Cache-Control` that the route set. Pages stay
  `private, no-cache, no-store`. The JSON stays `public, s-maxage=300, stale-while-revalidate=600`,
  which a browser does not use for storage. No browser keeps an old page.
- The edge copy keeps the route's headers, but not `Set-Cookie` (never stored), `Date`,
  `Content-Length` or `Age`. Inside the Cache API, the copy has its own `max-age=600`, and the
  route's `Cache-Control`/`Vary` are kept aside and restored on the way out.
- Added: `x-edge-cache: HIT | STALE | MISS | BYPASS` and `x-edge-age: <seconds>`.

## Workers limits (the account is on Workers Free)

- **CPU (10 ms per request on Free).** A HIT only reads memory or makes one Cache API match.
  It runs no Next code, so it uses far less CPU than any render today. A refresh costs one
  render, the same as one request today.
- **Subrequests (50).** A HIT makes 0–2: a Cache API match, and sometimes a D1 read. A MISS or
  refresh makes the same calls as today, plus at most one `cache.put` and one D1 read.
- **KV.** No KV reads or writes. The Free plan allows 1,000 writes a day and 1 write per second
  per key, so KV was not used as a global tier.
- **Cache API.** At most one `put` per key per minute per isolate, plus one fingerprint `put`
  per beach per 30 s per colo, only while there is traffic.
- **Memory (128 MB per isolate).** The LRU is capped at 8 MB. A page is about 450 KB today.
- **Bundle size.** The upload was 2,460 KiB gzipped. The Free limit is 3 MiB. This change adds
  about 10 KB, but other crews should watch the margin.

## Risks

1. **The zone was not measured.** The behaviour on the custom domain (the second tier) is
   argued from the documentation and from `lib/watchViewCache.ts`, which uses the same
   synthetic-host pattern. Check `x-edge-cache` after the deploy.
2. **The edge layer can serve a page up to 10 min old** while a refresh runs, and data up to
   about 5 minutes older than that. The page labels its age, and the client asks for newer data
   by itself. If that is too loose, lower `MAX_STALE_MS` in `lib/edgeCache.ts`.
3. **The marker is a contract between the pages and the cache.** If a page stops rendering it,
   that page is simply not cached (fail-safe). A test fails if either beach page loses it.
4. **A future per-user input** (a cookie, a header, `searchParams`) on a beach page would be
   cached for everyone. The source-scan test catches the usual APIs. A reviewer must catch the
   rest. The comment at the top of `lib/edgeCache.ts` says this.
5. **The per-colo cold start after each deploy.** The first visitor per beach per colo pays a
   full render, the same cost as today.
6. **RSC prefetches are not cached.** Every page view prefetches `/?_rsc=…` and
   `/find?_rsc=…` (Next `<Link>`). Each prefetch is a full render. They were left alone
   because their output depends on the `Next-Router-State-Tree` header.

## Follow-ups (not done here)

- Link the flagship as `/` in push URLs and BeachFinder. This removes the 308 round trip.
- Cache or trim the RSC prefetch of `/` (with the payload crew).
- The HTML is about 450 KB before compression, and Cloudflare compresses it on each HIT. That
  probably adds the few ms by which pages trail the JSON. The perf-payload branch shrinks it.
