// Pure, dependency-free mapping from a cam-vision feed `history[]` entry to a
// `cam_observations` row (migrations/0006 + 0014). Plain ESM on purpose: BOTH
// the hourly archiver (lib/history/camObservations.ts, via the archive route)
// AND the one-shot scripts/backfill_cam_history.mjs import this one file, so
// the two writers can never drift on how a feed entry becomes a row.
//
// Feed entry shape (scripts/cam_seaweed.py build_beach_output):
//   {t, hour, level (busiest crowd), people, crowdPct, seaweed, cov, water, clr}
// plus SPARSE `uw` (underwater visibility %) and `uwLevel` on the ~hourly
// ticks that ran an underwater read. `t` is an offset-bearing local ISO
// timestamp such as "2026-06-04T13:00-04:00".

/**
 * Convert a feed entry's offset-bearing local `t` to a UTC ISO string — the
 * `cam_observations.captured_at_utc` primary-key value. Returns null for
 * anything that does not parse to a real instant, so a malformed row is
 * skipped rather than stored under a garbage key.
 * @param {unknown} t
 * @returns {string | null}
 */
export function parseCapturedAtUtc(t) {
  if (typeof t !== "string" || !t) return null;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === "string" ? v : null);

/** How close (ms) the feed's top-level `uw` read must be to a history entry's
 *  own capture time for its note to be attached to that entry. */
const UW_NOTE_WINDOW_MS = 60 * 60_000;

/**
 * One feed history entry -> a `cam_observations` row, or null when it has no
 * usable capture time. `raw_json` is the entry verbatim; the one addition is
 * `uwNote`, copied from the feed's top-level `uw` block when that block is
 * the read behind THIS entry's `uw` (same percent, captured within an hour) —
 * the history entry itself carries only the percent and level, never the note.
 * @param {string} slug
 * @param {any} entry
 * @param {{ uw?: any } | undefined} [feed] the whole feed document, for the uw note
 */
export function rowFromHistoryEntry(slug, entry, feed) {
  const capturedAtUtc = parseCapturedAtUtc(entry?.t);
  if (!capturedAtUtc) return null;

  let raw = entry;
  const uw = feed?.uw;
  if (num(entry.uw) != null && uw && str(uw.note) && num(uw.pct) === entry.uw) {
    const uwAt = Date.parse(uw.capturedAtLocal);
    if (Number.isFinite(uwAt) && Math.abs(uwAt - Date.parse(capturedAtUtc)) <= UW_NOTE_WINDOW_MS) {
      raw = { ...entry, uwNote: uw.note };
    }
  }

  return {
    slug,
    captured_at_utc: capturedAtUtc,
    crowd_pct: num(entry.crowdPct),
    people: num(entry.people),
    seaweed_level: str(entry.seaweed),
    cov_pct: num(entry.cov),
    clarity_pct: num(entry.clr),
    water_word: str(entry.water),
    uw_pct: num(entry.uw),
    source: "feed",
    raw_json: JSON.stringify(raw),
    crowd_level: str(entry.level),
    uw_level: str(entry.uwLevel),
  };
}

/**
 * One per-cam reading from a feed capture group (`latest` / `morning`:
 * `{capturedAtLocal, cams: [...]}`) -> a `cam_reads` row. The history[] array
 * carries only the roll-up across cams; this is the per-cam detail. Null when
 * the group has no usable capture time or the cam has neither id nor name.
 * @param {string} slug
 * @param {any} group
 * @param {any} cam
 */
export function camReadRow(slug, group, cam) {
  const capturedAtUtc = parseCapturedAtUtc(group?.capturedAtLocal);
  const camId = str(cam?.id) ?? str(cam?.name);
  if (!capturedAtUtc || !camId) return null;
  return {
    slug,
    captured_at_utc: capturedAtUtc,
    cam_id: camId,
    cam_name: str(cam.name),
    seaweed_level: str(cam.level),
    cov_pct: num(cam.coveragePct),
    seaweed_note: str(cam.note),
    crowd_level: str(cam.crowd),
    crowd_pct: num(cam.crowdPct),
    people: num(cam.people),
    crowd_note: str(cam.crowdNote),
    water_word: str(cam.water),
    water_pct: num(cam.waterPct),
    water_note: str(cam.waterNote),
    raw_json: JSON.stringify(cam),
  };
}
