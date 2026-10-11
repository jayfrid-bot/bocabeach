-- Webcam archive index (docs/CAM_ARCHIVE_PLAN.md, "Revision after Codex design
-- review" R2-R6). The JPEG bytes live in R2 (bucket isitbeachday-cam-frames,
-- binding CAM_FRAMES); this table is the index the day API reads.
--
-- cam_frames   one row per (beach, cam, hour slot): the first frame accepted for
--              that cam in that slot.
--
--              Three clocks per frame (R3):
--                received_at_utc  the server clock at ingest. Drives retention
--                                 and the pending cleanup. Never client-sent.
--                frame_at_utc     the source's own capture time when the capture
--                                 script knew it and it passed the sanity check
--                                 (not >5 min in the future, not >3 h old),
--                                 else NULL.
--                display_at_utc   frame_at_utc when present, else received_at_utc.
--                                 This is the time the user sees.
--              slot_utc is display_at_utc floored to the UTC hour, the same
--              key shape as beach_hourly.hour_utc. local_date, local_hour,
--              local_minute, utc_offset_minutes and timezone are derived from
--              display_at_utc with the helper beach_hourly uses
--              (lib/history/archive.ts localHourParts), so a DST fall-back
--              hour stays two distinct slots.
--
--              Slot claim is atomic (R4): ingest does
--                INSERT ... ON CONFLICT DO NOTHING  (state = 'pending')
--              and only the caller that inserted a row goes on to write R2.
--              Ready means the R2 object exists; readers filter on it. A
--              pending row older than 1 h is a crashed ingest; the daily
--              purge deletes it.
--
--              attribution is copied from the cam config at ingest, so a later
--              config edit never rewrites the credit on a stored frame (R6).
--
--              R2 key: <slug>/<cam_id>/<local_date>/<HHmm>Z-<sha8>.jpg, with
--              HHmm the UTC time of display_at_utc.
CREATE TABLE cam_frames (
  slug TEXT NOT NULL,
  cam_id TEXT NOT NULL,
  slot_utc TEXT NOT NULL,              -- ISO, top of the UTC hour of display_at_utc, e.g. 2026-10-11T14:00:00.000Z
  received_at_utc TEXT NOT NULL,       -- ISO, server clock at ingest
  frame_at_utc TEXT,                   -- ISO, source capture time, or NULL when unknown or out of range
  display_at_utc TEXT NOT NULL,        -- ISO, frame_at_utc ?? received_at_utc
  local_date TEXT NOT NULL,            -- YYYY-MM-DD in the beach's own timezone, at display_at_utc
  local_hour INTEGER NOT NULL,         -- 0-23, beach-local
  local_minute INTEGER NOT NULL,       -- 0-59, beach-local
  utc_offset_minutes INTEGER NOT NULL, -- beach-local minus UTC, at display_at_utc (DST-aware)
  timezone TEXT NOT NULL,              -- IANA, e.g. America/New_York
  r2_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,                -- hex of the JPEG bytes
  source_kind TEXT NOT NULL,           -- 'feed' | 'direct', from the cam config
  attribution TEXT,                    -- credit line, copied from the cam config at ingest
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready')),

  PRIMARY KEY (slug, cam_id, slot_utc)
);
CREATE INDEX cam_frames_slug_date ON cam_frames(slug, local_date);
CREATE INDEX cam_frames_received ON cam_frames(received_at_utc);
