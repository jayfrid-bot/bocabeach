# Sun-cam check: a "what actually happened" score for every sunrise and sunset

The app predicts how colorful each sunrise and sunset will be (`lib/sunQuality.ts`).
The hourly archiver logs every prediction to D1 (`sun_event_predictions`,
migrations/0013). To calibrate the model, we need the truth. This job looks at
the sky through beach livestreams and writes a 0-100 score back.

Why it exists: on 2026-10-06 the model said "Good" for a spectacular sunrise.
Nothing recorded what the sky really did. That sunrise is now the first labeled
example (about 95/100).

## How it works

`scripts/sun_cam_check.py` runs on the owner's Mac every 30 minutes (launchd).
For each cam in `config/sun-cams.json` and each beach that cam observes, it:

1. Computes today's sunrise and sunset with the NOAA solar formula. This is a
   port of `lib/sources/sun.ts` and matches it to the millisecond, so event times
   equal the ones the predictions use.
2. Picks every event that ended 25 minutes to 3.5 hours ago and is not in the
   state file yet.
3. Grabs a frame every 2.5 minutes from 35 minutes before the event to 25
   minutes after it (25 frames).
4. Scores each frame (see "Scoring"), drops unusable frames, and checks coverage.
   The event score is the ROBUST PEAK of the series, not the single best frame.
   The whole series is kept.
5. Saves the frames to `~/Projects/bocabeach-sunframes/<local-date>/<event>/<cam>/`
   (peak at full quality, the rest at low JPEG quality) and posts the result to
   `/api/sun-observations`.

The Mac does not need to be awake at sunrise. Any run within 3.5 hours after the
event can rebuild it.

### The DVR trick

YouTube keeps about 4 hours of DVR for a live stream.

- `yt-dlp -J https://www.youtube.com/watch?v=<id>` lists the formats. Pick the
  720p HLS one (format 95).
- That playlist holds about 2,880 five-second segments. Each segment has a time:
  the most recent `#EXT-X-PROGRAM-DATE-TIME` tag plus the `#EXTINF` durations
  since it. After a stream restart there can be several tags. Each one resets the
  clock.
- For a target time, fetch the segment that holds it and pull one frame with
  ffmpeg.

Things that went wrong while building it:

- **Segment URLs go stale about 30 seconds after the playlist is issued.** After
  that, the same URL answers 403. The script asks yt-dlp for a fresh playlist every
  18 seconds, and again on any 403.
- A segment from before a stream restart can 403 for good. The script skips it.
  An event needs at least 60% of its 25 frames, or it is retried on the next run
  while the DVR still holds it.
- ffmpeg's input-side `-ss` finds nothing in these segments (their timestamps
  start near 24,000 s). The script seeks on the output side. It also converts the
  limited-range video to full range before it writes the JPEG.
- YouTube blocks datacenter IPs. That is why this runs at home, like the camera
  courier.
- Elbo Room restarts its stream now and then, and the video id changes. If the
  saved id fails, the script reads the current id from elboroom.com/beach-cam
  (the same trick as `scripts/cam_courier_local.sh`).

## The cams

All four are 24/7 YouTube streams that face east over the Atlantic. The Boca
Raton cams (video-monitoring.com) upload only from about 8:00 AM to 5:30 PM, so
they never see a sunrise or sunset and are not used.

| Cam | Observes (distance from the beach pin) | Sky region (x0, y0, x1, y1 as fractions of the frame) |
| --- | --- | --- |
| `ftl-elbo-beach-cam` (Elbo Room) | fort-lauderdale (0.0 mi) | [0, .10, .30, .46], [.40, 0, .90, .55], [.90, 0, 1, .50] |
| `deerfield-beach-cam` | deerfield-beach (0.0), boca-raton (2.9) | [.13, 0, .73, .40], [.50, .40, .73, .49], [.73, .10, 1, .49] |
| `deerfield-surf-cam` | deerfield-beach (0.0), boca-raton (2.9) | [0, .05, .78, .25], [.78, .10, 1, .25] |
| `deerfield-pier-cam` | deerfield-beach (0.1), boca-raton (2.9) | [0, .08, .27, .13], [.27, 0, .89, .13], [.89, .08, 1, .13] |

The regions keep the sky and drop the flagpole, palms, pier, beach, water, and the
burned-in text. The Deerfield surf cam is a PTZ camera that pans between presets.
Its horizon sits anywhere from 27% to 46% down the frame, so its region is only
the top slice that is sky in every pose.

**View.** A sunrise is `solar`: the cam looks straight at the sun. A sunset is
`antisolar`: the cam looks away and sees clouds that catch the afterglow. They are
stored apart, so calibration never mixes them. The sunset score has not yet been
checked against a real event, because the DVR holds only 4 hours.

## Scoring

Deterministic and versioned. `SUN_CAM_SCORE_VERSION` in the script is stored with
every observation. Change it whenever any constant changes.

Each frame is cropped to the sky region and shrunk 4x. For each pixel (S and V from
0 to 1, hue H in degrees):

- **Ignored:** near-black (`V < 0.18`) and sun glare (`V > 0.92` and `S < 0.25`).
- **Warm:** `(H <= 50 or H >= 300)` and `S >= 0.30` and `V >= 0.35`. This covers red,
  orange, gold, pink, and magenta.

Then:

- `valid_frac` = valid pixels / region pixels
- `warm_frac` = warm pixels / valid pixels
- `colorfulness` = Hasler-Suesstrunk over the valid pixels
- `warm_sat` = mean saturation of the warm pixels

```
W = clamp(warm_frac / 0.30)
K = clamp((colorfulness - 35) / (70 - 35))
P = clamp((warm_sat - 0.25) / (0.55 - 0.25)) * min(1, warm_frac / 0.05)
C = min(1, valid_frac / 0.30)
score = 100 * C * (0.55 W + 0.20 K + 0.25 P)
```

Per-frame scores are rounded to 1 decimal before the event score is taken.

### Usable frames and coverage

A frame with `valid_frac < 0.10` (nearly all dark or blown out) is an artifact. It
is dropped from the series. The usable frames must also cover the event: at least 3
frames in EACH of three buckets, by minutes from the event.

| Bucket | Range |
| --- | --- |
| pre | [-35, -12) |
| around | [-12, +8] |
| post | (+8, +25] |

Peak color usually lands 5 to 15 minutes before a sunrise or after a sunset, so
the series has to span both sides. A capture that fails this is **incomplete**:

- nothing is uploaded;
- it is retried on each run while the DVR still holds the window;
- once the window is closing (the next 30-minute run would be past 3.5 hours), or
  closed, the script records it in the state file as `status: "incomplete"` and
  never uploads it. An event that aged out while the Mac was off is marked the same
  way.

### The event score: the robust peak

One frame can spike on a glitch or a lens flare. Real color builds and fades over
minutes. So a frame counts for at most **2x the best score among the other frames
within 5 minutes of it**, and a frame with no neighbor that close does not count.
The event score is the best such value.

- A sharp, real peak (94 beside a 59) is untouched.
- An isolated spike (95 beside 10 and 12) is cut to 24.
- It does not depend on the sampling rate: the live 2.5-minute frames and the saved
  5-minute frames both count as neighbors.

Two guards keep this from losing a real peak or crediting a glitch:

- **The highest raw frame must have a neighbor within 5 minutes.** If it does not,
  the frames beside it were lost to 403s, or it sits at the window edge. The script
  cannot tell a real peak from a glitch, and the old rule would have thrown the peak
  away and stored the event as whatever was left (a real 94 at +25 with +17.5, +20
  and +22.5 missing scored 20). So the capture is **incomplete**: it is retried while
  the DVR holds it, then marked `incomplete`. A top frame whose neighbors are
  present but lower is fine; it is capped, not incomplete.
- **A capped frame never lends its metadata.** The reported peak frame, and the
  top-level `warm_frac` and `colorfulness`, come from the best uncapped corroborated
  frame (a frame whose score is at most 2x its best neighbor). When a spike was
  capped, the score is up to 2x that frame's own score.

Only frames from -36 to +26 minutes (the window plus 1 minute of slack) reach the
series. The server rejects anything outside, so a late burst of frames cannot
become the peak.

The server recomputes the coverage and this statistic from the series (see "The
upload"). The Python (`robust_peak`) and TypeScript (`robustPeak`) versions are
checked against each other with two fixtures made by the script.

Calibration anchors: the 2026-10-06 Elbo Room sunrise peak (about 07:05 local, a
mid and high cloud deck lit pink and red) scores 94. Plain blue sky and white
midday frames score under 10 (0 to 2 at midday).

What the score is not: a measure of beauty. It measures how much of the visible
sky is lit warm. It does not know about fog, rain on the lens, or a dark lens. A
cam outage gives no frames, and the event is skipped.

## The upload

`POST /api/sun-observations`, `Authorization: Bearer <INGEST_TOKEN>`. This is the
same secret the courier uses on `workers/uw-frame` `/ingest`. The app worker needs
its own copy with the same name and value: `wrangler secret put INGEST_TOKEN`.
The Mac keeps the value in `~/.config/isitbeachday/courier.token`.

The route (`app/api/sun-observations/route.ts`, `lib/sunObservations.ts`):

- answers 503 if the secret is unset and 401 if the token is wrong. It checks
  this before it reads the body;
- reads the body as a stream and stops at 32 KB, with or without a
  `Content-Length` (413 if it is over; auth is still checked first), and rejects
  unknown fields;
- checks the cam and beach pair against `config/sun-cams.json`, and the credit and
  distance against the registry;
- checks the event time against the beach's own computed sunrise or sunset (5
  minutes), and the local date against the beach's time zone;
- recomputes the temporal coverage from the series and rejects an upload with fewer
  than 3 frames in any bucket;
- recomputes the robust peak from the series, and requires `peak_frame_iso` to be
  that frame, `observed_score` to equal it (to rounding), and the top-level
  `warm_frac` and `colorfulness` to match that frame's own values;
- rejects any series frame outside -36 to +26 minutes from the event;
- rejects a series whose highest frame has no neighbor within 5 minutes;
- requires `score_version` to look like `YYYY-MM-DD.N` with a real calendar date no
  more than a day ahead (so `9999-99-99.999` cannot outrank every real version), and
  `scored_at` to be after the last frame and not in the future.

It stores one row per (slug, event_kind, event_date_local, cam_id) in
`sun_event_observations` (migrations/0015).

**Re-scores.** Each upload carries `score_version` (`YYYY-MM-DD.N`) and `scored_at`
(when the script scored it). A post for an existing key replaces the row only when
the incoming pair is strictly newer: `score_version` compares by date, then `N` as a
number (so `.10` beats `.9`), then `scored_at`. An exact duplicate or a stale replay
changes nothing and the route answers `stored: false`. `created_at` is the first
time the key was received and is never rewritten.

### Filling the predictions

After the upsert, the route sets `observed_score`, `observed_source`, and
`observed_at` (the best observation's `scored_at`) on the `sun_event_predictions` rows with the same slug and event kind
and an `event_iso` within 15 minutes of the event.

- When several cams reported the same event, the best one is written: solar before
  antisolar, then the smaller `distance_mi`, then `cam_id`. The route recomputes it
  from the table each time, so the order of arrival does not matter. An antisolar
  observation never replaces a solar one.
- `observed_source` reads `sun-cam:<cam_id>:<view>`.
- A row labeled by hand (any other `observed_source`) is left alone.
- A row that already holds the best observation is not touched. So a duplicate or
  stale replay changes no prediction row, and a retry still fills a row that an
  earlier crash left empty.

Compare the model with the truth:

```sql
SELECT slug, event_kind, event_iso, as_of_hour_utc, lead_minutes, score, observed_score, observed_source
FROM sun_event_predictions
WHERE observed_score IS NOT NULL
ORDER BY event_iso, as_of_hour_utc;
```

## Credit

Elbo Room gave permission to use its stream as long as it is credited. The string
`Live stream courtesy Elbo Room (ElboRoom.com)` lives in `config/sun-cams.json`.
The ingest route rejects any other credit for that cam, and every stored row carries
it. Keep it wherever these frames or scores are shown.

## Install

Nothing here is installed by the change that added it.

1. `pip install pillow`. Install `yt-dlp` and `ffmpeg` too (the courier already
   needs them).
2. Apply the migration: `wrangler d1 migrations apply isitbeachday-plus --remote`
   (0015 adds `sun_event_observations`).
3. Set the secret on the app worker, with the same value the courier uses:
   `wrangler secret put INGEST_TOKEN`. Deploy the app so the route exists.
4. Put the same value in the Mac token file:
   ```
   mkdir -p "$HOME/.config/isitbeachday"
   printf '%s' '<the INGEST_TOKEN value>' > "$HOME/.config/isitbeachday/courier.token"
   chmod 600 "$HOME/.config/isitbeachday/courier.token"
   ```
5. Try it by hand: `python3 scripts/sun_cam_check.py --dry-run`
6. Install the launchd job:
   ```
   sed "s#__HOME__#$HOME#g" scripts/com.isitbeachday.suncam.plist \
     > "$HOME/Library/LaunchAgents/com.isitbeachday.suncam.plist"
   launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.isitbeachday.suncam.plist"
   ```

Logs: `~/Library/Logs/sun-cam-check.log`. State:
`~/Library/Application Support/isitbeachday/sun-cam-state.json`.

## Commands

```
python3 scripts/sun_cam_check.py --dry-run          # score and print, upload nothing
python3 scripts/sun_cam_check.py --force            # ignore the state file and the age window
python3 scripts/sun_cam_check.py --from-dir DIR     # score saved frames (DIR = .../<date>/<event>/<cam>/); exit 3, no upload, if they do not cover the event
python3 -m unittest discover -s scripts -p "*_test.py"
```

Backfill the 2026-10-06 sunrise (after the route is deployed):

```
python3 scripts/sun_cam_check.py \
  --from-dir ~/Projects/bocabeach-sunframes/2026-10-06/sunrise/ftl-elbo-beach-cam
```

## Known gaps

- Sunset (antisolar) scoring is untested on a real event.
- Camera auto-exposure changes how a frame looks. The score is per frame, and the
  the robust peak is taken across 25 frames.
- A cam that is down, re-aimed, or restarted gives an incomplete capture, which is
  never uploaded (see "Usable frames and coverage").
- The score version must be bumped when the formula changes. Old rows keep their
  own version so they can be re-scored from the saved frames.
