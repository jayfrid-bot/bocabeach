// Logic for scripts/cam_archive_remove.ts (docs/CAM_ARCHIVE_PLAN.md R6): erase
// every stored frame of one cam, on a cam owner's request. The script is a thin
// wrapper that supplies `wrangler`; everything that can go wrong lives here so
// it is tested with fakes.
//
//   npx vite-node -c vitest.config.ts scripts/cam_archive_remove.ts <slug> <camId> [--dry-run] [--yes]
//
// Default is a READ-ONLY dry run: list what exists and change nothing. Deleting
// needs `--yes`. `--dry-run` always wins over `--yes`.
//
// wrangler has no `r2 object list`, so the objects under `<slug>/<camId>/` are
// listed through R2's S3-compatible API (lib/camFrames/r2s3.ts) when the
// credentials are in the environment (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY; see scripts/cam_archive_remove.ts). The delete set is
// that listing plus the `r2_key` of every D1 row. Without credentials the set is
// the D1 rows' keys only, and the script says so loudly: an orphan object with
// no row (an R2 put that succeeded and whose cleanup also failed) would remain
// until the bucket's 367-day lifecycle rule removes it.
// R2 objects go FIRST and D1 rows only after every object delete succeeded, so a
// failed run can simply be repeated: no row is dropped while its object may
// still exist.
//
// Set `archive: false` on the cam in config/locations.ts and deploy BEFORE
// erasing, or the next capture tick stores a new frame.

import { camPrefix, isValidFrameKey, isValidId } from "@/lib/camFrames/keys";
import { lookupCam } from "@/lib/camFrames/manifest";

export const R2_BUCKET = "isitbeachday-cam-frames";
export const D1_DATABASE = "isitbeachday-plus";

export interface RemoveArgs {
  slug: string;
  camId: string;
  /** True unless `--yes` was given (and `--dry-run` forces it back to true). */
  dryRun: boolean;
}

export function parseRemoveArgs(argv: string[]): RemoveArgs | { error: string } {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const pos = argv.filter((a) => !a.startsWith("--"));
  for (const f of flags) {
    if (f !== "--dry-run" && f !== "--yes") return { error: `unknown flag ${f}` };
  }
  if (pos.length !== 2) return { error: "usage: cam_archive_remove <slug> <camId> [--dry-run] [--yes]" };
  const [slug, camId] = pos;
  if (!isValidId(slug) || !isValidId(camId)) return { error: "slug and camId must be lowercase letters, digits and hyphens" };
  return { slug, camId, dryRun: flags.has("--dry-run") || !flags.has("--yes") };
}

/** A SQL string literal. Callers pass only values that passed isValidId. */
function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export function selectFramesSql(slug: string, camId: string): string {
  return `SELECT r2_key, bytes, state, local_date FROM cam_frames WHERE slug = ${sqlStr(slug)} AND cam_id = ${sqlStr(camId)} ORDER BY slot_utc`;
}

export function deleteFramesSql(slug: string, camId: string): string {
  return `DELETE FROM cam_frames WHERE slug = ${sqlStr(slug)} AND cam_id = ${sqlStr(camId)}`;
}

export function countFramesSql(slug: string, camId: string): string {
  return `SELECT COUNT(*) AS n FROM cam_frames WHERE slug = ${sqlStr(slug)} AND cam_id = ${sqlStr(camId)}`;
}

export interface FrameListRow {
  r2_key: string;
  bytes: number;
  state: string;
  local_date: string;
}

export interface RemovalPlan {
  keys: string[];
  rows: number;
  bytes: number;
  pending: number;
  firstDate: string | null;
  lastDate: string | null;
}

/**
 * Turn the listing into a plan. Refuses (throws) if any key is not an archive
 * key or is not under this cam's prefix: a corrupt row must never make the
 * script delete somewhere else.
 */
export function planRemoval(slug: string, camId: string, rows: FrameListRow[]): RemovalPlan {
  const prefix = camPrefix(slug, camId);
  const keys: string[] = [];
  let bytes = 0;
  let pending = 0;
  let firstDate: string | null = null;
  let lastDate: string | null = null;
  for (const r of rows) {
    if (!isValidFrameKey(r.r2_key) || !r.r2_key.startsWith(prefix)) {
      throw new Error(`refusing: row key ${JSON.stringify(r.r2_key)} is not under ${prefix}`);
    }
    keys.push(r.r2_key);
    bytes += Number(r.bytes) || 0;
    if (r.state === "pending") pending += 1;
    if (firstDate === null || r.local_date < firstDate) firstDate = r.local_date;
    if (lastDate === null || r.local_date > lastDate) lastDate = r.local_date;
  }
  return { keys, rows: rows.length, bytes, pending, firstDate, lastDate };
}

export interface RemovalIo {
  /** Run a SQL statement against production D1 and return its rows. */
  d1: (sql: string) => Promise<Record<string, unknown>[]>;
  /** Every R2 object key under a prefix (S3 API). Absent when no R2 credentials are set. */
  r2List?: (prefix: string) => Promise<string[]>;
  /** Delete one R2 object. Resolves when it is gone (or never existed). */
  r2Delete: (key: string) => Promise<void>;
  log: (line: string) => void;
}

export interface RemovalOutcome {
  dryRun: boolean;
  plan: RemovalPlan;
  /** Objects found under the prefix that no D1 row points at (null when R2 was not listed). */
  orphans: number | null;
  deletedObjects: number;
  deletedRows: number;
  /** Rows still present after a real run (should be 0). */
  remainingRows: number | null;
}

/** Run the removal. `concurrency` bounds parallel R2 deletes. */
export async function runRemoval(args: RemoveArgs, io: RemovalIo, concurrency: number = 6): Promise<RemovalOutcome> {
  const { slug, camId, dryRun } = args;
  const rows = (await io.d1(selectFramesSql(slug, camId))) as unknown as FrameListRow[];
  const plan = planRemoval(slug, camId, rows);

  // The real contents of the prefix, when we can list it.
  const prefix = camPrefix(slug, camId);
  let orphans: number | null = null;
  let toDelete = plan.keys;
  if (io.r2List) {
    const listed = await io.r2List(prefix);
    for (const k of listed) {
      if (!k.startsWith(prefix) || k.includes("..")) throw new Error(`refusing: listed key ${JSON.stringify(k)} is not under ${prefix}`);
    }
    const known = new Set(plan.keys);
    orphans = listed.filter((k) => !known.has(k)).length;
    toDelete = [...new Set([...plan.keys, ...listed])];
    io.log(`R2 holds ${listed.length} object(s) under ${prefix}; ${orphans} have no D1 row`);
  } else {
    io.log(
      "WARNING: R2 credentials are not set (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY), so only the objects " +
        "named by D1 rows can be deleted. Orphan objects with no row may remain until the 367-day lifecycle rule removes them.",
    );
  }

  const cfg = lookupCam(slug, camId);
  if (cfg.status === "unknown") io.log(`note: ${slug}/${camId} is not in config/locations.ts (stored frames can still be erased)`);
  if (cfg.status === "ok" && !dryRun) {
    io.log(`WARNING: ${slug}/${camId} is still archived in config. Set archive: false and deploy first, or a new frame will be stored.`);
  }
  const mb = (plan.bytes / 1_048_576).toFixed(1);
  io.log(
    `${slug}/${camId}: ${plan.rows} rows (${plan.pending} pending), ${mb} MB, ` +
      `${plan.firstDate ?? "-"} to ${plan.lastDate ?? "-"}; ${toDelete.length} object(s) to delete`,
  );

  if (dryRun) {
    io.log("dry run: nothing deleted. Re-run with --yes to delete the objects, then the rows.");
    for (const k of toDelete.slice(0, 5)) io.log(`  would delete ${R2_BUCKET}/${k}`);
    if (toDelete.length > 5) io.log(`  ... and ${toDelete.length - 5} more`);
    return { dryRun: true, plan, orphans, deletedObjects: 0, deletedRows: 0, remainingRows: null };
  }

  let next = 0;
  let deletedObjects = 0;
  const failures: string[] = [];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, toDelete.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= toDelete.length) return;
      try {
        await io.r2Delete(toDelete[i]);
        deletedObjects += 1;
      } catch (e) {
        failures.push(`${toDelete[i]}: ${(e as Error).message}`);
      }
    }
  });
  await Promise.all(workers);
  io.log(`deleted ${deletedObjects}/${toDelete.length} objects`);
  if (failures.length > 0) {
    for (const f of failures.slice(0, 10)) io.log(`  failed: ${f}`);
    throw new Error(`${failures.length} object deletes failed; D1 rows kept so you can re-run`);
  }

  await io.d1(deleteFramesSql(slug, camId));
  const left = await io.d1(countFramesSql(slug, camId));
  const remainingRows = Number((left[0] as { n?: unknown } | undefined)?.n ?? NaN);
  io.log(`deleted rows; ${Number.isFinite(remainingRows) ? remainingRows : "unknown"} left`);
  return {
    dryRun: false,
    plan,
    orphans,
    deletedObjects,
    deletedRows: plan.rows,
    remainingRows: Number.isFinite(remainingRows) ? remainingRows : null,
  };
}
