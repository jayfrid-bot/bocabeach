# Plus "Go back to any day" + webcam archive — build plan (2026-10-11)

Owner request (2026-10-11): move the historical data to the bottom of the
beach page; let Plus users go back to any past date and see how everything
looked, "including and especially the webcams" — store every cam shot we
capture and let the user scrub back through them.

Owner decisions (2026-10-11): archive **all 11 cams** (Boca ×3–4 Palm Beach
County ERM stills, Deerfield YouTube streams, Fort Lauderdale Elbo Room);
keep frames **1 year**. Risk noted to the owner: archiving third-party cams
and showing them in a paid feature exceeds today's "live still with credit"
use; any owner can ask us to stop, so every cam must be removable from the
archive by one config flag, and every frame shows its credit line.

## 0. Move History to the bottom

`components/ConditionsDashboard.tsx`: move the `HistorySection` block (today
directly under the score explainer, ~line 779) to just above the footer,
after `CamGrid` (~line 1235). Same props, same Plus gating. No other
reorder.

## 1. Frame capture (no new fetching)

`scripts/cam_seaweed.py` (GitHub Actions, every 10 min, 6 AM–8 PM ET) already
holds each cam's JPEG bytes in `capture_beach()` (`fetch_still(cam)`), for
all three source kinds (video-monitoring `latest.json` feeds; courier-fed
"direct" cams served by `workers/uw-frame` for the YouTube/Elbo Room cams).

- After a successful `fetch_still`, call `archive_frame(slug, cam, img,
  frame_at)` → `POST https://app.isitbeachday.com/api/cam-frames` with the
  raw JPEG body and query/headers `slug`, `cam`, `capturedAt` (UTC ISO,
  run time), `frameAt` (the source's own frame time when known),
  `Authorization: Bearer $INGEST_TOKEN`. Best-effort: a failure logs and
  never breaks the read. Archive even when the vision read later fails.
- New GitHub secret `INGEST_TOKEN` (same value as the app worker secret,
  set with `gh secret set INGEST_TOKEN < ~/.config/isitbeachday/courier.token`,
  never echoed). Added to the workflow step's `env`.
- Skipped cams (stale courier frame) are not archived — the frame did not
  change.

## 2. Storage

- R2 bucket `isitbeachday-cam-frames`, bound to the app worker as
  `CAM_FRAMES`. Object key: `<slug>/<cam_id>/<YYYY-MM-DD>/<HHmm>Z-<sha8>.jpg`
  (UTC date/time of `capturedAt`). Lifecycle rule: delete after 365 days
  (`wrangler r2 bucket lifecycle add`), so retention needs no cron.
- D1 migration `0016_cam_frames.sql`:
  `cam_frames(slug, cam_id, captured_at_utc, frame_at_utc, local_date,
  local_hour, local_minute, r2_key, bytes, sha256, source_kind,
  PRIMARY KEY (slug, cam_id, captured_at_utc))` + index
  `(slug, local_date)`. D1 rows older than 365 days are deleted by the
  existing `workers/history-cron` daily tick (one DELETE, bounded).
- Ingest route `app/api/cam-frames/route.ts` (POST):
  - Bearer `INGEST_TOKEN` via `secretEqual`; 401 otherwise.
  - `slug`/`cam` must exist in `config/locations.ts` and the cam must not
    have `archive: false` (new optional per-cam flag; default true) → 404/403.
  - Body must be `image/jpeg`, 10 KB–600 KB, JPEG magic bytes → 400/413.
  - **Throttle:** keep at most one frame per cam per 30 minutes — if a row
    exists for this cam with `captured_at_utc` within 25 min, return 200
    `{stored:false, reason:"recent"}`.
  - **Dedupe:** if the newest stored frame for this cam has the same
    sha256, skip (`reason:"duplicate"` — courier cams repeat for hours).
  - Write R2 first, then D1; if D1 fails, delete the R2 object.
  - Budget: ≤3 subrequests (R2 put, D1 read, D1 write).
- Size estimate: 11 cams × ≤28 frames/day × ~120 KB ≈ 37 MB/day ≈ 13.5 GB
  at the one-year steady state (R2: first 10 GB free, then $0.015/GB-month
  → well under $1/month).

## 3. Past-day API (Plus)

`POST /api/history/[slug]/day` — body `{ deviceId, date: "YYYY-MM-DD" }`.
Same gates as `app/api/history/[slug]/route.ts` (app-only, deviceId, KV rate
limit, install token, `entitled()` → 403 not-entitled). `date` must be a
valid local date between the archive start and today (beach timezone).

Returns:
- `hours`: that local day's `beach_hourly` snapshot rows — local hour,
  score, rating, engine version, and the readings the day view shows
  (air, water, wind, waves/surf, rain, UV, sand, flags, rip, seaweed,
  crowds) from the row columns + `extra_json`.
- `summary`: the existing `DaySummary` for that date (best/worst/avg,
  caps, engine versions) — reuse `summarizeDay`.
- `versions`: same block as the Look-back response, for that day.
- `cams`: per cam `{ id, name, attribution, frames: [{ t (local HH:mm),
  url }] }`. `url` is a signed, short-lived link (see 4). Cams with no
  frame that day are listed with `frames: []` so the UI can say so.
- `archiveStart` (first archived date for hours) and `framesStart` (first
  frame date) for the date picker bounds and empty-state copy.
Budget: 2–3 D1 statements, no R2 reads.

## 4. Frame delivery

`GET /api/cam-frames/img?k=<r2_key>&exp=<unix>&sig=<hmac>` — HMAC-SHA256
over `k|exp` with a new worker secret `CAM_FRAME_URL_KEY`; links valid 1 h.
Streams the R2 object with `Content-Type: image/jpeg`,
`Cache-Control: private, max-age=3600`. 403 on a bad/expired signature, 404
when missing. No device id in the URL (privacy rule: no identifiers in
query strings). Signing happens only inside the entitled day route.

## 5. UI (HistorySection, now at the bottom)

- Header row of the section gains **"Pick a day"**: a native
  `<input type="date">` bounded by `archiveStart`…today, plus ‹ › arrows to
  step one day. Tapping a day cell in the existing Last-N-days strip also
  opens that day.
- **Day view** (bottom sheet, like the paywall sheet; full-height on phone):
  1. Title: weekday + date; that day's best score and hour; the
     scoring-formula note when the day predates the current formula
     (reuse `formulaChangeNotice`).
  2. Hour strip of scores (same color scale as the main hourly chart);
     tapping an hour selects it.
  3. Readings at the selected hour: air, water, wind, waves, rain, UV,
     sand, flag, rip, seaweed, crowds — compact tiles, dashes for missing.
  4. **Webcams** (the hero of the sheet): one card per cam; the frame
     nearest the selected hour, a horizontal **time scrubber** (slider over
     that day's frames, label "10:30 AM"), tap to open full-screen with
     swipe between frames; credit line under every image ("Archived still
     courtesy Palm Beach County ERM / video-monitoring.com").
     Empty state: "No saved camera shots for this day. Saving began
     Oct 11, 2026."
- Free users: the "Pick a day" control shows the Plus door (same
  `onDoor` path as the rest of the section). Never show archived frames
  to a non-entitled device.
- Copy: plain words, no "AI", no jargon. Phone width 390 px first.

## 6. Housekeeping

- `lib/changelog.ts` entry (Plus: "Go back to any day, with the beach cams").
- `docs/architecture.md`: R2 bucket, ingest route, day route, img route,
  cam_frames table, cam_seaweed.py → ingest edge, history-cron purge.
- Privacy page: one sentence — Plus keeps public beach-cam stills for one
  year; they show the beach, not you, and we do not identify people.
- Paywall benefit list (`components/plus/Paywall.tsx`, `PlusInAppCard`):
  replace or extend the history line to mention cam shots — only after the
  feature is live.
- Tests: ingest auth/validation/throttle/dedupe/R2-then-D1 rollback; HMAC
  sign/verify/expiry; day route gating, date bounds, row shaping, empty
  cams; UI pure helpers (nearest frame to an hour, scrubber labels, empty
  copy); cam_seaweed `archive_frame` best-effort behavior (py test).

## Rollout

1. Infra: create bucket + lifecycle, bind, secrets (`CAM_FRAME_URL_KEY`,
   GitHub `INGEST_TOKEN`), migration 0016.
2. Ship ingest + capture first (frames start accruing the same day).
3. Ship the day API + UI + history move.
4. Codex review each step to SHIP; deploy recipe as usual; CI green.

---

# Revision after Codex design review (2026-10-11) — THIS SECTION WINS

Codex verdict: BUILD WITH CHANGES. Where this section disagrees with the
sections above, follow this section.

**R1. Cam set = all 11 cams in `config/locations.ts`.** The vision reader
today fetches only 7 (3 Boca, 3 Deerfield surface, Elbo Room); Spinner
(underwater) has its own path; `boca-inlet`, `boca-inlet-north`,
`boca-inlet-jetty` are never fetched. Add an **archive manifest** derived
from the location config (every cam whose `archive !== false`) and a
separate **archive pass** in `scripts/cam_seaweed.py` that fetches each
cam's still WITHOUT vision and posts it. This pass runs on every loop tick,
independent of whether any vision provider is configured. The vision
reader is refactored to `img = fetch_still(cam)` → archive best-effort →
`assess(img)` only when a provider exists, so a cam fetched for vision is
not fetched twice in the same tick. A test asserts the archive set equals
the 11 configured cam ids exactly.

**R2. Cadence = one saved shot per cam per beach-local hour** (aligned with
`beach_hourly`), not every 30 min. ~14–15 daylight shots per cam per day,
~6–7 GB/year at 120 KB (inside R2's free 10 GB). Copy promises "a camera
shot for every hour of daylight", never "every frame".

**R3. Three clocks per frame:** `received_at_utc` (server clock; retention,
audit), `frame_at_utc` (source time: `latest.json.timestamp` for feed cams
— extract it in Python instead of discarding it; the uw-frame `meta`
frameAt for courier cams; reject > 5 min in the future or > 3 h old →
null), `display_at_utc` (= frame_at when present, else received_at).
`local_date/local_hour` come from `display_at_utc` via the same
`localHourParts` helper `beach_hourly` uses. Client-sent times never drive
retention; the hourly slot is keyed from display time (R4), bounded by the
5-min-future / 3-h-old frame-time rule.

**R4. Atomic slot claim (no SELECT-then-INSERT).** Table key:
`PRIMARY KEY (slug, cam_id, slot_utc)` where `slot_utc` = `display_at_utc`
floored to the hour. Ingest: `INSERT … ON CONFLICT DO NOTHING` a row with
`state='pending'` → if no row inserted, return `{stored:false,
reason:"slot-taken"}`. Then dedupe: if this cam's newest READY frame has
the same sha256, delete the pending row and return `reason:"unchanged"`
(courier cams repeat for hours — the UI shows the nearest frame and its
age). Then R2 PUT → `UPDATE … SET state='ready'`. On PUT failure delete the
pending row; on finalize failure attempt R2 delete. Reads return only
`ready`. A daily cleanup deletes `pending` rows older than 1 h. Concurrent
ingest test (two simultaneous posts for one slot → exactly one stored).

**R5. Retention:** D1 rows purged at 365 days by `received_at_utc` (index
it). R2 lifecycle **367 days** (orphan objects invisible, never broken UI
rows). Purge runs from a NEW daily cron expression on
`workers/history-cron` (branch on `controller.cron`), calling a new
authenticated `POST /api/cam-frames/purge` (CRON_SECRET header, bounded
`DELETE … LIMIT 5000` loop ≤ 10 statements). The day API and image route
tolerate a missing R2 object (404 → UI shows "shot unavailable").

**R6. Removal = `archive: false` on a cam blocks ingest, day listing and
image delivery.** Plus a tested admin script
`scripts/cam_archive_remove.ts <slug> <camId>` that deletes the D1 rows and
the R2 prefix. Attribution is stored per row (`attribution` column) at
ingest, so later config edits never rewrite historical credit.

**R7. Privacy copy:** "Archived public beach-camera images may include
people in public areas. We do not use them to identify or track anyone.
Plus keeps them for one year." Owner chose all 11 cams knowingly
(2026-10-11); permissions remain an open owner item.

**R8. Workers specifics:** `r2_buckets: [{binding:"CAM_FRAMES",
bucket_name:"isitbeachday-cam-frames"}]` in `wrangler.jsonc`; a typed helper
`lib/camFrames/r2.ts` using the static `getCloudflareContext({async:true})`
pattern from `lib/db/d1Store.ts`; fail closed (503) when the binding is
absent. Ingest reads the body stream incrementally and aborts past 600 KB
(reject a larger `Content-Length` up front); do NOT use `readBody()` (8 KB
JSON). Delivery returns `new Response(object.body, …)` straight from R2
with `X-Content-Type-Options: nosniff`.

**R9. Signed image URLs:** HMAC-SHA256 over `k|exp`, key
`CAM_FRAME_URL_KEY`; **15-minute** expiry; reject exp > now+20 min,
non-integer exp, malformed k; constant-time compare; honor `archive:false`.
`Cache-Control: private, max-age=<seconds left>`; no edge/Cache API caching.
Day response `private, no-store`. The client refreshes the day payload
when an image 403s.

**R10. Day API contract:** every hour carries `hourUtc` (the key — DST
fall-back has two 1 AM rows), local hour, UTC offset, score, rating,
engine version, and readings (`surf_ft`, not raw `wave_ft`, for the surf
line; `extra_json` parsed defensively). Export `summarizeDay`. Calendar
round-trip date validation. Cams returned as metadata + frame list
(`displayAtLocal`, `hourUtc`, `url`) — no frame bytes, no preloading.

**R11. Phone UI (390 px):** date control on its own row under the section
header; in the day sheet the **webcam viewer comes first**: one camera at a
time with a horizontally scrollable camera chip selector, one image, an
index-based scrubber (`aria-valuetext` = "10 AM"), and the gap shown when
the nearest shot is not from the selected hour ("closest shot: 1:00 PM").
Load only the current frame (+ next/previous). Then the hour score strip,
then compact readings. Sheet: close button, focus trap, safe-area padding,
scroll lock, aspect-ratio placeholder, expired-link retry. Feature-flagged
(`NEXT_PUBLIC_DAY_VIEW` or a constant) until verified on the phone.

**R12. Rollout:** (1) infra: bucket, lifecycle 367 d, binding, app
`INGEST_TOKEN` (already set), `CAM_FRAME_URL_KEY`, GitHub `INGEST_TOKEN`,
migration 0016; (2) ingest + purge + removal script, Codex SHIP, deploy,
smoke (auth, slot race, cleanup, timezone); (3) archive pass for ONE cam
for a day, measure p50/p95 sizes; (4) all 11 cams; (5) day API + image
route, security-test free device + disabled cam; (6) UI behind the flag;
(7) History to the bottom (independent — can ship any time); (8) paywall
copy only after (6) is verified on the phone.
