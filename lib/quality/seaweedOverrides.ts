// The owner's verdict on ONE EXACT seaweed claim (docs/QUALITY_PLAN.md). Pure:
// lib/sources/sargassum.ts applies it to the cam feed before it summarizes, and
// lib/quality/overrides.ts (server only) loads the rows. The cam reader reads the same
// rows through GET /api/quality/overrides and applies the same rules
// (scripts/quality_watch.py; both are tested against lib/quality/verdictVectors.json).
//
// TARGET. A verdict names a claim by its cam and its frame: the frame's hash for a feed
// cam, else the frame's own time. It never acts on "the cam" in general, on a different
// frame of that cam, or on a reading that merely came before the tap.
//
// SUPERSESSION. Of the verdicts for one exact target, the latest wins (created time, then
// id). The server keeps one active verdict per alert; this rule also settles two alerts
// about one frame.
//
// ACTIONS, for the matching claim only:
//   publish  (Right, or Wrong with a corrected level of moderate or high): a reading still
//            HELD for that frame publishes at the verdict's level with `confirmedBy:
//            "owner"`, and that frame's pending claim becomes a confirmed one.
//   reject   (Wrong with none, low, or no value): a held reading for that frame is cleared
//            and nothing is published for it; its pending claim is removed. (The reader
//            also marks the cam DISPUTED for the rest of the day; the app needs no such
//            state, because the reader holds the cam's later claims.)
// Water, crowd and every other cam, and every other frame, stay as they were. The rolling
// history is left alone: it only stores the beach-wide worst, which cannot be split by cam.

export interface SeaweedOverride {
  id?: number;
  camId: string;
  action: "publish" | "reject";
  verdict?: "right" | "wrong";
  /** The level a 'publish' puts out. */
  level?: string | null;
  coveragePct?: number | null;
  note?: string | null;
  /** The claim's frame hash (first 20 hex), for feed cams. */
  frameSha?: string | null;
  /** The frame's own time, for courier cams, kept exactly as the reader wrote it. */
  frameAt?: string | null;
  claimedAt?: string | null;
  /** Beach-local date of the claim. */
  localDate?: string;
  /** ISO UTC: when the owner answered. */
  createdAtUtc: string;
  /** ISO UTC: the override ends here (the close of the beach-local day). */
  untilUtc: string;
}

interface FrameId {
  frameSha?: string | null;
  frameAt?: string | null;
}

/** True when two things name the same frame: equal hash prefixes when both have a hash, else equal frame time. Pure. */
export function sameFrame(a: FrameId, b: FrameId): boolean {
  if (a.frameSha && b.frameSha) {
    const n = Math.min(a.frameSha.length, b.frameSha.length);
    return n >= 8 && a.frameSha.slice(0, n) === b.frameSha.slice(0, n);
  }
  if (a.frameAt && b.frameAt) return a.frameAt === b.frameAt;
  return false;
}

/** The key of one exact target: cam plus frame. Null when the verdict has no frame identity (it cannot bind). Pure. */
export function targetKey(o: { camId: string } & FrameId): string | null {
  if (o.frameSha) return `${o.camId}|sha:${o.frameSha.slice(0, 20)}`;
  if (o.frameAt) return `${o.camId}|at:${o.frameAt}`;
  return null;
}

/**
 * The verdicts in force at `nowMs`: not ended, bound to a frame, and the LATEST per exact
 * target (by created time, then id). Oldest first. Pure.
 */
export function effectiveOverrides(list: SeaweedOverride[], nowMs: number): SeaweedOverride[] {
  const best = new Map<string, SeaweedOverride>();
  for (const o of list) {
    const until = Date.parse(o.untilUtc);
    const made = Date.parse(o.createdAtUtc);
    if (!Number.isFinite(until) || nowMs >= until || !Number.isFinite(made)) continue;
    const key = targetKey(o);
    if (!key) continue;
    const cur = best.get(key);
    if (!cur) {
      best.set(key, o);
      continue;
    }
    const curMade = Date.parse(cur.createdAtUtc);
    if (made > curMade || (made === curMade && (o.id ?? 0) > (cur.id ?? 0))) best.set(key, o);
  }
  return [...best.values()].sort((a, b) => Date.parse(a.createdAtUtc) - Date.parse(b.createdAtUtc) || (a.id ?? 0) - (b.id ?? 0));
}

interface OverridableReading extends FrameId {
  id?: string;
  level?: unknown;
  coveragePct?: unknown;
  note?: unknown;
  unconfirmed?: boolean;
  claim?: unknown;
  confirmedBy?: unknown;
}
interface OverridableGroup {
  cams?: OverridableReading[];
}
interface OverridableClaim extends FrameId {
  confirmed?: boolean;
  confirmedBy?: string;
}
interface OverridableFeed {
  morning?: OverridableGroup | null;
  latest?: OverridableGroup | null;
  lastSeaweed?: OverridableGroup | null;
  pendingClaims?: Record<string, OverridableClaim> | null;
}

const LEVELS = new Set(["none", "low", "moderate", "high"]);

function mapGroup<G extends OverridableGroup>(
  group: G | null | undefined,
  fn: (c: OverridableReading) => OverridableReading,
): G | null | undefined {
  if (!group || !Array.isArray(group.cams)) return group;
  let changed = false;
  const cams = group.cams.map((c) => {
    const next = fn(c);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...group, cams } : group;
}

function applyOne(feed: OverridableFeed, o: SeaweedOverride): void {
  const held = (c: OverridableReading) => c.id === o.camId && c.unconfirmed === true && sameFrame(c, o);
  const change = (c: OverridableReading): OverridableReading => {
    if (!held(c)) return c;
    if (o.action === "reject") return { ...c, level: "unknown", coveragePct: undefined, note: undefined, unconfirmed: undefined, claim: undefined };
    const own = (c.claim ?? {}) as { level?: unknown; coveragePct?: unknown; note?: unknown };
    const level = typeof o.level === "string" && LEVELS.has(o.level) ? o.level : own.level;
    if (typeof level !== "string" || !LEVELS.has(level)) return c;
    return {
      ...c,
      level,
      coveragePct: o.coveragePct ?? own.coveragePct ?? undefined,
      note: o.note ?? own.note ?? undefined,
      unconfirmed: undefined,
      claim: undefined,
      confirmedBy: "owner",
    };
  };
  feed.morning = mapGroup(feed.morning, change);
  feed.latest = mapGroup(feed.latest, change);
  feed.lastSeaweed = mapGroup(feed.lastSeaweed, change);
  const claims = feed.pendingClaims;
  const entry = claims?.[o.camId];
  if (claims && entry && sameFrame(entry, o)) {
    if (o.action === "reject") {
      const { [o.camId]: _removed, ...kept } = claims;
      feed.pendingClaims = kept;
    } else if (entry.confirmed !== true) {
      feed.pendingClaims = { ...claims, [o.camId]: { ...entry, confirmed: true, confirmedBy: "owner" } };
    }
  }
}

/** The feed with the owner's verdicts applied to their exact claims. Returns the same object when none is in force. Pure. */
export function applySeaweedOverrides<F extends OverridableFeed>(feed: F, overrides: SeaweedOverride[], nowMs: number): F {
  const live = effectiveOverrides(overrides, nowMs);
  if (!live.length) return feed;
  const out: F = { ...feed };
  for (const o of live) applyOne(out, o);
  return out;
}
