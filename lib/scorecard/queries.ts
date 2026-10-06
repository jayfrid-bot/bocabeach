// The SQL the scorecard runner sends to D1 (read-only SELECTs). Pure string
// builders, kept apart from scripts/scorecard.ts (which runs on import) so the
// ordering and filtering rules are unit-tested.

export const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Only the sun-forecast columns the metrics read. */
export const SUN_PRED_COLS =
  "slug, event_kind, event_iso, as_of_hour_utc, lead_minutes, score, band, algo_version, observed_score, observed_source";

/**
 * Hourly archive rows for a UTC range. json_extract pulls only the blocks the
 * scorecard reads, so a row is ~100 bytes instead of the whole ~2 KB
 * extra_json. `win` not `window`: WINDOW is an SQL keyword.
 */
export function hourlyQuery(fromIso: string, toIso: string): string {
  return `SELECT slug, hour_utc, local_date, local_hour, score, engine_version,
  CASE WHEN extra_json IS NULL THEN 0 ELSE 1 END AS has_extra,
  json_extract(extra_json, '$.window') AS win,
  json_extract(extra_json, '$.rain') AS rain,
  json_extract(extra_json, '$.flags') AS flags,
  json_extract(extra_json, '$.outlook') AS outlook,
  json_extract(extra_json, '$.safety') AS safety,
  json_extract(extra_json, '$.rip') AS rip
FROM beach_hourly
WHERE row_kind = 'snapshot' AND hour_utc >= ${sqlStr(fromIso)} AND hour_utc < ${sqlStr(toIso)}
ORDER BY hour_utc, slug`;
}

/**
 * Every forecast row that has a camera reading, for events in the window. Newest
 * events first, so a row cap drops the OLDEST events, never the newest.
 */
export function sunPairedQuery(sinceIso: string, limit: number): string {
  return `SELECT ${SUN_PRED_COLS} FROM sun_event_predictions
WHERE observed_score IS NOT NULL AND event_iso >= ${sqlStr(sinceIso)}
ORDER BY event_iso DESC, slug, event_kind, as_of_hour_utc DESC
LIMIT ${limit}`;
}

/**
 * Each event's "call": its latest SCORED forecast made at least 60 minutes
 * ahead. The score filter is in the subquery too, so a later row with no score
 * can never hide the real call. Newest events first.
 */
export function sunCallsQuery(sinceIso: string, limit: number): string {
  const cols = SUN_PRED_COLS.split(", ")
    .map((c) => `p.${c}`)
    .join(", ");
  return `SELECT ${cols} FROM sun_event_predictions p
WHERE p.score IS NOT NULL AND p.lead_minutes >= 60 AND p.event_iso >= ${sqlStr(sinceIso)}
  AND p.as_of_hour_utc = (
    SELECT MAX(q.as_of_hour_utc) FROM sun_event_predictions q
    WHERE q.slug = p.slug AND q.event_kind = p.event_kind AND q.event_iso = p.event_iso
      AND q.score IS NOT NULL AND q.lead_minutes >= 60)
ORDER BY p.event_iso DESC, p.slug, p.event_kind
LIMIT ${limit}`;
}

/** Lifetime counts for the sun-color log (not limited to the evaluation window). */
export function sunLifetimeQuery(): string {
  return `SELECT COUNT(*) AS forecast_rows,
  COUNT(DISTINCT slug || '|' || event_kind || '|' || event_iso) AS forecast_events,
  SUM(CASE WHEN observed_score IS NOT NULL THEN 1 ELSE 0 END) AS paired_rows,
  MIN(archived_at) AS first_archived_at,
  (SELECT COUNT(*) FROM sun_event_observations) AS observations
FROM sun_event_predictions`;
}

export function sunObservationsQuery(sinceIso: string): string {
  return `SELECT slug, event_kind, event_date_local, cam_id, event_iso, view, observed_score, scored_at
FROM sun_event_observations WHERE event_iso >= ${sqlStr(sinceIso)} ORDER BY event_iso DESC, slug, cam_id`;
}
