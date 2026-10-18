# Courier pacing

This page explains how the home server keeps its YouTube calls under the limit.
It has the budget math, the design, and the steps to roll it out.

## The problem

The home server runs three jobs that call `yt-dlp`. They all use one home IP.

- The routine courier takes one frame per cam per hour.
- The golden courier takes frames every 10 minutes in sunrise and sunset windows.
- The sun-cam check reads the 4-hour DVR of each sun cam after every sunrise and sunset.

About 150 `yt-dlp` calls in 15 minutes from this IP makes YouTube answer
"Sign in to confirm you're not a bot". The block lasts about 10 minutes. It stops
every job on that IP at once.

Two crews are about to add 25 to 35 YouTube cams. The old design would hit the limit.

## What the server does today (measured)

Read from the server on 2026-10-16 (`ssh server`, read only).

- Only two jobs are loaded: `com.isitbeachday.camcourier` and `com.isitbeachday.suncam`.
- The golden job `com.isitbeachday.camcourier.golden` is **not loaded**. It exists in
  the repo. It never ran on the server.
- The log has no bot-check line. Today's load is far under the limit.
- The routine courier runs at :07 each hour from 06:00 to 20:59. It makes 7 `yt-dlp -g` calls.
- The sun-cam check runs at :16 and :46. A cam-event takes 47 to 52 seconds for 25 frames.
  The old code asked yt-dlp for a new playlist every 18 seconds. That is 3 `-J` calls per cam-event.
  (A playlist works for about 9 frames. That is the "9 frames" in the brief.)
- `deerfield-surf-cam` returns 0 of 25 frames at every run. Its DVR playlist is stale.
  It costs one call per run, about 12 calls a day.
- `deerfield-surf-cam` and `pensacola-sria-west-cam` got HTTP 400 on upload every hour.
  The old script hid the reason. The new script logs the code and the reply.
  Cause (found 2026-10-17): the stream was live but sending no video, so YouTube served its
  black slate. ffmpeg turns that slate into a 12,815-byte JPEG, and the worker refused anything
  under 20,000 bytes. The stream is not dead: `yt-dlp -g` returns a live manifest, and the
  archive holds real `deerfield-surf-cam` daylight frames from the same day. The worker now
  judges the picture, not the size (see "Frame guard" in `docs/architecture.md`): a blank frame
  gets HTTP 422 with `reason: "blank"`, and the courier logs it and cools that cam down.

The worker `workers/uw-frame` does not count. Its headless Chrome runs in
Cloudflare. It makes no `yt-dlp` call from the home IP.

## The budget today and at +35 cams

Run `python3 scripts/courier_plan.py --date 2026-10-17` to see these numbers again.
The plan uses the real scheduling rules and the real sunrise and sunset times.
It assumes every stream works. Real retries add a few calls.

| Plan, 2026-10-17 | Calls per day | Busiest hour | Busiest 15 minutes |
|---|---|---|---|
| Today, as loaded on the server (7 cams, 6 sun cams) | 141 | 25 | 19 |
| Old code with the golden job loaded (same cams) | 260 | 64 | 33 |
| New design (same cams) | 181 | 45 | 18 |
| Old code, no golden, +35 cams (42 cams) | 876 | 147 | 64 |
| Old code with golden, +35 cams | 1464 | 345 | **138** |
| New design, +35 cams | 895 | 135 | **47** |

The +35 plan has 18 Atlantic cams and 17 Gulf cams. All of them are courier cams and sun cams.
The new design stays at or under 60 calls in 15 minutes on every season tested.
Its worst values are 56 on 2026-06-21 and 52 on 2026-12-21.
The old design with golden loaded reaches 138 at 42 cams.
A few dead streams or a stale Elbo Room id would push it past 150.

The new design makes about the same number of calls per day as the old design without golden.
It buys the golden shots with savings elsewhere:

- One call per sun-cam event, not three.
- Golden takes only the cams whose own beach is in a window.
- A golden shot counts as the routine shot for that hour.

## What changed

### 1. One pacer for every call

`scripts/yt_pacer.py` keeps one ledger for all jobs. It lives in
`~/Library/Application Support/isitbeachday/ytpace/state.json`.
An `flock` guards it.

- **Hard cap:** 60 calls in any rolling 15 minutes, all jobs together.
- **Tiers:** golden may use all 60. The sun-cam check may use 48. Routine may use 36.
  So 24 slots stay free for sunrise and sunset work.
- **Spacing:** two calls start at least 4 seconds apart.
- **Waiting:** a job waits for a slot. Golden waits up to 5 minutes. The sun-cam check waits
  up to 15 minutes. Routine waits up to 2 minutes, then skips. A skipped cam is taken by a later run.
- **Backoff:** when `yt-dlp` answers with the bot check or HTTP 429, the pacer sets a mark.
  For 20 minutes the pacer refuses every call from every job. It logs one line:
  `pacer: BOT CHECK from <cam>: every yt-dlp job backs off for 20 min, until <time>`.
  Each job then stops at once and exits 0.
- **Overrides** (environment variables): `YTPACE_CAP_GOLDEN`, `YTPACE_CAP_SUN`,
  `YTPACE_CAP_ROUTINE`, `YTPACE_MIN_GAP_S`, `YTPACE_BACKOFF_S`, `YTPACE_WINDOW_S`, `YTPACE_DIR`.

Check it at any time: `python3 scripts/yt_pacer.py status`.

### 2. Caching, and why it is short

The URL from `yt-dlp` says it lives 6 hours. The segments behind it do not.
Measured on 2026-10-16 with the `android_vr` client:

- Segments play for about 25 seconds after `yt-dlp` issues the URL.
- At 31 seconds every segment answers 403.
- Fetching the same playlist URL again does not help. This holds for the newest segments too.

So a frame grab needs a fresh `yt-dlp` call each time. The URL cache lives 20 seconds.
That is all the YouTube side allows.

The savings come from fewer calls, not from a long cache:

- The sun-cam check now downloads all 25 segments in parallel right after one `yt-dlp -J`.
  `DvrSession.prefetch` does this. A live test took 1 call and 1.1 seconds for 24 segments.
  The old code took 3 calls and about 50 seconds.
- The stream id that the Elbo Room fallback finds is kept for 12 hours (`vid:<cam>`).
  The next runs start with the right id. Before, every run failed once, then searched.
  The fallback now spends one call per candidate, not two.

### 3. Priority for sunrise and sunset

Golden and sun work outrank routine work through the tiers. A routine call cannot take the
last 24 slots. In the plan, the sun-cam check never starves at +35 cams.

### 4. Spreading, so cams do not fire on the same minute

- The routine job fires every 5 minutes (:03, :08, and so on).
  A cam is due when its last good frame is 57 minutes old.
  One run takes at most `ceil(cams / 12) + 1` cams, the most overdue first.
  7 cams: 2 per run. 42 cams: 5 per run.
- The golden job fires every 10 minutes, all day. It takes only the cams whose own beach is in a window.
  The stride is 10 minutes for up to 24 cams in windows. It is 20 minutes for 25 to 48 cams.
  It is 30 minutes above that. A run takes only its share, so the cams alternate between runs.
- A cam that fails starts a cooldown: 10 minutes, then 20, 40, 80, and at most 2 hours.
  A good frame clears it. Dead streams stop eating the budget.
- A bot check, a backoff or a budget refusal never counts as a cam failure.

### 5. The cam list comes from config

`scripts/cam_courier_local.sh` names no cam. `scripts/courier_schedule.py` builds the list:

| Source | What it gives |
|---|---|
| `config/archive-cams.json` | every cam with source kind `direct`: its beach, time zone, coordinates |
| `config/vision-cams.json` | the same rule; adds a cam the archive does not list |
| `config/sun-cams.json` | the YouTube video id and the fallback page (Elbo Room) |
| `config/courier-cams.json` | video ids for cams that are not sun cams, and a skip list |

**To add a cam:** add it to `config/locations.ts` and regenerate `config/archive-cams.json`.
Add it to `config/sun-cams.json` if it is a sun cam. That gives its video id.
If it is not a sun cam, add its id to `config/courier-cams.json`.
Add it to `workers/uw-frame/src/lib/schedule.ts` too (`CameraId` and `CAMERA_REGISTRY`).
The worker answers 404 for an unknown cam.

`python3 scripts/courier_schedule.py check` finds a missing id or a missing worker entry.
`lib/courierRegistry.test.ts` runs it in the vitest suite. So CI fails before the cam reaches the server.

### 6. The launchd plists

- `com.isitbeachday.camcourier.plist` (routine): 12 calendar entries, no hour. It fires at :03, :08 and so on.
  It had 24 entries at :07 before.
- `com.isitbeachday.camcourier.golden.plist`: 6 entries, no hour. It fires at :00, :10 and so on, all day.
  It had a list of 50 hand-picked hours for the four old beaches. A new beach (a summer sunrise
  at 05:30, a Texas sunset at 21:30) would have fallen outside that list.
  A fire outside every window costs about 0.2 seconds and logs nothing.
- `com.isitbeachday.suncam.plist`: unchanged.

### 7. Smaller fixes made on the way

- The upload log now shows the HTTP code and the reply. It showed only "curl: (22)" before.
- The timeout helper in the shell script left a `sleep` running for up to 420 seconds after each call. It now stops it.
- The daylight gate (06:00 to 20:59 Eastern) moved into the scheduler.
- `--dry-run` shows what a run would grab. `COURIER_NOW=<ISO time>` asks "what would run then?".

## Picture size (1080p, 2026-10-18)

The courier used to ask for 720p (`best[height<=720]/best`). It now asks for
`best[height<=1080]/best[height<=720]/best` (`STREAM_FORMAT` in `scripts/yt_pacer.py`).
The size is part of the same `yt-dlp -g` call, so it adds no call to the budget above.
No AI upscaling is involved: the picture is the one the stream carries.

Measured 2026-10-18 on the laptop, in daylight, with `yt-dlp -J` (one call per cam, 34 calls in all)
and `ffmpeg -frames:v 1 -q:v 4`. The raw numbers and four cams' sample frames are in
`docs/research/2026-10-18-cam-resolution/` (`measurements.json`).

| Result | Cams |
|---|---|
| 1080p at 30 fps | 23 of 32 |
| 720p at 30 fps (the stream offers nothing higher) | `deerfield-surf-cam`, `fort-myers-beach-cam`, `white-sands-ami-cam` |
| "This video is not available" to yt-dlp, with and without node | `ormond-cam-180`, `dunlawton-cam-180`, `new-smyrna-cam-180`, `ponce-inlet-cam-180`, `hollywood-broadwalk-cam`, `dania-pier-cam` |

The six unavailable cams are a separate problem. YouTube's oEmbed still answers 200 for their ids.
They need a look at the server log (`~/Library/Logs/cam-courier.log`), not a size change.
A check of detail above the 1280 px scale showed real 1080p detail in every 1080p cam, not an upscaled 720p stream.

Frame size, 23 cams that offer both: 1080p is 1.6 to 2.3 times the bytes of 720p
(mean 1.9; mean 124 KB at 720p, 236 KB at 1080p). The biggest 1080p frame is 642 KB
(`fort-zachary-taylor-cam`; its 720p frame is 286 KB).

### What a bigger frame touches

| Place | Limit | Effect of 1080p |
|---|---|---|
| Worker ingest (`config/frame-guard.json`) | 5 KB to 2,000,000 bytes | Largest frame is 0.64 MB. No change needed. |
| KV value | 25 MiB; base64 adds one third | 0.86 MB at most. Fine. |
| Blank-frame check (`judgeFrame`) | Skip line: max(60 KB, 65 KB per megapixel) (`richBytesPerMegapixel` in `config/frame-guard.json`): 60 KB at 720p, 135 KB at 1080p | A fixed 60 KB line would let a noisy black 1080p frame skip the check (a 95 KB sensor-noise frame is a fixture now). A 1080p black slate is 29 KB (720p: 12.8 KB) and is checked in 1.5 ms (720p: 0.6 ms). Real 1080p frames under 135 KB are checked too, about 2 ms, and pass. Forced on a 362 KB frame the check takes 8 ms, but that frame skips it. The statistics are block averages over fractions of the frame, so they do not depend on size. The Worker and `cam_seaweed.py` use the same formula. |
| `bytesToB64` in the Worker | Free plan 10 ms CPU | It spread 32 KB per call: 8 ms for a 362 KB frame. It now uses 8 KB with `apply`: 1 ms. |
| Archive upload (`ARCHIVE_MAX_BYTES`, `/api/cam-frames`) | 600 KB | One cam can pass it. `archive_frame` now re-encodes a bigger frame to fit (Pillow quality 82, 72, 62; without Pillow ffmpeg `-q:v` 6, 9, 13, all coarser than the courier's own `-q:v 4`; then a 1280 px copy) and no longer drops it. A seaweed alert names the hash of the bytes archived, not of the frame as fetched. |
| Vision readers | See below | Courier frames are shrunk to 1280 px before any provider sees them. |

### Vision readers

`scripts/cam_seaweed.py` sent the whole frame to the provider: `gemini-2.5-flash` first, then Groq,
OpenRouter or Clef. Clef already shrinks to 768 px. For the rest:

- **Gemini** bills images in tiles, sized by the short side. 1280x720 and 1920x1080 are both 6 tiles, 1,548 tokens.
  So 1080p would cost the same, by the published rule (measure with `countTokens` before relying on it).
- **Groq and OpenRouter** bill by pixels. 1080p is 2.25 times the tokens of 720p.
- The prompts and the confirm rules were tuned on 720p frames.

So `shrink_for_vision` cuts a courier (`direct`) frame to 1280 px on the long side (`VISION_MAX_SIDE`).
A frame already that small passes through as the same bytes. The archive still gets the full frame.
Feed cams (video-monitoring.com) are not touched: they already send 1200 to 1920 px and keep doing so.

### Feed cams: the full-size original exists

Each `latest.json` entry has `mr` (what we serve) and `hr` (the full-size original, the same capture time).
Measured 2026-10-18 on all 18 feed views:

| Feed | `mr` now | `hr` original |
|---|---|---|
| Boca (s4, s11) | 1200x900, 153 KB | 4352x3264, 1.6 to 1.8 MB |
| Boca Inlet, Lake Worth Inlet, Jupiter s2 | 1920x1280, 0.3 to 0.4 MB | 5184x3456, 1.5 to 2.3 MB |
| Jupiter s33 | 1620x1080, 158 KB | 5184x3456, 1.1 MB |
| Jensen, Bathtub | 1200x800, 0.14 to 0.2 MB | 5184x3456, 2.2 to 2.6 MB |
| Hobe Sound | 1920x1280, 1.0 MB | 6000x4000, 7.1 to 7.3 MB |
| Sebastian | 1920x1280, 0.7 to 0.8 MB | 6000x4000, 5.0 to 5.6 MB |

`/api/cam/[id]?res=hr&at=<capture time>` serves the original of a feed cam:

- **Same moment.** `at` is the capture time the viewer shows. If `latest.json` has a newer frame, the answer is 409 and the
  viewer keeps its picture: a newer picture never sits under an old label. No capture time, no original.
- **No original.** A view with no `hr`, or one whose `hr` is a video (`.mp4`, such as Boca `v13`), and every courier cam, get 404.
  The server never sends `mr` as an "original".
- **Cache.** A Worker response is not cached at the edge by a `Cache-Control` header, and Next's data cache refuses bodies over 2 MB.
  So the original is kept in the Workers Cache API (`caches.default`, `lib/camOriginalCache.ts`) under its resolved URL for 10 minutes.
  The file name changes with every capture, so one key is one picture. The browser keeps it 5 minutes (`max-age=300`).
  Workers Cache stores only on a custom domain; the site is on one. In Node and `next dev` there is no cache and every zoom fetches.
- **Rate limit.** A cache miss spends one token from a per-IP budget (Workers rate-limit binding `CAM_ORIGINAL_RATE_LIMITER`,
  namespace 4723, 30 a minute; per-isolate token bucket if the binding is missing). When it is empty the answer is the normal still,
  without the `X-Cam-Original: 1` header, and the viewer ignores it. A cache hit is free. Check that namespace id 4723 is unused in the account before deploy.
- **Size header.** `X-Cam-Original-Size: 4352x3264` lets the viewer refuse a picture before it reads the body.

The zoom viewer asks for the original only after the viewer first zooms in (`ZoomableImage` `sharpSrc`). It does nothing when
`navigator.connection.saveData` is set, or when the original is over 20 megapixels (phones included, by the owner's call on
2026-10-18; `ORIGINAL_MAX_PIXELS_SMALL_SCREEN` can set a lower phone limit). It downloads once, decodes off screen, and swaps
only after the decode worked, without resetting the zoom. On any failure the normal picture stays. Measured: Boca 14 MP; the
5184x3456 ones 18 MP; Hobe Sound and Sebastian 24 MP. So phones and computers get every original except Hobe Sound and Sebastian.
The cost lands on the county servers only on a cache miss, once per capture and per data center, and never faster than the limit.
The archive keeps `mr`. Side effect to know: Hobe Sound and Sebastian `mr` frames (0.7 to 1.0 MB) passed the 600 KB cap, so
the archive skipped all four of those cams before. They now fit by re-encoding, so they start to fill the archive
(about 16 GB a year more for those four; the manifest already lists them).

### Storage and bandwidth

- yt-dlp calls: no change. Courier upload: about 110 KB more per frame, roughly 80 MB a day.
- KV: one value per cam, overwritten. About 10 MB held, against 5 MB.
- R2 archive (367-day lifecycle): about 22 frames per courier cam per day. 32 courier cams hold roughly
  32 GB a year at 720p and 61 GB at 1080p. R2 has no egress fee, and the extra is near 0.5 USD a month beyond the 10 GB free tier.
  The Day View loads archived frames, so those open with about twice the bytes.
- Phone data: a live still is about 240 KB, was 124 KB. An original is 1.5 to 7 MB, only on zoom.

### Zoom limits

Zoom past the real pixels shows blocks. A phone is 390 CSS px wide at 3 device pixels each, 1,170 device pixels.
Real-pixel zoom at fit is the picture's width divided by 1,170:

| Picture | Width | Real zoom on a phone | Max zoom (2x that, at least 2, at most 5) |
|---|---|---|---|
| 720p courier cam | 1280 | 1.1x | 2.2x |
| 1080p courier cam | 1920 | 1.6x | 3.3x |
| Feed `mr` | 1200 to 1920 | 1.0 to 1.6x | 2.1 to 3.3x |
| Feed `hr` | 4352 to 6000 | 3.7 to 5.1x | 5x |

The viewer now applies this per picture (`maxScaleFor` in `ZoomableImage.tsx`, from the picture's natural width, its fitted width and the
device pixel ratio), so the "+" button and a pinch stop where the picture runs out of real pixels. It is 5x until the picture has loaded.

### Roll out

Each part ships on its own and none needs a data change.

1. Courier: pull on the server, run the tests, and the next run grabs 1080p. Roll back by restoring the old format string.
2. Worker: `bytesToB64` fix; deploy `workers/uw-frame` when convenient. It is safe before or after the courier.
3. Reader and archive fit: runs in `sargassum.yml` once the branch is on main.
4. App: `?res=hr`, the viewer swap and the per-picture zoom limit. Add the `CAM_ORIGINAL_RATE_LIMITER` binding (`wrangler.jsonc`)
   by deploying; without it the in-isolate bucket applies.

Do 2 before 1 if the Worker is on the free plan: 8 ms of base64 is most of its 10 ms CPU.

## Dry run

```
python3 scripts/courier_plan.py                          # today's cams
python3 scripts/courier_plan.py --extra 35               # plus 35 planned cams
python3 scripts/courier_plan.py --extra 35 --model new --timeline
python3 scripts/courier_plan.py --date 2026-06-21 --extra 35
python3 scripts/courier_plan.py --extra 35 --json
bash scripts/cam_courier_local.sh --dry-run              # what a routine run grabs now
bash scripts/cam_courier_local.sh --golden-only --dry-run
```

`--timeline` lists the calls of the busiest 15 minutes. `--timeline-all` lists the whole day.
Nothing touches the network or the state file.

## Tests

```
python3 -m unittest discover -s scripts -p "*_test.py"
npx vitest run lib/courierRegistry.test.ts
```

- `scripts/yt_pacer_test.py`: the cap, the tiers, the spacing, the backoff, the cache, the Elbo fallback, the 1080p stream format.
- `scripts/courier_schedule_test.py`: the registry, a new cam picked up from config, the routine spread, the golden stride.
- `scripts/courier_plan_test.py`: the new design stays at 60 or less at +35 cams in five seasons.
- `scripts/cam_courier_local_test.py`: the real shell script with fake `yt-dlp`, `ffmpeg` and `curl`.
  It covers a bot check stopping every later run, an over-budget skip, a cooldown, a remembered id, and a refused upload.
- `scripts/sun_cam_check_test.py`: prefetch uses one manifest issue; the pacer stops the run.

## Roll out on the server

Nothing here is done. Run these steps by hand on the home server (`ssh server`).
Merge `courier-pace` to main first. The order matters.

1. **Stop the courier jobs, so no old plist runs the new script.**
   ```
   launchctl bootout gui/$(id -u)/com.isitbeachday.camcourier
   launchctl bootout gui/$(id -u)/com.isitbeachday.camcourier.golden 2>/dev/null || true
   ```
   (The golden job is not loaded today. The second line then does nothing.)
   Leave `com.isitbeachday.suncam` alone. Its plist does not change.
   Its next run starts the new code.
2. **Pull and test.**
   ```
   cd ~/Projects/bocabeach && git pull --ff-only
   python3 -m unittest discover -s scripts -p "*_test.py"
   python3 scripts/courier_schedule.py check
   bash scripts/cam_courier_local.sh --dry-run
   python3 scripts/courier_plan.py --extra 35
   ```
   All tests must pass. `check` must print `0 problem(s)`.
3. **Install the routine job.**
   ```
   sed "s#__HOME__#$HOME#g" scripts/com.isitbeachday.camcourier.plist \
     > "$HOME/Library/LaunchAgents/com.isitbeachday.camcourier.plist"
   launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.isitbeachday.camcourier.plist"
   ```
4. **Install the golden job.** It goes last. It never runs without the pacer.
   ```
   sed "s#__HOME__#$HOME#g" scripts/com.isitbeachday.camcourier.golden.plist \
     > "$HOME/Library/LaunchAgents/com.isitbeachday.camcourier.golden.plist"
   launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.isitbeachday.camcourier.golden.plist"
   ```
   This job is new on the server. It adds the golden shots the repo always planned.
   Skip this step to roll out the pacing alone.
5. **Check it.** Wait 20 minutes, then:
   ```
   tail -40 ~/Library/Logs/cam-courier.log
   python3 ~/Projects/bocabeach/scripts/yt_pacer.py status
   ```
   Expect 7 `uploaded` lines within 20 minutes of the first run. Each cam is then due again after 57 minutes.
   Expect `status` to show fewer than 60 calls and no backoff.
   The worker still answers HTTP 400 for two cams. The log now shows why.
6. **Roll back.** `launchctl bootout` both courier jobs, check out the old commit, restore the old plists,
   and `launchctl bootstrap` them. Delete `~/Library/Application Support/isitbeachday/ytpace` if you like.
   The old code ignores it.

The scripts need no new package. They use the standard library and Python 3.9 or newer.
The server has Python 3.15.

## What to watch

- `pacer: BOT CHECK` in `~/Library/Logs/cam-courier.log` or `sun-cam-check.log`. Every job then stops for 20 minutes.
  If it repeats, lower the caps (`YTPACE_CAP_*`) in the plists.
- `over the yt-dlp call budget`: a cam was skipped. A later run takes it. Many of these mean the cap is too tight.
- `upload failed (HTTP 4xx)`: the worker refused a frame. Fix that on the worker side.

## Limits and open items

- The plan is a model. It assumes every stream works. No one has pushed the real limit.
  The caps leave a wide margin (60 against about 150).
- A dead sun-cam stream still costs one call per run. `deerfield-surf-cam` is one today.
  The pacer caps the total. A retry back-off for the sun-cam check would save about 12 calls a day per dead cam.
- A new cam still needs a hand edit in `workers/uw-frame/src/lib/schedule.ts`. The test catches a miss.
- The worker's own headless-Chrome grab at 42 cams will fill its 90-second tick. It makes no home-IP call.
  It is blocked by YouTube anyway. Treat it as a separate budget.
- A signed-in YouTube session (`--cookies-from-browser`) would raise the limit. This change does not use one.
