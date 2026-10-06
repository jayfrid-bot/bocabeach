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
4. Scores each frame (see "Scoring"). The PEAK frame is the event score. The
   whole series is kept.
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
- reads at most 32 KB, and rejects unknown fields;
- checks the cam and beach pair against `config/sun-cams.json`, and the credit and
  distance against the registry;
- checks the event time against the beach's own computed sunrise or sunset (5
  minutes), and the local date against the beach's time zone;
- checks that the score is the best score of the series, and that the peak frame
  is in the series.

It stores one row per (slug, event_kind, event_date_local, cam_id) in
`sun_event_observations` (migrations/0015). A second post for the same key replaces
the row, so a re-score works.

### Filling the predictions

After the upsert, the route sets `observed_score`, `observed_source`, and
`observed_at` on the `sun_event_predictions` rows with the same slug and event kind
and an `event_iso` within 15 minutes of the event.

- When several cams reported the same event, the best one is written: solar before
  antisolar, then the smaller `distance_mi`, then `cam_id`. The route recomputes it
  from the table each time, so the order of arrival does not matter. An antisolar
  observation never replaces a solar one.
- `observed_source` reads `sun-cam:<cam_id>:<view>`.
- A row labeled by hand (any other `observed_source`) is left alone.

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
python3 scripts/sun_cam_check.py --from-dir DIR     # score saved frames (DIR = .../<date>/<event>/<cam>/)
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
  peak is taken across 25 frames.
- A cam that is down, re-aimed, or restarted skips the event or lowers its coverage.
- The score version must be bumped when the formula changes. Old rows keep their
  own version so they can be re-scored from the saved frames.
