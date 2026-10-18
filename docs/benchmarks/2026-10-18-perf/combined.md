# All three perf branches together (2026-10-18)

Branch `perf-integrate`: `perf-payload`, then `perf-edge-cache`, then `perf-sw`, merged on
`main` at `a567da23`, plus the cross-wiring below. Raw output: `combined-raw.txt` (same folder).

Preview version `e7b0e6c4-057d-4251-a585-745c4217eaf7`
(`https://e7b0e6c4-isitbeachday.entwined-app.workers.dev`), uploaded with
`wrangler versions upload`. It is not deployed. Its code is commit `1b524041`.

## Bottom line

- A beach page now reaches this laptop in about 105–120 ms on a new connection,
  against 216–1,161 ms in `baseline.txt`. On an open connection it takes about 60 ms.
- The page is about a third smaller (home page brotli 64.3 KB → 42.4 KB).
- On a simulated phone (Fast 3G, 4x slower CPU) the largest paint comes 110 ms sooner
  than production today, and the page is ready 265 ms sooner. It downloads 90 KB less.
- A repeat open in a web browser shows the score at 11 ms and paints at 60 ms, on any
  network and offline.
- The Worker is 2,480 KiB gzipped. The free plan allows 3,072 KiB, so 592 KiB is left.

## How to read these numbers

All runs are from the owner's laptop on home Wi-Fi to the Cloudflare MIA colo.
`ping 1.1.1.1`: min 9.3, avg 23.2, max 108.9 ms. That jitter is in every number.

The preview is on `*.workers.dev`. There the Workers Cache API does nothing, so the edge
cache works only from each isolate's memory. On the custom domains the second tier
(`caches.default`) is also active, so production should be the same or better.
`baseline.txt` was measured on the zone (`app.isitbeachday.com`) before this work.

## New connection per request (`scripts/perf_probe.sh <preview> 10`, TTFB p50)

Each request pays DNS, TCP and TLS (about 35–42 ms here). Run 1 started on a fresh
version, so its `ttfb_max` holds the first render (a MISS). Run 2 is warm.

| Path | Baseline (zone) | Preview run 1 | Preview run 2 (warm) |
|---|---:|---:|---:|
| `/` | 242 ms | 152 ms | **118 ms** |
| `/siesta-key` | 216 ms | 152 ms | **113 ms** |
| `/jupiter` | 1,161 ms | 121 ms | **106 ms** |
| `/api/conditions/boca-raton` | 149 ms | 112 ms | **105 ms** |
| `/api/conditions/siesta-key` | 282 ms | 116 ms | **97 ms** |
| `/api/conditions/jupiter` | 126 ms | 189 ms | **95 ms** |
| `/api/conditions/boca-raton/lean` | (new) | 135 ms | 119 ms |
| `/api/conditions/jupiter/lean` | (new) | 111 ms | 100 ms |

Bytes on the wire (brotli):

| Path | Baseline | Preview | Change |
|---|---:|---:|---:|
| `/` | 64,327 | 42,438 | −34% |
| `/siesta-key` | 57,351 | 36,444 | −36% |
| `/jupiter` | 60,064 | 39,000 | −35% |
| Boca data: public JSON → the lean copy the page reads | 18,007 | 12,788 | −29% |

## Edge cache answers (`scripts/perf_probe_edge.sh <preview> 10`)

Every page and both data routes answered from a stored copy: `HIT` 10 of 10, except one
`MISS` on `/boca-raton` (the 308 to `/`). The lean route is cached like the public JSON.

| Path | TTFB p50 | Connection set-up p50 | After set-up p50 |
|---|---:|---:|---:|
| `/` | 146 ms | 39 ms | 103 ms |
| `/siesta-key` | 120 ms | 35 ms | 81 ms |
| `/jupiter` | 114 ms | 40 ms | 67 ms |
| `/api/conditions/boca-raton` | 129 ms | 36 ms | 96 ms |
| `/api/conditions/boca-raton/lean` | 125 ms | 36 ms | 90 ms |
| `/api/conditions/jupiter/lean` | 109 ms | 36 ms | 70 ms |

On an open connection (`scripts/perf_probe_reuse.sh <preview> 20`, TTFB p50): `/` 63 ms,
`/siesta-key` 58 ms, `/jupiter` 64 ms, the data routes 45–60 ms. A static file took 73 ms
in the same run, so these are at the floor that this Wi-Fi allows.

## In a browser (`scripts/perf_page_probe.mjs <url> / 9 <profile>`, median of 9)

Empty cache each run, iPhone 390 px, PostHog loads as for a real visitor. Production
(`a3e71b34`) was measured in the same session for comparison.

| Fast 3G + 4x CPU | Production today | Preview | Change |
|---|---:|---:|---:|
| TTFB | 314 ms | 253 ms | −61 ms |
| First and largest paint | 832 ms | 720 ms | −112 ms |
| React finished hydrating | 2,506 ms | 2,241 ms | −265 ms |
| Load event | 2,309 ms | 2,064 ms | −245 ms |
| Bytes on the wire | 511 KB | 422 KB | −17% |
| JavaScript on the wire | 395 KB | 347 KB | −12% |
| Data download after load | 19.8 KB | 0 | −100% |
| Share-card warm-up | 2 × GET | 2 × HEAD | no picture download |
| Layout shift | 0 | 0 | |

| No throttling | Production today | Preview |
|---|---:|---:|
| TTFB | 257 ms | 142 ms |
| First and largest paint | 404 ms | 264 ms |
| Hydrated | 544 ms | 497 ms |
| Load event | 504 ms | 440 ms |

The verdict was in the server HTML on every run.

## Repeat opens (`scripts/sw-bench.mjs <preview> 7 /`)

| Scenario | score in page | first paint | rendered | TTFB | from worker |
|---|---:|---:|---:|---:|---:|
| No worker, fast network | 98 ms | 144 ms | 260 ms | 89 ms | 0/7 |
| No worker, Slow 3G | 739 ms | 780 ms | 1,209 ms | 162 ms | 0/7 |
| **Worker, fast network** | **11 ms** | **60 ms** | 155 ms | 1 ms | 7/7 |
| **Worker, Slow 3G** | **11 ms** | **60 ms** | 152 ms | 1 ms | 7/7 |
| **Worker, offline** | **11 ms** | **60 ms** | 150 ms | 1 ms | 7/7 |

The smaller page also helps the worker: first paint from the worker was 84 ms on the
service-worker branch alone (`service-worker.md`, local build) and is 60 ms here.
Without the worker on Slow 3G, "rendered" was 8.1 s on that branch and is 1.2 s here.

## What the merge had to wire together

- The edge cache also stores `/api/conditions/<slug>/lean`, under its own key, with the
  same rules (no query; `?fresh=1` and router or auth headers go straight through). The
  lean route sends `x-ibd-edge`, so the data-age check reads the real snapshot time.
- The service worker treats the lean route as the dashboard's data call and leaves the
  public JSON alone. It posts the packed form; the page unpacks it before use.
- A page with a fresh snapshot makes no data call on load, so the page asks the worker to
  save its beach's lean data once.
- The "no data call on load" rule reads the snapshot time in the HTML. A stored page whose
  snapshot is 9 minutes old still asks for new data (tested).
- An answer older than what the page shows (a saved copy from the worker or the edge) never
  replaces it.
- `public/_headers` works: Workers Static Assets read it (`wrangler dev` reports
  "Parsed 1 valid header rule"). On the preview, `/_next/static/*` answers
  `public, max-age=31536000, immutable`. The HTML stays
  `private, no-cache, no-store`, `/sw.js` stays `max-age=0, must-revalidate`, and
  `/_headers` itself is a 404.

## Worker size

`wrangler versions upload --dry-run`: 10,843 KiB, **2,480 KiB gzipped** (edge-cache branch
alone: 2,460 KiB). Limit on Workers Free: 3,072 KiB. Headroom: 592 KiB.

## Check after a deploy

```
scripts/perf_probe.sh https://app.isitbeachday.com 10
scripts/perf_probe_edge.sh https://app.isitbeachday.com 10   # look for HIT
node scripts/perf_page_probe.mjs https://app.isitbeachday.com / 9 phone
```
