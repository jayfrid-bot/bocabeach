// The at-beach alert run: everyone who is standing on a beach right now, with
// the alerts they are due.
//
// Shape of one run:
//   listArmed(now)            → entitled devices inside a live presence window
//   ∩ listPushable()          → …that we can actually push to
//   load the strike feed ONCE → per device: strikes from THEIR fix
//   getConditions(slug)       → memoized per beach per run
//   rainForFix(...)           → memoized per beach (radar) or per cell (forecast)
//   evaluateAtBeach           → the pure rules
//   splitByDedup              → the 30-minute repeat window
//   claimSend + deliver + markAlert + markSent → claim, send, then remember
//
// External calls scale with occupied beaches and cells, not with people.
//
// One device's failure never sinks the run: it is caught, counted, and the next
// device is evaluated.

import { getConditions } from "@/lib/conditions";
import { getLocation } from "@/config/locations";
import { summarizeStrikes, type LightningFeed } from "@/lib/sources/lightning";
import { safetyAlertsEnabled } from "@/lib/push/notify";
import { distanceToBeachMi } from "@/lib/location/shoreDistance";
import { repeatWindow, sendClaimKey } from "@/lib/db/sendClaims";
import type { DeviceStore, LiveActivityRow } from "@/lib/db/store";
import type { ArmedDevice, PushableDevice } from "@/lib/db/types";
import type { ConditionsResponse } from "@/lib/types";
import { evaluateAtBeach, RAIN_MEMORY_MS, type EvaluateAtBeachResult } from "@/lib/alerts/evaluate";
import { scopeKey } from "@/lib/alerts/catalog";
import { splitByDedup } from "@/lib/alerts/dedup";
import { loadLightningFeed } from "@/lib/alerts/lightningFeed";
import { newRainCache, rainForFix, type RainRead } from "@/lib/alerts/rain";
import {
  contentStateFromConditions,
  hashContentState,
  type BeachSessionContentState,
} from "@/lib/liveActivity/state";
import {
  decideLiveActivitySend,
  safeParseState,
  LIVE_ACTIVITY_DISMISSAL_AHEAD_MS,
  LIVE_ACTIVITY_MAX_SESSION_MS,
} from "@/lib/liveActivity/server/decide";
import { getApns, isDeadToken, openLiveActivitySessions, type LiveActivitySessions } from "@/lib/push/apns";
import {
  SubrequestBudget,
  STAGE_RESERVE,
  pushRunMaxBeaches,
  pushRunMaxRainCells,
  timeRoundRobinSlice,
} from "@/lib/alerts/budget";

/** One Live Activity push, in the shape lib/push/apns.ts's
 *  `sendLiveActivityUpdate` wants, minus the transport plumbing — what a
 *  caller-injected `sendLiveActivity` (tests) or the default APNs-backed one
 *  (production) both implement. */
export interface LiveActivitySendArgs {
  contentState: BeachSessionContentState;
  event: "update" | "end";
  timestampMs: number;
  staleDateMs?: number;
  dismissalDateMs?: number;
  relevanceScore?: number;
  priority: 5 | 10;
  /** Codex review #5 — routes to the sandbox or production APNs gateway
   *  regardless of this server's own `APNS_PRODUCTION`; `null` (a row from
   *  before `apnsEnvironment` was recorded) falls back to that server default. */
  environment: "production" | "sandbox" | null;
}

export interface LiveActivitySendResult {
  ok: boolean;
  /** True for an APNs 410/BadDeviceToken — the caller ends only THIS
   *  activity's row, never touches the device's normal push token. */
  dead: boolean;
  status?: number;
}

const LIVE_ACTIVITY_UPDATE_WINDOW_MS = 60 * 1000;
const LIVE_ACTIVITY_END_SWEEP_WINDOW_MS = 5 * 60 * 1000;
/** Ended rows older than this are dropped (docs/LIVE_ACTIVITY_PLAN.md: "24-72h"). */
const LIVE_ACTIVITY_RETENTION_MS = 72 * 60 * 60 * 1000;

// --- Bounded fan-out (Codex review #2) --------------------------------------
//
// Workers Free is 50 subrequests per request. One run's worst case:
//   ~25 subrequests  — one cold `getConditions(slug)` pipeline (usually far
//                       fewer, memoized per beach per run and often cache-hot)
//   + 1               — the shared lightning feed load
//   + up to LA_MAX_PER_RUN update sends + LA_MAX_ENDS_PER_RUN end sends,
//                       each ONE APNs HTTP/2 stream over a reused connection
//   + up to `armed.length` ordinary alert pushes (already its own bounded
//                       set — one device, one claimed alert, one send)
// Capping the two Live Activity paths at 10 each keeps their worst-case
// contribution at 20 regardless of how many activities are armed, leaving
// headroom for the conditions pipeline and the ordinary alert sends in the
// same request. `LA_MAX_PER_RUN`/`LA_MAX_ENDS_PER_RUN` are env-overridable
// for a paid plan with a higher subrequest ceiling.
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const LA_MAX_PER_RUN = envInt("LA_MAX_PER_RUN", 10);
const LA_MAX_ENDS_PER_RUN = envInt("LA_MAX_ENDS_PER_RUN", 10);

/** The push the caller actually sends. Mirrors `PushDecision` in lib/push/notify. */
export interface AtBeachPush {
  tag: string;
  title: string;
  body: string;
  url: string;
}

export interface AtBeachDeps {
  store: DeviceStore;
  /** Run time, ms. Injected so tests own the clock. */
  now: number;
  /**
   * Send one push. Return `dead: true` for a token the transport rejected as
   * gone; the run stops pushing to that device and reports it.
   */
  deliver: (sub: PushableDevice, msg: AtBeachPush) => Promise<{ ok: boolean; dead: boolean }>;
  /** Called once for a dead token, before the device is dropped from the run. */
  onDeadToken?: (sub: PushableDevice) => Promise<void>;
  /** Overridable feed loaders — the tests hand in fixtures instead of the network. */
  loadFeed?: () => Promise<LightningFeed | null>;
  loadConditions?: (slug: string) => Promise<ConditionsResponse | null>;
  loadRain?: (
    lat: number,
    lon: number,
    slug: string,
    nowMs: number,
    radar: ConditionsResponse["snapshot"]["precipRadar"] | null,
  ) => Promise<RainRead | null>;
  /**
   * Send one Live Activity push. Tests inject a fake so they never touch
   * real APNs env/network. When omitted, the run lazily opens its own
   * lib/push/apns.ts session (a no-op `{ok:false,dead:false}` when APNs
   * isn't configured) and closes it when the run finishes.
   */
  sendLiveActivity?: (token: string, args: LiveActivitySendArgs) => Promise<LiveActivitySendResult>;
  /** Shared subrequest budget for the whole `/api/push/run` request (round-2
   *  #4, lib/alerts/budget.ts) — the SAME instance the caller's home-digest
   *  loop is spending from, so the two loops in one request never together
   *  exceed Workers Free's per-request ceiling. Omitted (tests, and any
   *  caller that doesn't care) defaults to effectively unlimited. */
  budget?: SubrequestBudget;
}

export interface AtBeachCounts {
  /** Devices with a live presence window. */
  devices: number;
  /** …of those, the ones we ran the rules for. */
  evaluated: number;
  /** Pushes delivered. */
  sent: number;
  /**
   * Everything the run declined to send: a device with no usable push token or
   * an unknown beach, each alert held back by its repeat window, and each
   * alert lost to a concurrent run's send claim (#14).
   */
  skipped: number;
  /** Devices that threw. The run continued. */
  errors: number;
  /** Dead tokens dropped. */
  pruned: number;
  /**
   * Work explicitly left for next tick for lack of subrequest budget (Codex
   * round-3 #4) — a whole stage (lightning feed, at-beach evaluation, Live
   * Activity updates, Live Activity ends) sitting out the run because it
   * didn't clear its `STAGE_RESERVE`, or an individual ordinary alert send
   * or Live Activity send that lost a `budget.take()` check. Distinct from
   * `skipped` (a repeat-window hold or a lost send-claim race — nothing to
   * do with budget) so the two causes don't get conflated in the response.
   */
  deferred: number;
}

const EMPTY: AtBeachCounts = { devices: 0, evaluated: 0, sent: 0, skipped: 0, errors: 0, pruned: 0, deferred: 0 };

/**
 * A device fix older than this cannot be trusted to say where the person is
 * NOW — a phone that grabbed a fix at home, then walked around all day
 * without a foreground refresh, is not "at" wherever that fix pointed (#6).
 */
export const FIX_MAX_AGE_MS = 30 * 60 * 1000;
/** A fix worse than this (GPS-off, cell-tower-only) is not precise enough to
 *  place someone at one beach rather than the next one over. */
export const FIX_MAX_ACCURACY_M = 500;
/** A fix this far from the ARMED beach belongs to a different day, not this
 *  arm — manually monitoring a distant destination must not borrow it. */
export const FIX_MAX_DISTANCE_MI = 15 * 0.621371; // 15 km
/** A fix dated further ahead of the server clock than this is not "fresh", it
 *  is wrong (LOC-09): a negative age must never pass the staleness check. The
 *  presence route rejects such fixes outright; this is the belt for rows that
 *  were stored before it did. */
export const FIX_MAX_FUTURE_SKEW_MS = 60 * 1000;

export interface Fix {
  lat: number;
  lon: number;
  /** Where this fix came from — kept on the evaluated context for debugging
   *  a hazard that used the wrong geometry (#6). */
  fixSource: "device" | "beach";
}

/**
 * Where to measure hazard geometry from: the person's own fix when it is
 * fresh, accurate, and near the beach they armed — the beach centroid
 * otherwise, explicitly and every time (never a silent "whatever the fix
 * said"). Enforced server-side so a stale or distant client fix can never
 * widen (or wrongly narrow) who gets warned.
 */
export function fixOf(
  armed: ArmedDevice,
  fallback: { lat: number; lon: number; shore?: [number, number][] },
  nowMs: number,
): Fix {
  const beach: Fix = { lat: fallback.lat, lon: fallback.lon, fixSource: "beach" };
  const { lat, lon, fixAt, accuracyM } = armed.presence;
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return beach;
  if (fixAt == null || !Number.isFinite(fixAt) || nowMs - fixAt > FIX_MAX_AGE_MS) return beach;
  if (fixAt - nowMs > FIX_MAX_FUTURE_SKEW_MS) return beach; // future-dated → not trusted (LOC-09)
  if (accuracyM != null && Number.isFinite(accuracyM) && accuracyM > FIX_MAX_ACCURACY_M) return beach;
  // Shoreline-aware, same rule as establishesArrival/the /api/hazards gate
  // (lib/location/shoreDistance.ts): a fix near Boca's shore but far from its
  // pin must not be quietly discarded here and silently fall back to the pin.
  if (distanceToBeachMi(lat, lon, fallback) > FIX_MAX_DISTANCE_MI) return beach;
  return { lat, lon, fixSource: "device" };
}

/**
 * The last time this device heard anything about rain AT THIS BEACH (for
 * "rain clearing"). Scoped by slug (LOC-08): a wet spell at A must never make
 * a dry B say "clearing".
 */
async function recentRain(
  store: DeviceStore,
  deviceId: string,
  slug: string,
  now: number,
): Promise<{ soonAt: number | null; wetAt: number | null }> {
  const [soon, wet] = await Promise.all([
    store.lastAlert(deviceId, scopeKey("rain-soon", slug)),
    store.lastAlert(deviceId, scopeKey("rain-wet", slug)),
  ]);
  const fresh = (at: number | undefined): number | null =>
    at != null && now - at <= RAIN_MEMORY_MS ? at : null;
  return { soonAt: fresh(soon?.sentAt), wetAt: fresh(wet?.sentAt) };
}

export async function runAtBeachAlerts(deps: AtBeachDeps): Promise<AtBeachCounts> {
  // The kill switch. Off means the engine does not even read the store.
  if (!safetyAlertsEnabled()) return { ...EMPTY };

  const { store, now } = deps;
  const counts: AtBeachCounts = { ...EMPTY };
  // Effectively-unlimited fallback (round-2 #4) — every test and every other
  // caller of this engine on its own (never sharing a request with the home
  // digest loop) never needs to think about the budget at all.
  const budget = deps.budget ?? new SubrequestBudget(Number.MAX_SAFE_INTEGER);

  // Live Activity push sender: caller-injected (tests), or a lazily-opened
  // lib/push/apns.ts session this run owns and closes itself — independent
  // of whatever session app/api/push/run/route.ts opened for ordinary
  // alerts, so this file never has to reach into that route's plumbing.
  // A boxed reference, not a bare `let` — a nested closure reassigning a
  // plain `let` confuses TS's control-flow narrowing into typing the
  // `finally` block's read as `never` (reproduced independently; the box
  // sidesteps it and reads exactly as intended: session opened at most once,
  // closed once, whether or not it was ever actually used).
  const sessionBox: { current: LiveActivitySessions | null } = { current: null };
  const sendLiveActivity =
    deps.sendLiveActivity ??
    (async (token: string, args: LiveActivitySendArgs): Promise<LiveActivitySendResult> => {
      if (!sessionBox.current) {
        const cfg = getApns();
        if (!cfg) return { ok: false, dead: false };
        try {
          sessionBox.current = openLiveActivitySessions(cfg, Math.floor(now / 1000));
        } catch {
          return { ok: false, dead: false };
        }
      }
      const r = await sessionBox.current.sendLiveActivityUpdate(token, args, args.environment);
      return { ok: r.ok, dead: isDeadToken(r), status: r.status };
    });

  try {
    const armed = await store.listArmed(now); // entitled + inside the window already
    counts.devices = armed.length;

    // Keyed lookup of each armed device's OWN presence/entitlement — the
    // expiry reconciliation below (Codex review #3) needs the CURRENT
    // armedUntil/entitlementUntil, never the value frozen at registration.
    const armedByKey = new Map<string, ArmedDevice>();
    for (const a of armed) armedByKey.set(`${a.device.id}|${a.presence.slug}`, a);

    // --- Live Activity due-end sweep: every 'active' row past its own
    // (recomputed) expiry, or whose armed presence has disappeared entirely
    // (including a device `listArmed` no longer returns at all) — run this
    // BEFORE the early return below, so a run with zero armed devices still
    // ends every orphaned activity instead of leaving them to time out on
    // their own. Bounded to LA_MAX_ENDS_PER_RUN (Codex review #2): a row past
    // its budget simply waits for next tick's sweep, same backstop shape as
    // the update fan-out's own bound below.
    const liveByDevice = new Map<string, LiveActivityRow[]>();
    // Safety first: this pass only WORKS OUT which rows are still armed
    // (feeding `liveByDevice`/`dueThisRun` below) and which are due to end —
    // it spends no subrequest budget itself (`setLiveActivityExpiry` and
    // `purgeLiveActivities` are D1 writes, not subrequests). The actual
    // end-sweep SENDS are deferred to `pendingEnds`, processed only after
    // every armed device's ordinary hazard alerts have been evaluated and
    // sent below, so Live Activity work can never spend the budget ordinary
    // safety alerts still need.
    const pendingEnds: { row: LiveActivityRow; endClaimKey: string }[] = [];
    try {
      const activeRows = await store.listActiveLiveActivities(now);
      let dueThisSweep = 0;
      for (let row of activeRows) {
        const armedEntry = armedByKey.get(`${row.deviceId}|${row.beachSlug}`);
        // Expiry reconciliation (Codex review #3): recomputed EVERY pass from
        // the CURRENT presence/entitlement, never the value frozen at
        // registration or at a prior rotation — a presence extension can
        // raise it, a shrunk presence/lapsed entitlement/rotation can only
        // lower it, and it can never exceed this row's own ORIGINAL
        // startedAt + 8h even across a rotation.
        const effectiveExpiresAt = armedEntry
          ? Math.min(
              armedEntry.presence.armedUntil,
              row.startedAt + LIVE_ACTIVITY_MAX_SESSION_MS,
              armedEntry.device.entitlementUntil ?? Infinity,
            )
          : -Infinity; // no armed presence at all → always due to end
        const stillArmed = !!armedEntry && effectiveExpiresAt > now;
        if (stillArmed) {
          if (effectiveExpiresAt !== row.expiresAt) {
            await store.setLiveActivityExpiry(row.activityId, effectiveExpiresAt);
            row = { ...row, expiresAt: effectiveExpiresAt };
          }
          const arr = liveByDevice.get(row.deviceId) ?? [];
          arr.push(row);
          liveByDevice.set(row.deviceId, arr);
          continue;
        }
        if (dueThisSweep >= LA_MAX_ENDS_PER_RUN) continue; // leave for next run's sweep
        dueThisSweep += 1;
        // Due to end. Claimed like any other send, so the 5-min cron and the
        // hourly backstop can't both fire the same "end" event. The claim
        // itself (and the actual send) happen later, in `pendingEnds`'s pass
        // — only the row is picked out here.
        const endClaimKey = sendClaimKey(
          row.deviceId,
          `liveactivity-end:${row.activityId}`,
          repeatWindow(now, LIVE_ACTIVITY_END_SWEEP_WINDOW_MS),
        );
        pendingEnds.push({ row, endClaimKey });
      }
      await store.purgeLiveActivities(now - LIVE_ACTIVITY_RETENTION_MS);
    } catch (e) {
      console.error("alerts: live activity sweep failed", e);
    }

    // Runs one due-end row: claim → allocate seq → (only now) spend the
    // budget → send. Moving `budget.take(1)` to immediately before the APNs
    // call (Codex round-3, tightened) means a claim this run LOSES to a
    // racing run spends nothing — the old order took the unit before the
    // claim, burning budget even when another run ended up owning the send.
    const runPendingEnd = async ({ row, endClaimKey }: { row: LiveActivityRow; endClaimKey: string }) => {
      // Budget check first (round-2 #4, stage reserve Codex round-3 #4b):
      // the end sweep is unbounded work-wise except for LA_MAX_ENDS_PER_RUN,
      // and every send below is one APNs subrequest — short-circuits before
      // claiming, so a run that's out of budget doesn't burn the claim on a
      // send it can't make (the row just waits for next tick's sweep, same
      // as any other row past LA_MAX_ENDS_PER_RUN).
      if (budget.left < STAGE_RESERVE.liveActivityEnds) {
        counts.deferred += 1;
        return;
      }
      if (!(await store.claimSend(endClaimKey, now))) {
        // Another run already won this end's claim — it owns ending this
        // row; nothing more to do here this pass.
        return;
      }
      const lastState = safeParseState(row.lastStateJson);
      const endState: BeachSessionContentState = lastState ?? { score: 0, updatedAt: now, unavailable: true };
      // Allocate the seq AND timestamp atomically together (Codex round-3
      // fix), same reasoning as the update path below — a null return means
      // the row stopped being 'active' between the sweep reading it and now;
      // nothing to end.
      const allocated = await store.allocateLiveActivitySeq(row.activityId, now);
      if (allocated == null) return;
      const { seq, timestampMs } = allocated;
      // Wire state contract (Codex review #7): v/seq/ended, same field
      // names lib/liveActivity/state.ts's ContentState uses, matching the
      // Swift decoder's epoch-ms numbers.
      const wireEndState = { v: 1, seq, ...endState, ended: true };
      // Spend the budget only now that the claim and seq allocation both
      // succeeded — a lost claim (returned above) or a null allocation
      // (returned above) never touches the budget at all.
      if (!budget.take(1)) {
        counts.deferred += 1;
        return;
      }
      const r = await sendLiveActivity(row.pushToken, {
        contentState: wireEndState,
        event: "end",
        timestampMs,
        dismissalDateMs: now + LIVE_ACTIVITY_DISMISSAL_AHEAD_MS,
        relevanceScore: 0,
        priority: 10,
        environment: row.apnsEnvironment === "sandbox" ? "sandbox" : row.apnsEnvironment === "production" ? "production" : null,
      });
      // Sweep success/failure handling (Codex review #10): a transient
      // failure (neither ok nor a permanent 410/BadDeviceToken rejection)
      // leaves the row active/pending for the next tick's retry — it must
      // NOT be marked ended. Only a confirmed delivery or a confirmed
      // permanent rejection ends the row (and, in the same write, blanks
      // its now-useless token rather than keeping it around for the full
      // 72h purge window).
      if (r.ok || r.dead) {
        await store.markSent(endClaimKey, now);
        await store.recordLiveActivitySend(row.activityId, {
          timestamp: timestampMs,
          status: r.status ?? (r.dead ? 410 : 0),
          hash: hashContentState(endState),
          stateJson: JSON.stringify(endState),
          seq,
        });
        await store.markLiveActivityEnded(row.activityId, r.dead ? "token-dead" : "expired", now, {
          clearToken: true,
        });
      }
    };

    // Bounded fan-out (Codex review #2): only the LA_MAX_PER_RUN
    // least-recently-considered still-armed activities get a chance at an
    // update THIS run, ordered by `next_send_at` ascending (never-considered
    // rows — `next_send_at` still null — sort first). A row left out simply
    // keeps its old (earlier) cursor, so it sorts first again next run
    // instead of being starved by the same head of the queue every tick.
    const allLiveRows: LiveActivityRow[] = [];
    for (const rows of liveByDevice.values()) allLiveRows.push(...rows);
    const dueThisRun = new Set(
      [...allLiveRows]
        .sort((a, b) => (a.nextSendAt ?? -Infinity) - (b.nextSendAt ?? -Infinity))
        .slice(0, LA_MAX_PER_RUN)
        .map((r) => r.activityId),
    );
    // Which beach slugs have a Live Activity due this run — hoisted out of
    // the at-beach-slug-cap branch below so the rain-cell cap (round-4 #3)
    // can also use it to put due beaches first, without recomputing.
    const dueSlugSet = new Set(allLiveRows.filter((r) => dueThisRun.has(r.activityId)).map((r) => r.beachSlug));

    // Safety first (Codex HIGH): a device's Live Activity work is never sent
    // inline in the loop below — it is only queued here (the assessment
    // already computed for the ordinary alert path is reused, never redone)
    // and processed in a second pass, after every armed device's ordinary
    // hazard alerts have had their turn at the budget. Declared outside the
    // `if (armed.length)` block below so the pendingEnds/pendingUpdates
    // passes at the bottom of this function still run — with an empty
    // `pendingUpdates` — even when there are no armed devices at all or this
    // run is too budget-starved to even start the at-beach stage; either way
    // orphaned Live Activities must still get their due-end sweep.
    interface PendingUpdate {
      device: ArmedDevice;
      dueLiveRows: LiveActivityRow[];
      conditions: ConditionsResponse;
      lightning: EvaluateAtBeachResult["lightning"];
      nearestStrikeMi: number | null;
    }
    const pendingUpdates: PendingUpdate[] = [];

    if (armed.length) {
    const pushable = new Map<string, PushableDevice>();
    for (const p of await store.listPushable()) pushable.set(p.device.id, p);

    const loadConditions = deps.loadConditions ?? getConditions;
    const loadFeed = deps.loadFeed ?? loadLightningFeed;
    // Rain-fallback cell cap (round-4 #3): `armed` is walked due-first below,
    // so the cap's misses land on the lowest-priority devices/beaches, not
    // an arbitrary slice.
    const rainCache = newRainCache(pushRunMaxRainCells());
    const loadRain =
      deps.loadRain ??
      ((lat, lon, slug, nowMs, radar) => rainForFix(lat, lon, slug, nowMs, rainCache, radar));

    // One feed for the whole run — every device summarizes it against its own
    // fix. Stage-reserve gated (Codex round-3 #4b — "lightning" stage): a run
    // this low on budget skips the load entirely rather than spending what's
    // left on a feed it then has no room to act on; a missed load this tick
    // just means no NEW strikes surface for 5 minutes, and store state
    // (markAlert) from earlier ticks is untouched. Real fetches this makes
    // are counted automatically by lib/util.ts's fetchWithTimeout hook
    // wherever this whole request runs inside `runWithBudget`
    // (app/api/push/run/route.ts) — no manual spend needed (removes a static
    // charge here entirely, Codex round-3 #4).
    let feed: LightningFeed | null = null;
    if (budget.left < STAGE_RESERVE.lightning) {
      counts.deferred += 1;
    } else {
      feed = await loadFeed().catch(() => null);
    }

    // Real subrequest counting (Codex round-3 #4) replaces the old static
    // "21 subrequests per cold build" charge here — which, worse, was a
    // SECOND charge on top of app/api/push/run/route.ts's own identical
    // static charge for the exact same conditions build whenever `deps.
    // loadConditions` was that route's `countedGetConditions` (its normal
    // production wiring). Every real fetch a build makes now counts exactly
    // once, automatically, via lib/util.ts's fetchWithTimeout hook — nothing
    // to charge here at all. The memoization below still ensures it's only
    // ever fetched once per distinct slug this run touches.
    const conditionsBySlug = new Map<string, Promise<ConditionsResponse | null>>();
    const conditionsFor = (slug: string): Promise<ConditionsResponse | null> => {
      let hit = conditionsBySlug.get(slug);
      if (!hit) {
        hit = Promise.resolve(loadConditions(slug))
          .then((res) => {
            if (res?.budgetAborted) {
              // Codex round-5 #1: this build ran out of subrequest budget
              // partway through — treat exactly like "no conditions this
              // run" (the existing degrade path below already lets
              // conditions-free hazards fire off a null), but count it so
              // it's visible this beach's conditions-derived hazards and
              // Live Activity content were deferred, not genuinely down.
              counts.deferred += 1;
              return null;
            }
            return res;
          })
          .catch(() => null);
        conditionsBySlug.set(slug, hit);
      }
      return hit;
    };

    // At-beach slug cap (Codex round-3 #4c — "PUSH_RUN_MAX_BEACHES must cap
    // at-beach slugs too"): without this, a run with armed devices spread
    // across many distinct beaches has no bound on how many cold conditions
    // builds it attempts, unlike the home-digest loop's own cap. `due` here
    // is "already picked for a Live Activity update this run" (dueThisRun,
    // computed above) — those need `conditions` for their content state, so
    // they get priority; every other slug is round-robinned. A device whose
    // OWN slug misses the cut still gets evaluated below — `conditionsFor`
    // just resolves it to `null` — so lightning/rain hazards (which don't
    // need `conditions` at all, see evaluateAtBeach) still fire; only
    // conditions-derived hazards and this device's own Live Activity content
    // degrade for the run.
    const armedSlugs = [...new Set(armed.map((a) => a.presence.slug))];
    const maxAtBeachSlugs = pushRunMaxBeaches();
    let selectedSlugs: Set<string>;
    if (armedSlugs.length <= maxAtBeachSlugs) {
      selectedSlugs = new Set(armedSlugs);
    } else {
      const dueSlugs = armedSlugs.filter((s) => dueSlugSet.has(s));
      const otherSlugs = armedSlugs.filter((s) => !dueSlugSet.has(s));
      const selectedDue = timeRoundRobinSlice(dueSlugs, (s) => s, maxAtBeachSlugs, now, 5 * 60 * 1000);
      const room = Math.max(0, maxAtBeachSlugs - selectedDue.length);
      const selectedOther = timeRoundRobinSlice(otherSlugs, (s) => s, room, now, 5 * 60 * 1000);
      selectedSlugs = new Set([...selectedDue, ...selectedOther]);
      counts.deferred += armedSlugs.length - selectedSlugs.size;
    }
    const conditionsForCapped = (slug: string): Promise<ConditionsResponse | null> =>
      selectedSlugs.has(slug) ? conditionsFor(slug) : Promise.resolve(null);

    // "at-beach" stage reserve (Codex round-3 #4b): the ordinary hazard-alert
    // evaluation loop itself — skipped entirely, for every armed device,
    // when there isn't even budget for one more send. A run this starved is
    // better served leaving the WHOLE stage for next tick's 5-minutes-later
    // retry than partially evaluating some devices and running out mid-loop.
    if (budget.left < STAGE_RESERVE.atBeach) {
      counts.deferred += armed.length;
    } else {
    // Due-first order (round-4 #3): a stable sort so the rain-cell cap above
    // spends its budget on devices at a beach with a Live Activity due this
    // run before any other armed device, without disturbing relative order
    // within either group.
    const armedDueFirst = [...armed].sort(
      (a, b) => Number(dueSlugSet.has(b.presence.slug)) - Number(dueSlugSet.has(a.presence.slug)),
    );

    for (const device of armedDueFirst) {
      const sub = pushable.get(device.device.id);
      const loc = getLocation(device.presence.slug);
      const liveRows = (liveByDevice.get(device.device.id) ?? []).filter(
        (row) => row.beachSlug === device.presence.slug,
      );
      // Evaluate whenever the beach is known AND at least one surface exists
      // for this device — a device with no normal push token but an active
      // Live Activity must still be evaluated (this replaces the old gate
      // that skipped a device entirely for lacking a push token, which would
      // have starved an otherwise-valid Live Activity — see
      // docs/LIVE_ACTIVITY_PLAN.md "One evaluation pipeline").
      if (!loc || (!sub && !liveRows.length)) {
        counts.skipped += 1;
        continue;
      }
      try {
        const fix = fixOf(device, loc, now);
        const conditions = await conditionsForCapped(device.presence.slug);
        const rain = await loadRain(
          fix.lat,
          fix.lon,
          device.presence.slug,
          now,
          conditions?.snapshot?.precipRadar ?? null,
        ).catch(() => null);

        // Remember a wet fix even when nothing is sent — it is what later makes
        // "rain clearing" a sentence a person recognizes. Keyed off the LITERAL
        // observation only (never a latched-but-dry hazard hold), or a cron
        // running every 5 minutes while it stays dry would keep refreshing this
        // mark forever.
        if (rain?.rainingNow) {
          await store.markAlert(device.device.id, scopeKey("rain-wet", device.presence.slug), now, {
            slug: device.presence.slug,
            ...(rain.anchor ? { anchor: rain.anchor } : {}),
          });
        }

        // The strike summary is computed once and shared by both surfaces
        // below — the alert path's lightning subject and the Live Activity's
        // lightning hero must never disagree about the same strike.
        const strikes = feed ? summarizeStrikes(feed, fix.lat, fix.lon, now) : null;

        // One evaluation (Codex review #9): a single evaluateAtBeach call
        // computes both the alert decisions AND the lightning assessment —
        // the Live Activity projection below feeds it the SAME `lightning`
        // object rather than calling assessLightning a second time for the
        // same fix/anchor/moment. Run whenever either surface needs it (the
        // outer skip above already requires sub || liveRows.length).
        const { decisions, lightning } = evaluateAtBeach({
          now,
          device: { prefs: device.device.prefs, profile: device.device.profile },
          presence: { slug: device.presence.slug, lat: fix.lat, lon: fix.lon, fixSource: fix.fixSource },
          beachName: loc.name,
          strikes,
          rain,
          conditions,
          recentRain: await recentRain(store, device.device.id, device.presence.slug, now),
        });

        // --- Surface 1: the ordinary alert push — unchanged behavior/timing
        // for any device that has a normal push token. ------------------
        if (sub) {
          counts.evaluated += 1;

          const { fire, held, supersededKeys } = await splitByDedup(decisions, now, (key) =>
            store.lastAlert(device.device.id, key),
          );
          counts.skipped += held.length;

          // A superseded key still gets marked: the person just read the louder
          // version, so the quiet one must not arrive a run later. Keys are
          // already beach-scoped (catalog.ts `scopeKey`), as is the send claim
          // below, which is built from the same dedupKey.
          for (const key of supersededKeys) await store.markAlert(device.device.id, key, now);

          for (const d of fire) {
            // Budget check FIRST (Codex round-3 #4, tightened round-4 #1 —
            // a policy change from round-2 #4's "counted, not gated": a
            // genuine Cloudflare subrequest-ceiling hit kills the REST of
            // the request outright, including whatever safety sends were
            // still queued after it — strictly worse than this alert
            // waiting for next tick's retry 5 minutes later). This is a
            // PEEK only (`reserve`, not `take`) — the actual spend for this
            // send happens exactly once, inside `deps.deliver` (the sender
            // wrapper in app/api/push/run/route.ts). Spending here too used
            // to double-charge the same send: with exactly one unit left,
            // this `take(1)` would succeed, the claim below would be
            // created, and then the sender wrapper's own `take(1)` would
            // fail on the now-empty budget — creating a claim for a send
            // that was then refused, delaying retry for no reason. Checked
            // before claiming, not after, so a deferred alert leaves no
            // claim behind for the next run to trip over.
            if (!budget.reserve(1)) {
              counts.deferred += 1;
              continue;
            }
            // The concurrency guard beneath the dedup window above (#14): claim
            // this exact hazard, at this repeat window, before sending it. Two
            // runs racing each other (the Cloudflare 5-min cron and the GitHub
            // hourly backstop can both fire close together) both pass the dedup
            // check above if neither has written alert_log yet; only one of them
            // wins the claim, so only one actually sends.
            const claimKey = sendClaimKey(device.device.id, d.dedupKey, repeatWindow(now, d.repeatMs));
            if (!(await store.claimSend(claimKey, now))) {
              counts.skipped += 1;
              continue;
            }
            const r = await deps.deliver(sub, {
              tag: d.tag,
              title: d.title,
              body: d.body,
              url: `/${device.presence.slug}`,
            });
            if (r.dead) {
              counts.pruned += 1;
              await deps.onDeadToken?.(sub);
              break;
            }
            if (!r.ok) {
              // A transient failure leaves the dedup key AND the claim unmarked.
              // The claim looks "abandoned" (and so reclaimable) once it is 10
              // minutes old — see #14 — so this recovers on its own without
              // risking a duplicate send in the meantime.
              counts.errors += 1;
              continue;
            }
            counts.sent += 1;
            await store.markAlert(device.device.id, d.dedupKey, now, d.meta);
            await store.markSent(claimKey, now);
          }
        }

        // --- Surface 2: the Live Activity push — only when at least one
        // active row exists for this device+slug, and conditions actually
        // loaded (never advance freshness on a feed outage). Bounded to the
        // rows this run's `dueThisRun` budget picked (Codex review #2) — a
        // row left out is untouched, keeping its old cursor for next run.
        // Safety first: queued for the second pass below, not sent inline —
        // the SAME `lightning`/`strikes` this evaluation already computed is
        // carried along so the projection never re-assesses lightning.
        const dueLiveRows = liveRows.filter((row) => dueThisRun.has(row.activityId));
        if (dueLiveRows.length && conditions) {
          pendingUpdates.push({
            device,
            dueLiveRows,
            conditions,
            lightning,
            nearestStrikeMi: strikes?.nearestMi ?? null,
          });
        }
      } catch (e) {
        counts.errors += 1;
        console.error("alerts: device failed", device.device.id, e);
      }
    }
    } // end budget.left >= STAGE_RESERVE.atBeach
    } // end if (armed.length)

    // Safety first (Codex HIGH): only now, after every armed device's
    // ordinary hazard alerts have been evaluated and sent above, does Live
    // Activity work get a turn at whatever subrequest budget remains — first
    // the due-end sweep, then per-device updates. Neither queue was sent
    // inline above; this is the run's ONLY place either actually spends
    // budget or calls `sendLiveActivity`.
    for (const pending of pendingEnds) {
      try {
        await runPendingEnd(pending);
      } catch (e) {
        console.error("alerts: live activity end failed", pending.row.activityId, e);
      }
    }

    for (const { device, dueLiveRows, conditions, lightning, nearestStrikeMi } of pendingUpdates) {
      try {
        // The SAME `lightning` HazardAssessment evaluateAtBeach computed in
        // the first pass — never a second assessLightning call for the same
        // fix/anchor/moment (Codex review #9).
        const desired = contentStateFromConditions(conditions, {
          nowMs: now,
          lightningPoint: { lightning, lightningMi: nearestStrikeMi },
        });
        const desiredHash = hashContentState(desired);
        const desiredJson = JSON.stringify(desired);

        for (const row of dueLiveRows) {
          // Advance this row's round-robin cursor now that it's been
          // considered this run, whatever the outcome below turns out to
          // be (Codex review #2) — a successful send's recordLiveActivitySend
          // overwrites this with a more precise timestamp momentarily.
          await store.touchLiveActivityCursor(row.activityId, now);

          const decision = decideLiveActivitySend({
            nowMs: now,
            desired,
            desiredHash,
            prevState: safeParseState(row.lastStateJson),
            lastStateHash: row.lastStateHash,
            lastSentAt: row.lastSentAt,
          });
          if (!decision.send) continue;

          // Same send-claim mechanism as the alert path — keyed by the
          // decided reason AND the content hash, not a bare time bucket:
          // a bare bucket would let an URGENT lightning promotion get
          // blocked by an ordinary update's claim from earlier in the
          // same window (decideLiveActivitySend already IS the timing
          // policy; the claim only needs to stop two schedulers racing to
          // send the exact same decided content twice).
          const claimKey = sendClaimKey(
            device.device.id,
            `liveactivity:${row.activityId}:${decision.reason}:${desiredHash}`,
            repeatWindow(now, LIVE_ACTIVITY_UPDATE_WINDOW_MS),
          );
          // Budget check first (round-2 #4): "Live Activity sends only run
          // with remaining budget" — an ordinary hazard push is the
          // safety-critical surface and already had first claim on the
          // budget above; a Beach Mode Lock Screen refresh sits out this
          // run instead when the budget is tight, same as any row this run
          // couldn't get to. The actual spend (`budget.take`) is deferred
          // to immediately before the APNs call below, after the claim and
          // seq allocation both succeed — a lost claim spends nothing.
          if (budget.left < STAGE_RESERVE.liveActivityUpdates) {
            counts.deferred += 1;
            continue;
          }
          if (!(await store.claimSend(claimKey, now))) {
            counts.skipped += 1;
            continue;
          }

          // Allocate the seq AND timestamp atomically together, BEFORE the
          // APNs call (Codex round-3 fix) — computing `row.lastSeq + 1`
          // and the timestamp separately in JS left a race window across
          // the network call below where two overlapping runs could
          // allocate seq/timestamp pairs out of order relative to each
          // other (ActivityKit orders by timestamp, not seq). A null
          // return means the row went away or stopped being 'active'
          // between this run picking it up and now — nothing to send.
          const allocated = await store.allocateLiveActivitySeq(row.activityId, now);
          if (allocated == null) continue;
          const { seq, timestampMs } = allocated;
          // Wire state contract (Codex review #7): v/seq, same field names
          // the Swift decoder expects (ios/App/Shared/BeachSessionAttributes.swift).
          const wireState = { v: 1, seq, ...desired };
          // Spend the budget only now that the claim and seq allocation both
          // succeeded (Codex LOW — moved from before the claim).
          if (!budget.take(1)) {
            counts.deferred += 1;
            continue;
          }
          const r = await sendLiveActivity(row.pushToken, {
            contentState: wireState,
            event: "update",
            timestampMs,
            staleDateMs: decision.staleDateMs,
            relevanceScore: decision.relevanceScore,
            priority: decision.priority,
            environment:
              row.apnsEnvironment === "sandbox" ? "sandbox" : row.apnsEnvironment === "production" ? "production" : null,
          });
          if (r.dead) {
            // A dead LIVE ACTIVITY token ends only this one row — it must
            // never clear the device's normal APNs push token. Confirmed
            // permanent rejection → blank this row's own token too (Codex
            // review #10), same as the sweep's end path.
            await store.markLiveActivityEnded(row.activityId, "token-dead", now, { clearToken: true });
            continue;
          }
          if (r.ok) {
            await store.recordLiveActivitySend(row.activityId, {
              timestamp: timestampMs,
              status: r.status ?? 200,
              hash: desiredHash,
              stateJson: desiredJson,
              seq,
            });
            await store.markSent(claimKey, now);
          }
        }
      } catch (e) {
        counts.errors += 1;
        console.error("alerts: device failed", device.device.id, e);
      }
    }

    return counts;
  } finally {
    sessionBox.current?.close();
  }
}
