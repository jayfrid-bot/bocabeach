// R2 object keys for the webcam archive (docs/CAM_ARCHIVE_PLAN.md R2/R6/R9).
//
//   <slug>/<cam_id>/<local_date>/<HHmm>Z-<sha8>-<claim8>.jpg
//
// local_date is the beach-local date of the frame's display time. HHmm is the
// UTC time of the same instant, so the key is unambiguous across DST. sha8 is
// the first 8 hex characters of the JPEG's SHA-256. claim8 is the first 8 hex
// characters of the ingest's random claim id, so two claimants holding identical
// bytes never share a key and a stale claimant can never delete the winner's object.
//
// The validator is the only gate for a key that arrives from outside (the
// signed-URL route). It is strict on purpose: no path tricks, no uppercase,
// no extra segments, and a real calendar date.

/** A slug or cam id: lowercase letters, digits and single hyphens. */
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ID_LEN = 64;

const KEY_RE =
  /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(\d{4}-\d{2}-\d{2})\/([01]\d|2[0-3])([0-5]\d)Z-([0-9a-f]{8})-([0-9a-f]{8})\.jpg$/;

export interface ParsedFrameKey {
  slug: string;
  camId: string;
  localDate: string;
  /** UTC hour and minute of the display time. */
  utcHour: number;
  utcMinute: number;
  sha8: string;
  claim8: string;
}

export function isValidId(v: unknown): v is string {
  return typeof v === "string" && v.length <= MAX_ID_LEN && ID_RE.test(v);
}

/** True for YYYY-MM-DD that is a real calendar date (round-trips). */
export function isCalendarDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** First 8 hex characters of a SHA-256 hex digest. */
export function sha8(sha256Hex: string): string {
  return sha256Hex.slice(0, 8);
}

/** First 8 characters of a claim id (a UUID), which must be lowercase hex. */
export function claim8(claimId: string): string {
  const c = claimId.slice(0, 8);
  if (!/^[0-9a-f]{8}$/.test(c)) throw new Error("bad claim id");
  return c;
}

/**
 * Build the R2 key. `displayAtUtc` is the ISO display time (UTC); `localDate`
 * is its beach-local date. Throws on any malformed input, so a bug cannot
 * write a key the validator would later refuse.
 */
export function buildFrameKey(args: {
  slug: string;
  camId: string;
  localDate: string;
  displayAtUtc: string;
  sha256Hex: string;
  /** The ingest's claim id (UUID); its first 8 characters go in the key. */
  claimId: string;
}): string {
  const { slug, camId, localDate, displayAtUtc, sha256Hex, claimId } = args;
  if (!isValidId(slug) || !isValidId(camId)) throw new Error("bad slug or cam id");
  if (!isCalendarDate(localDate)) throw new Error("bad local date");
  const ms = Date.parse(displayAtUtc);
  if (!Number.isFinite(ms)) throw new Error("bad display time");
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error("bad sha256");
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${slug}/${camId}/${localDate}/${hh}${mm}Z-${sha8(sha256Hex)}-${claim8(claimId)}.jpg`;
}

/** Parse a key, or null when it is not exactly the shape above. */
export function parseFrameKey(key: unknown): ParsedFrameKey | null {
  if (typeof key !== "string" || key.length > 200) return null;
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const [, slug, camId, localDate, hh, mm, hash, claim] = m;
  if (slug.length > MAX_ID_LEN || camId.length > MAX_ID_LEN) return null;
  if (!isCalendarDate(localDate)) return null;
  return { slug, camId, localDate, utcHour: Number(hh), utcMinute: Number(mm), sha8: hash, claim8: claim };
}

/** True when `key` has exactly the archive key shape. */
export function isValidFrameKey(key: unknown): key is string {
  return parseFrameKey(key) !== null;
}

/** The R2 prefix that holds every frame of one cam. */
export function camPrefix(slug: string, camId: string): string {
  if (!isValidId(slug) || !isValidId(camId)) throw new Error("bad slug or cam id");
  return `${slug}/${camId}/`;
}

// --- Quality frames --------------------------------------------------------
// The exact image behind a quality alert (docs/QUALITY_PLAN.md): the cam reader
// sends a shrunk copy with the alert, and the app keeps it in the same bucket
// under its own prefix, so it is never mistaken for an archive frame and never
// collides with one:
//
//   quality/<slug>/<cam_id>/<utc_date>/<HHmmss>Z-<sha8>.jpg
//
// utc_date and HHmmss are the UTC time of the frame; sha8 is the first 8 hex
// characters of the SHA-256 of THESE bytes (the shrunk copy, not the original).

const QUALITY_KEY_RE =
  /^quality\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(\d{4}-\d{2}-\d{2})\/([01]\d|2[0-3])([0-5]\d)([0-5]\d)Z-([0-9a-f]{8})\.jpg$/;

export interface ParsedQualityKey {
  slug: string;
  camId: string;
  utcDate: string;
  sha8: string;
}

/** Build a quality-frame key from the frame's UTC time. Throws on malformed input. */
export function buildQualityFrameKey(args: { slug: string; camId: string; atMs: number; sha256Hex: string }): string {
  const { slug, camId, atMs, sha256Hex } = args;
  if (!isValidId(slug) || !isValidId(camId)) throw new Error("bad slug or cam id");
  if (!Number.isFinite(atMs)) throw new Error("bad time");
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error("bad sha256");
  const d = new Date(atMs);
  const p = (n: number) => String(n).padStart(2, "0");
  const date = d.toISOString().slice(0, 10);
  return `quality/${slug}/${camId}/${date}/${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z-${sha8(sha256Hex)}.jpg`;
}

/** Parse a quality-frame key, or null when it is not exactly the shape above. */
export function parseQualityFrameKey(key: unknown): ParsedQualityKey | null {
  if (typeof key !== "string" || key.length > 220) return null;
  const m = QUALITY_KEY_RE.exec(key);
  if (!m) return null;
  const [, slug, camId, utcDate, , , , hash] = m;
  if (slug.length > MAX_ID_LEN || camId.length > MAX_ID_LEN || !isCalendarDate(utcDate)) return null;
  return { slug, camId, utcDate, sha8: hash };
}

export function isQualityFrameKey(key: unknown): key is string {
  return parseQualityFrameKey(key) !== null;
}

/** A key the signed-image route may serve: an archive frame or a quality frame. */
export function isSignableKey(key: unknown): key is string {
  return isValidFrameKey(key) || isQualityFrameKey(key);
}

/** The slug and cam id of either kind of key, or null. */
export function camOfKey(key: unknown): { slug: string; camId: string } | null {
  const a = parseFrameKey(key);
  if (a) return { slug: a.slug, camId: a.camId };
  const q = parseQualityFrameKey(key);
  return q ? { slug: q.slug, camId: q.camId } : null;
}

/** The R2 prefix that holds every quality frame of one cam. */
export function qualityCamPrefix(slug: string, camId: string): string {
  if (!isValidId(slug) || !isValidId(camId)) throw new Error("bad slug or cam id");
  return `quality/${slug}/${camId}/`;
}
