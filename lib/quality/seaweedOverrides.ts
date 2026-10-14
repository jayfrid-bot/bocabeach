// The owner's verdict on a cam's seaweed claim (docs/QUALITY_PLAN.md). Pure:
// lib/sources/sargassum.ts applies it to the cam feed before it summarizes, and
// lib/quality/overrides.ts (server only) loads the rows. The cam reader reads the
// same rows through GET /api/quality/overrides (scripts/quality_watch.py).
//
// An override (migrations/0019 `quality_overrides`) has a cam, a verdict, a start
// time and an end. It acts on a reading only when it has not ended (the end is the
// close of the beach-local day) and the reading was scored at or before the
// override started. A reading with no readable scoring time counts as older. A
// NEWER fresh reading from the cam is never touched: the cam speaks again and the
// override has nothing left to act on.
//
// WRONG: the claim was false. For that cam only:
//   - its seaweed level, coverage and note are cleared in every capture group
//     (morning, latest, lastSeaweed), and its held-jump marks are removed;
//   - its entry in `pendingClaims` is dropped, so the claim no longer counts as an
//     open question.
// RIGHT: the claim was true. For that cam only:
//   - a reading still HELD (`unconfirmed`) publishes the level the owner judged,
//     with `confirmedBy: "owner"`;
//   - its held entry in `pendingClaims` becomes a confirmed one (`confirmedBy: "owner"`).
// Water, crowd and every other cam stay as they were. The rolling history is left
// alone: it only stores the beach-wide worst, which cannot be split by cam.

export interface SeaweedOverride {
  camId: string;
  /** Default 'wrong'. */
  verdict?: "wrong" | "right";
  /** ISO UTC: readings scored at or before this are acted on. */
  createdAtUtc: string;
  /** ISO UTC: the override ends here. */
  untilUtc: string;
  /** The claim the owner judged; a 'right' override publishes it. */
  claim?: { level?: string | null; coveragePct?: number | null; note?: string | null } | null;
}

interface OverridableReading {
  id?: string;
  scoredAt?: string;
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
interface OverridableClaim {
  claimedAt?: string;
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

/** The overrides still running at `nowMs`. */
export function liveOverrides(list: SeaweedOverride[], nowMs: number): SeaweedOverride[] {
  return list.filter((o) => {
    const until = Date.parse(o.untilUtc);
    return Number.isFinite(until) && nowMs < until && Number.isFinite(Date.parse(o.createdAtUtc));
  });
}

function atOrBefore(stamp: unknown, limitMs: number): boolean {
  const t = typeof stamp === "string" ? Date.parse(stamp) : NaN;
  return !Number.isFinite(t) || t <= limitMs;
}

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

function applyWrong(feed: OverridableFeed, o: SeaweedOverride): void {
  const limit = Date.parse(o.createdAtUtc);
  const strip = (c: OverridableReading): OverridableReading =>
    c.id === o.camId && atOrBefore(c.scoredAt, limit)
      ? { ...c, level: "unknown", coveragePct: undefined, note: undefined, unconfirmed: undefined }
      : c;
  feed.morning = mapGroup(feed.morning, strip);
  feed.latest = mapGroup(feed.latest, strip);
  feed.lastSeaweed = mapGroup(feed.lastSeaweed, strip);
  const claims = feed.pendingClaims;
  if (claims && o.camId in claims && atOrBefore(claims[o.camId]?.claimedAt, limit)) {
    const { [o.camId]: _dropped, ...kept } = claims;
    feed.pendingClaims = kept;
  }
}

function applyRight(feed: OverridableFeed, o: SeaweedOverride): void {
  const limit = Date.parse(o.createdAtUtc);
  const publish = (c: OverridableReading): OverridableReading => {
    if (c.id !== o.camId || c.unconfirmed !== true || !atOrBefore(c.scoredAt, limit)) return c;
    const held = (c.claim ?? {}) as { level?: unknown; coveragePct?: unknown; note?: unknown };
    const judged = o.claim ?? {};
    const level = typeof judged.level === "string" && LEVELS.has(judged.level) ? judged.level : held.level;
    if (typeof level !== "string" || !LEVELS.has(level)) return c;
    return {
      ...c,
      level,
      coveragePct: judged.coveragePct ?? held.coveragePct ?? undefined,
      note: judged.note ?? held.note ?? undefined,
      unconfirmed: undefined,
      claim: undefined,
      confirmedBy: "owner",
    };
  };
  feed.morning = mapGroup(feed.morning, publish);
  feed.latest = mapGroup(feed.latest, publish);
  feed.lastSeaweed = mapGroup(feed.lastSeaweed, publish);
  const claims = feed.pendingClaims;
  const claim = claims?.[o.camId];
  if (claims && claim && claim.confirmed !== true && atOrBefore(claim.claimedAt, limit)) {
    feed.pendingClaims = { ...claims, [o.camId]: { ...claim, confirmed: true, confirmedBy: "owner" } };
  }
}

/** The feed with the owner's verdicts applied. Returns the same object when no override is running. Pure. */
export function applySeaweedOverrides<F extends OverridableFeed>(feed: F, overrides: SeaweedOverride[], nowMs: number): F {
  const live = liveOverrides(overrides, nowMs);
  if (!live.length) return feed;
  // Oldest verdict first, so a later one on the same cam wins.
  live.sort((a, b) => Date.parse(a.createdAtUtc) - Date.parse(b.createdAtUtc));
  const out: F = { ...feed };
  for (const o of live) (o.verdict === "right" ? applyRight : applyWrong)(out, o);
  return out;
}
