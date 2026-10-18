# Service worker for repeat opens (2026-10-18)

Goal: a repeat open shows the page and its last data at once, then a quiet refresh.
A first visit over a phone network cannot be 50 ms. A repeat open can come close.
Branch `perf-sw`. Numbers: `docs/benchmarks/2026-10-18-perf/service-worker.md`.

## How the iOS app loads the site

The iOS app is a Capacitor shell that loads the live site from the network.

- `capacitor.config.ts`: `server.url = "https://app.isitbeachday.com"`. `webDir` (`mobile/www`) is only an offline fallback page.
- `ios/App/App/Info.plist` has no `WKAppBoundDomains`. `AppDelegate.swift` and `SceneDelegate.swift` do not touch the web view setup.
  `BeachBridgeViewController` only registers two native plugins.
- The shell adds `IsItBeachDayApp/ios` to the user agent. Android adds `IsItBeachDayApp/android` and also loads the remote URL.
- Result: a web deploy reaches the app at once, and the app pays full network cost on every open.

## What was built

| Part | File |
| --- | --- |
| The worker | `public/sw.js` |
| Registration, "saved copy" note, remove-worker logic | `components/ServiceWorkerRegister.tsx`, `lib/swClient.ts` |
| Dashboard hook: performance mark and fresh-data message | `lib/useSwRevalidate.ts` |
| Kill switch route | `app/sw-kill/route.ts` |
| Immutable headers for build files | `public/_headers` |
| Tests | `lib/swRules.test.ts`, `lib/swClient.test.ts`, `e2e/service-worker.spec.ts`, `playwright.sw.config.ts` |
| Benchmark | `scripts/sw-bench.mjs` |

### Rules

| Request | Handling |
| --- | --- |
| `/_next/static/*` | Cache first. Files are hashed. Kept across builds, trimmed to 150 files when over 200. |
| `/` and `/<beach>` (navigations, no query string) | Stale while revalidate. Copy under 6 hours old: answer from the cache, fetch a new copy behind it. Older: ask the network, use the old copy only if the network is silent for 3 s or down. A reload or hard reload goes to the network. |
| `/api/conditions/<beach>/lean` | The dashboard's data call (the packed form, `lib/clientConditions.ts`). The first call of each page load is stale while revalidate. Later calls (5-minute poll, resume, Refresh button, pull to refresh) go to the network and fall back to the saved copy only on failure. `?fresh=1` is never touched. The fresh copy is posted to the page packed; `lib/useSwRevalidate.ts` unpacks it. The public `/api/conditions/<beach>` is not handled: nothing on a web page calls it. |
| Everything else | The worker does not answer. |

Never cached: non-GET, `Authorization`, `Range`, any query string on a page, `/admin`, every `/api/*` except conditions
(history, devices, RevenueCat, install-token, push, quality, `/api/v1`, watch, share, cam), `/mcp`, `/llms.txt`.
Only complete 200 answers from this origin are stored: not opaque, not redirected, not cut-off HTML,
not a conditions body without a snapshot. `Cache-Control: no-store` on the HTML is deliberately overridden for the beach pages only.
`RESERVED_SEGMENTS` in `sw.js` lists the real top-level routes. A test compares it with the folders in `app/`,
so a new route cannot become a "beach" by mistake.

Messages: the worker posts the new snapshot to the page (`ibd-fresh`). `ConditionsDashboard` applies it through its existing
SWR `mutate`, only if it is not older than what is on screen. The worker posts `ibd-fresh-failed` when a refresh fails and
`ibd-build-changed` when the new copy of the page points at different build files.

Saved-copy note: every saved page carries `Server-Timing: ibd-sw;desc="<ms>"`. If the page on screen is such a copy and is over
30 minutes old, a slim note says "Showing saved conditions from 2:41 PM. Updating…" until fresh data arrives
(then "Could not update yet." after 20 s). Copies under 30 minutes get no note.

### Versions and deploys

- The page registers `/sw.js?v=<git sha>-<build number>`. A new build installs a new worker (`skipWaiting`, `clients.claim`).
- On activate it deletes every page and data cache of older builds. Build files stay (an open tab on the old build still loads
  lazy chunks from them) and are trimmed by count. A change to the cache format bumps `SW_SCHEMA`, which renames every cache.
- A saved page is never older than 6 hours when shown as current, and it is replaced by a fresh copy on each visit.
  When the fresh copy points at different build files, the page reloads itself once, only if the reader has not touched it,
  no dialog is open, no purchase is in flight, and it opened less than 30 s ago. Otherwise `lib/useReloadOnNewVersion.ts`
  catches it on the next resume, as before.
- The page calls `registration.update()` on every load, so a fixed `sw.js` lands on the next visit, not within 24 hours.

### Save-Data, storage

`navigator.connection.saveData` (or the `Save-Data` header): no page warm-up, no conditions warm-up, background refresh at most every 30 minutes.
Nothing is added when the origin uses over 80% of its quota or the quota is under 50 MB. Caps: 12 pages, 48 data entries, 200 build files.

## Kill switch (three layers)

1. **Server flag, no code deploy.** `npx wrangler secret put SW_KILL` (value `on`). `GET /sw-kill` then answers `200 kill`.
   Every worker asks at activate and at most every 30 minutes. On `kill` it deletes all `ibd-*` caches, unregisters, and tells open pages.
   Undo: `npx wrangler secret delete SW_KILL`. Verified in `e2e/service-worker.spec.ts` against a server started with `--var SW_KILL:on`.
2. **Per phone.** Open any page with `?nosw=1`. The page tells the worker to stop, unregisters it, wipes the caches, and remembers
   (localStorage `ibd:sw=off`). `?sw=on` turns it back on. Query-string URLs never go through the worker, so this works even if the worker is broken.
3. **Code.** Replace `public/sw.js` with a worker that unregisters itself (the old file did exactly that; `git show a567da23:public/sw.js`).
   Pages call `update()` on each load, so it reaches users on their next visit. The component also stops registering in the native shells and in dev.

## Where it runs

| Place | Runs? | Why |
| --- | --- | --- |
| Desktop and mobile browsers, home-screen web app | Yes (production builds only) | |
| iOS app | **No** | WKWebView has no service workers today. See below. |
| Android app | **No, on purpose** | Android WebView supports workers. `swDecision` in `lib/swClient.ts` keeps it off while the user agent has `IsItBeachDayApp/`. Remove that line after a trial on the Play internal track. |
| Local `next dev` | No (and it removes any worker) | |

Safari cannot be tested here (this Mac has Chromium and Firefox in Playwright, no WebKit). Safari 16.4+ supports everything used
(`Server-Timing` on navigation entries, Cache API, `updateViaCache`). Test once on a real iPhone in Safari before relying on it.

## Findings you did not ask for

1. **Build files are not cached on the network.** Production serves `/_next/static/*` with `Cache-Control: public, max-age=0, must-revalidate`
   (checked live on app.isitbeachday.com). Every open pays a revalidation round trip for about 17 files, in the browser and in the iOS app.
   `public/_headers` fixes that with one rule (`immutable`, one year). It reaches the iOS app on the next web deploy, with no App Store build.
   This is the cheapest repeat-open win for the app. Check after deploy: `curl -sI https://app.isitbeachday.com/_next/static/css/<file>.css | grep -i cache-control`.
2. **First paint, not the worker, is now the floor.** From the worker, the page arrives in 1 ms and the score is in the HTML at about 13 ms.
   Chromium then spends about 65 ms on style, layout and paint of a 479 KB, 2,600-node page (trace in the benchmark doc). Fewer nodes or a shorter first screen is the way under 50 ms. That work belongs to the payload branch.

## iOS plan (not done: needs an App Store submission)

Experiment (iPhone simulator, iOS 27, scratch copy of the shell, local test page; nothing in the repo changed):

| Setup | `'serviceWorker' in navigator` | `register()` |
| --- | --- | --- |
| As shipped today | false | not possible |
| `ios.limitsNavigationsToAppBoundDomains: true` + `WKAppBoundDomains` | true | works, worker activates |
| `WKAppBoundDomains` only (flag off) | false | not possible |
| Flag only, no plist key | true | works (but Apple documents the plist key as required; use both) |

So the flag is the switch. Plan for the owner's go:

1. `capacitor.config.ts`: add `ios.limitsNavigationsToAppBoundDomains: true`.
2. `ios/App/App/Info.plist`: add `WKAppBoundDomains` = `app.isitbeachday.com` (Apple allows 10).
3. Remove the `IsItBeachDayApp/ios` exception in `swDecision` (web deploy, after step 1 and 2 are in a build).
4. Submit a build. Test on a real device before submitting: cold open, airplane mode open, the cam "Watch live" link
   (a plain external link, `components/CamLightbox.tsx`), Plus paywall and restore (RevenueCat is native), the App Store link, push taps, Beach Mode.

Side effects checked in the simulator (Experiment C): a plain link and a `target=_blank` link to youtube.com open in Safari, as Capacitor already routes
external links; the embedded YouTube iframe still renders. Not tested: the real site, a real device, and the effect on the
Live Activity and Watch plugins (native, expected unaffected). Known limits of app-bound mode: the web view may only navigate to listed domains
(an unlisted page opens outside the app, which is what already happens), and script injection is limited to listed domains (Capacitor's bridge runs on the bound domain).
If anything in step 4 misbehaves, ship the next build with the flag off; the worker never registers there when the flag is off.

**Risk to weigh:** the first worker once served stale JavaScript in the shell. This one never serves a page older than 6 hours as current,
refreshes on every open, reloads itself when the build changes, and has three off switches. Still, the app would always show the
build from the previous open for a moment on deploy day. Roll out to Android internal first.

**Alternative without app-bound domains (describe only):** cache the last HTML or JSON natively. A small Capacitor plugin or a
`WKURLSchemeHandler`/`URLProtocol` could keep the last `/api/conditions/<beach>` body and the last page, and paint them from the bundled
`mobile/www` shell while the remote loads. It works for every iOS version, but it is native code to write, test and keep in step with the web app.
The `_headers` fix plus the app-bound flag is far less code.

## Risks

- A stale page for up to 6 hours is possible if the network is down. The note says so after 30 minutes.
- On a deploy day the first open shows the old build once; the page reloads itself if untouched (a flash), else the next open is current.
- The worker serves the first conditions call from its copy, so the Refresh button's "Refreshing…" can flip early. Only the first call per page load is served from the copy; Refresh and the poll go to the network.
- Storage: about 2 MB of build files plus about 500 KB per saved page (decoded HTML) and 15 KB per beach.
- Edge crew (`perf-edge-cache`) changes to `Cache-Control` on HTML or conditions do not matter to the worker (it overrides pages and uses its own age rule), but a change to the URL shape of `/api/conditions/<beach>` or the chunk path would.

## Pre-deploy review fixes (2026-10-18)

- First call: the dashboard marks its first data call of a page load with the header
  `x-ibd-first-call: 1`. Only that call may come from the saved copy. The worker keeps no
  memory of it, because the browser empties worker memory whenever it stops the worker.
- App shells: a worker that finds `IsItBeachDayApp/` in its user agent (iOS and Android,
  `capacitor.config.ts`) deletes every cache and unregisters. The page also removes it there.
- On activate the worker deletes every cache on the origin that is not its own, whatever
  its name (also the caches of the very first worker).
- Old builds: when the worker saves a page, it also saves the build files the page names
  (tags and flight data), and trimming never drops a file a saved page names. A repeat
  visitor's page also fetches the browser's lazy pieces once at idle (not with Save-Data or
  on 2g / slow-2g). Saving a page's build files waits 5 seconds, so the page's own loads
  come first, and is skipped with Save-Data or on 2g / slow-2g. If a file is still missing,
  `lib/chunkReload.ts` reloads the page once (guarded in sessionStorage), but only when the
  browser is online and `HEAD <file>` (no cache) answers 404 or 410. Offline or on a failed
  probe the error goes on as before. Only pieces a person opened reload; background loads
  (analytics, billing, push) keep their soft fallbacks.

## Integration with the payload and edge-cache work (2026-10-18)

- The dashboard reads `/api/conditions/<beach>/lean`, so that is the worker's data route.
- A page whose snapshot is under 3 minutes old makes no data call on load
  (`lib/conditionsFreshness.ts`). So the page asks the worker to save its beach's lean data
  once (`ibd-warm`, from `lib/useSwRevalidate.ts`), and the "first call of a page load"
  happens only when the saved page is older than that.
- A data answer older than what the page shows is ignored (`isOlderSnapshot`); the worker's
  fresh copy follows by message.
