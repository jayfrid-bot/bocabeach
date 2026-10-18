# Service worker: repeat-open benchmark (2026-10-18)

Script: `node scripts/sw-bench.mjs http://localhost:8788 9 <path>` against a production build
(`npx opennextjs-cloudflare build && npx wrangler dev --port 8788`). Headless Chromium 151 on the owner's MacBook,
390 x 844 viewport, 9 runs per row, median (worst in brackets). Other build jobs were running on the same Mac, so
absolute milliseconds move by 10 to 30%; compare rows within one run.

Each scenario: one warm-up visit (fills the caches), then 9 fresh tabs in the same browser context.
"Slow 3G" is Chrome's profile (500 kbit/s, 400 ms round trip) on the page. Offline is the browser offline switch.

Measures: `score-dom` = first moment the score wheel exists in the page (MutationObserver);
`fcp` = first contentful paint; `rendered` = the dashboard's `ibd:score-rendered` mark (after hydration plus one paint);
`ttfb` = `responseStart` of the page request.

## `/` (flagship beach)

| Scenario | score-dom | fcp | rendered | ttfb |
| --- | --- | --- | --- | --- |
| No worker, fast network (HTTP cache only) | 38 ms (66) | 108 ms | 215 ms (249) | 27 ms |
| No worker, Slow 3G | 614 ms (618) | 552 ms | 8,060 ms (8,128) | 27 ms |
| **Worker, fast network** | **13 ms (14)** | 84 ms | 180 ms (208) | 1 ms |
| **Worker, Slow 3G** | **14 ms (22)** | 84 ms | 188 ms (284) | 1 ms |
| **Worker, offline** | **13 ms (13)** | 80 ms | 176 ms (217) | 1 ms |

## `/siesta-key`

| Scenario | score-dom | fcp | rendered | ttfb |
| --- | --- | --- | --- | --- |
| No worker, fast network | 30 ms (39) | 96 ms | 184 ms (307) | 20 ms |
| No worker, Slow 3G | 614 ms (618) | 580 ms | 5,058 ms (5,063) | 17 ms |
| **Worker, fast network** | **11 ms (11)** | 68 ms | 140 ms (145) | 1 ms |
| **Worker, Slow 3G** | **12 ms (13)** | 72 ms | 147 ms (154) | 1 ms |
| **Worker, offline** | **12 ms (12)** | 76 ms | 162 ms (181) | 1 ms |

All worker rows were served by the worker (`Server-Timing: ibd-sw` present, 9 of 9).

## Reading the numbers against the 50 ms target

- **The worker's part is met.** The page answers in 1 ms and the score is in the document at 11 to 14 ms, on any network and offline.
  On Slow 3G the repeat open goes from 5 to 8 seconds (fully interactive) to 0.15 to 0.19 s, and the score from 0.6 s to 14 ms.
- **First paint is 68 to 84 ms here, not under 50.** A trivial page paints at 8 ms in the same browser, so the rest is the page.
  A trace of the worker-served open (`/`): parse HTML 8 to 14 ms, style recalculation 12 ms, layout 29 ms, paint 8 ms, raster at 75 ms.
  The page is 479 KB decoded with 2,600 elements. The way under 50 ms is a smaller first screen (payload branch), not more caching.
  No long task over 50 ms ran before paint, so hydration does not delay it.
- Over a phone's own CPU these steps take longer than on this Mac. Treat the paint figures as a floor.
- Slow 3G is applied to the page only. The worker's background refresh runs on the full-speed link, which does not change the time to the saved score.
- Not measured: Safari/WebKit (no WebKit build installed here), a real phone, and the iOS app (the worker cannot run there yet; see `docs/SERVICE_WORKER.md`).

## First visit and the HTTP-cache finding

First visit is unchanged (the worker registers after load and goes idle-quiet). The second visit already comes from the worker:
the first visit's open tab sends the worker its list of loaded build files and fetches the page and conditions once more in the background.

Separate from the worker: production serves `/_next/static/*` with `max-age=0, must-revalidate`, so even the "no worker" rows above
(a local server that now has `public/_headers`) are better than production today. Ship `public/_headers` and the iOS app gets the same benefit
with no App Store build.

## Tests that ran

- `npx vitest run`: see the commit message for the count. `lib/swRules.test.ts` runs the worker itself against a fake Cache API and fake network (30 cases).
- `PW_SW_BASE_URL=http://localhost:8788 PW_SW_KILL_URL=http://localhost:8789 npx playwright test -c playwright.sw.config.ts`: 6 browser tests:
  first visit warms the cache; repeat open comes from the worker and updates in place; nothing sensitive is cached; offline works; `?nosw=1`; kill switch.
