// POST /api/push/run — the native push sender. Hit on a schedule (workers/plus-cron,
// and the GitHub Action in .github/workflows/push-cron.yml) with the shared
// CRON_SECRET.
//
// Two channels, and `?mode=` picks which one runs:
//  - HOME (`mode=morning|all`): for each beach with subscribers, compute
//    conditions once, then per device send the morning digest in THAT PERSON's
//    number, and "your beach day just turned Excellent". Plus only — every alert
//    is a paid feature (see docs/PLUS_BUILD_SPEC.md). A free device is skipped
//    and its dedup state left untouched.
//  - AT THE BEACH (`mode=safety|all`): the alerts engine (lib/alerts/*) walks
//    every armed presence window and decides hazard alerts from the person's own
//    fix. `PUSH_SAFETY_ALERTS` is its kill switch.
//
// The old home-beach safety alert is retired: it warned about lightning near a
// beach the person might be 30 miles from. Hazards now come only from a live fix.
//
// Auth: header `x-cron-secret: <CRON_SECRET>`. Returns 503 until CRON_SECRET and
// at least one transport (APNs and/or FCM) are configured, so a half-set-up
// deploy never sends.
//
// Storage is the D1 device table (`lib/db/store.ts`). Every run first imports any
// legacy KV subscription that has no device row yet, so subscribers from before
// Plus keep getting their summary without re-registering.

import { randomUUID, timingSafeEqual } from "node:crypto";
import { getConditions } from "@/lib/conditions";
import { getLocation } from "@/config/locations";
import { computeSunTimes } from "@/lib/sources/sun";
import type { Location } from "@/lib/types";
import { listNativeSubs, removeNativeSub } from "@/lib/push/nativeStore";
import { getStore, isLegacyId, type DeviceStore, type PushableDevice } from "@/lib/db/store";
import { coarsePrefs, parseMode } from "@/lib/db/plus";
import { entitled, type SentState } from "@/lib/db/types";
import { sendClaimKey } from "@/lib/db/sendClaims";
import { decideNotifications, MORNING_HOUR, type PushDecision, type PushSummary } from "@/lib/push/notify";
import { excellentDecision, newSummaryCache, personalSummary } from "@/lib/alerts/morning";
import { runAtBeachAlerts, type AtBeachCounts } from "@/lib/alerts/run";
import { buildAlert } from "@/lib/alerts/catalog";
import {
  beachLocal8amWindow,
  buildComingUpSubject,
  readSkyAlertCandidates,
  selectComingUpEvent,
} from "@/lib/alerts/comingUp";
import { predictNextSunEvent } from "@/lib/sunAlert";
import { sunColorDecision, sunColorMismatchOutcome, sunColorSlugNeed, nextSunEventEstimate } from "@/lib/alerts/sunColor";
import {
  SubrequestBudget,
  pushRunSubrequestBudget,
  pushRunMaxBeaches,
  timeRoundRobinSlice,
  runWithBudget,
  STAGE_RESERVE,
} from "@/lib/alerts/budget";
import { getApns, isDeadToken, openApnsSession } from "@/lib/push/apns";
import { getFcm, getFcmAccessToken, isDeadFcmToken, sendFcm } from "@/lib/push/fcm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Constant-time string compare (length-equal). Avoids a header timing oracle. */
function secretEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function localHourAndDate(tz: string, now: Date): { hour: number; date: string } {
  const hour =
    Number(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(now),
    ) % 24;
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return { hour, date };
}

/** Is the sun up at this beach on `date` (its own local calendar day), right now? */
function isDaylightAt(loc: { lat: number; lon: number }, now: Date, date: string): boolean {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return false;
  const t = computeSunTimes(loc.lat, loc.lon, y, m, d);
  if (!t.sunrise || !t.sunset) return false;
  const ms = now.getTime();
  return ms >= t.sunrise.getTime() && ms <= t.sunset.getTime();
}

/**
 * How long APNs should STORE an undelivered push so an offline phone (airplane
 * mode / off) still gets it on reconnect, instead of Apple discarding it. The
 * morning summary stays relevant through the beach day. Hazard alerts from the
 * at-beach engine (tag `safety:<hazard>:<slug>`) fall through to 0 — deliver
 * or discard, since a stale hazard warning is worse than none.
 */
function apnsExpiry(tag: string, nowSec: number): number {
  if (tag === "morning") return nowSec + 8 * 3600; // through the beach day
  if (tag === "excellent") return nowSec + 4 * 3600; // the good stretch it names
  return 0;
}

/** One send function per device, or null when its transport is not open. */
type SendOne = (msg: PushDecision) => Promise<{ ok: boolean; dead: boolean }>;

/**
 * Decide + deliver the morning digest for one device. `sendOne` sends a single
 * message over its transport and reports {ok, dead}; a dead token is pruned and
 * its remaining sends skipped.
 *
 * Does NOT persist `sent`/dedup state itself (Codex round-3 HIGH) — it only
 * REPORTS what `morningDate` should become, via the returned `morningDate`.
 * The caller (below) is responsible for ONE combined `setSent` write per
 * device per run, merging this alongside whatever the coming-up alert
 * decided (`comingUpCheckedDate`). Two independent writes for the same
 * device in the same run would each merge against the SAME stale `sub.sent`
 * snapshot — whichever ran second would silently clobber the first's
 * change, which is exactly how a transient standalone-send failure used to
 * leave a device permanently "checked" (comingUpCheckedDate already
 * persisted by this function, moments before the standalone attempt that
 * then failed) with no way for a later pass to retry it.
 *
 * Only reached for an entitled device on a run that includes the home channel,
 * so a narrowed run can never swallow the alert it did not look at.
 */
async function deliverMorning(
  store: DeviceStore,
  sub: PushableDevice,
  summary: PushSummary,
  beachTz: string,
  now: Date,
  sendOne: SendOne,
  opts?: {
    force?: "morning";
    /** A coming-up event line to append to THIS digest, when one was
     *  claimed for this device this run (SKY_EVENTS_PLAN.md §10 — "appended
     *  to that same push, not a second notification"). Only ever appended
     *  to a message actually sent below (tag "morning") — if `due` turns
     *  out empty for some other reason, this text is simply never used, and
     *  the caller (app/api/push/run/route.ts) reads `sent` back to decide
     *  whether to confirm or release its coming-up claim. */
    appendToBody?: string;
  },
): Promise<{ sent: number; pruned: number; morningDate?: string }> {
  // The digest is due at 08:00 in the BEACH's timezone, never the phone's — see
  // #13. `sub.device.tz` is the phone's zone; it stays on the device row for
  // display purposes but must never drive scheduling.
  const { hour, date } = localHourAndDate(beachTz, now);
  const { sends, nextSent } = decideNotifications(
    { prefs: coarsePrefs(sub.device), sent: sub.sent },
    summary,
    hour,
    date,
    { force: opts?.force, nowMs: now.getTime() },
  );
  // Hazard alerts come from the at-beach engine now, never from this loop.
  const due = sends.filter((m) => m.tag === "morning");

  let sent = 0;
  let pruned = 0;
  let removed = false;
  // Advance the dedup state ONLY if the send actually succeeded — a transient
  // failure must leave the old state so the next run retries (instead of marking
  // it "already sent" and silently skipping the digest). A lost send claim
  // (#14 — a concurrent run already owns today's digest for this device)
  // takes the same "don't persist" path: whichever run actually sends is the
  // one that should update the dedup state.
  let failed = false;
  for (const msg of due) {
    const claimKey = sendClaimKey(sub.device.id, "morning", date);
    if (!(await store.claimSend(claimKey, now.getTime()))) {
      failed = true;
      continue;
    }
    const outgoing = opts?.appendToBody ? { ...msg, body: `${msg.body}\n\n${opts.appendToBody}` } : msg;
    const r = await sendOne(outgoing);
    if (r.ok) {
      sent += 1;
      await store.markSent(claimKey, now.getTime());
    } else if (r.dead) {
      await prune(store, sub).catch((e) => console.error("push: prune failed", e));
      removed = true;
      pruned += 1;
      break;
    } else {
      failed = true;
    }
  }
  return { sent, pruned, morningDate: !removed && !failed ? nextSent.morningDate : undefined };
}

/**
 * Drop a dead token. A dead token used to delete the whole device row — which
 * meant a failed delivery destroyed the person's Plus access, profile and
 * trial history, and the next re-registration started them over as a fresh
 * free device (#5). A legacy row is nothing BUT a push subscription, so it
 * still goes entirely — it is also still the KV import source, and leaving it
 * would re-create the device on the next run. A real device just loses the
 * token: `clearPushToken` only clears it if it still matches the one that
 * bounced, so a phone that already re-registered a fresh token in the
 * meantime keeps it.
 */
async function prune(store: DeviceStore, sub: PushableDevice): Promise<void> {
  if (isLegacyId(sub.device.id)) {
    await store.deleteDevice(sub.device.id);
  } else {
    await store.clearPushToken(sub.device.id, sub.token);
  }
  await removeNativeSub(sub.token).catch(() => {});
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "push sender not configured (CRON_SECRET unset)" }, { status: 503 });
  }
  if (!secretEqual(req.headers.get("x-cron-secret") ?? "", secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const apns = getApns();
  const fcm = getFcm();
  if (!apns && !fcm) {
    return Response.json({ error: "no push transport configured (set APNs and/or FCM env)" }, { status: 503 });
  }

  const params = new URL(req.url).searchParams;
  // `?force=morning` re-sends today's morning summary now (ignoring the 8 AM gate
  // and the once-a-day dedup) — used to send an on-demand test of today's weather.
  const force = params.get("force") === "morning" ? ({ force: "morning" } as const) : undefined;
  const mode = parseMode(params.get("mode"));

  const now = new Date();
  const nowMs = now.getTime();
  const nowSec = Math.floor(nowMs / 1000);

  const store = await getStore();
  // Migrate any pre-Plus KV subscription that has no device row yet. Idempotent
  // and cheap once drained; a failure here must not stop the run.
  let imported = 0;
  try {
    const legacy = await listNativeSubs();
    if (legacy.length) imported = (await store.importLegacy(legacy)).imported;
  } catch (e) {
    console.error("push: legacy import failed", e);
  }

  // Opportunistic housekeeping for the send-claims table (#14): drop claims
  // old enough to never matter again. Never fatal — every run does this once,
  // regardless of `mode`, so the table doesn't grow forever even if a run is
  // later narrowed to just one channel.
  try {
    await store.pruneSendClaims(nowMs);
  } catch (e) {
    console.error("push: claim prune failed", e);
  }
  // Same spirit for the coming-up alert ledger (SKY_EVENTS_PLAN.md §10,
  // migrations/0011_coming_up_deliveries.sql) — its own retention window is
  // 30 days (the cap math needs the full history), not send_claims' 3 days,
  // so it gets its own prune call rather than piggybacking on the one above.
  try {
    await store.pruneComingUp(nowMs);
  } catch (e) {
    console.error("push: coming-up ledger prune failed", e);
  }
  // Same spirit for presence: once a window has run out, the phone's stored
  // coordinates are dropped (the row and its slug stay). Nothing reads a fix
  // past `armed_until`, so keeping it is pure liability.
  try {
    await store.purgeExpiredPresenceFixes(nowMs);
  } catch (e) {
    console.error("push: presence fix purge failed", e);
  }

  const pushable = await store.listPushable();
  // The home-beach loop needs a home beach; the at-beach engine does not (it
  // works off the presence fix), so only the digest is filtered here.
  const subs = pushable.filter((s) => !!s.device.homeSlug);

  const bySlugAll = new Map<string, PushableDevice[]>();
  for (const s of subs) {
    const slug = s.device.homeSlug as string;
    const a = bySlugAll.get(slug);
    if (a) a.push(s);
    else bySlugAll.set(slug, [s]);
  }

  // Shared subrequest budget for the WHOLE request — both loops below (home
  // digest, then the at-beach engine) spend from the same counter, so
  // together they never exceed Workers Free's 50-per-request ceiling (round-2
  // #4, lib/alerts/budget.ts). Real per-fetch counting (Codex round-3 #4) —
  // every outbound fetch this request makes, however deeply nested inside
  // getConditions/lib/sources, spends from THIS instance via
  // lib/util.ts's fetchWithTimeout hook, as long as it runs inside
  // `runWithBudget(budget, ...)` below. D1 calls (store.*) never count
  // against it.
  const budget = new SubrequestBudget(pushRunSubrequestBudget());
  const maxBeaches = pushRunMaxBeaches();

  // Open each transport once, only if it's configured AND has devices waiting.
  // Judged on EVERY pushable device: someone armed at a beach with no home beach
  // set still needs a hazard alert.
  const hasIos = pushable.some((s) => s.platform === "ios");
  const hasAndroid = pushable.some((s) => s.platform === "android");
  let apnsSession: ReturnType<typeof openApnsSession> | null = null;
  if (apns && hasIos) {
    try {
      apnsSession = openApnsSession(apns, nowSec);
    } catch (e) {
      // A JWT/.p8 failure here used to be silent — every iOS alert skipped
      // with nothing in the logs (2026-10-07). Say so loudly.
      console.error("push: APNs session failed, skipping every iOS device this run", e);
      apnsSession = null;
    }
  }
  let fcmAccessToken: string | null = null;
  // FCM OAuth is one subrequest — counted (round-2 #4) but never GATED:
  // only the optional Live Activity surface actually checks remaining
  // budget before proceeding (see run.ts). Every other surface here
  // (morning digest, "just turned Excellent", ordinary hazard alerts) is
  // paid/safety-critical functionality that must not silently no-op just
  // because the counter ran low — `spend()` keeps the number honest for
  // diagnostics (the response's `subrequestBudgetLeft`) without blocking.
  if (fcm && hasAndroid) {
    budget.spend(1);
    fcmAccessToken = await getFcmAccessToken(fcm, nowSec).catch(() => null);
  }

  /** The send function for one device, or null when its transport isn't
   *  open. Every call spends one subrequest from the shared budget (round-2
   *  #4, APNs/FCM are both one HTTP call each) — and, as of Codex round-3
   *  #4, GATED on it: a send this run has no budget left for reports
   *  `{ ok: false, dead: false }`, the same shape as a transient transport
   *  failure, so both `deliverMorning` and the "just turned Excellent" send
   *  below already leave their dedup/claim state untouched and retry next
   *  tick — no separate "deferred" plumbing needed here. This replaces
   *  round-2 #4's "counted, not gated" policy: a real Cloudflare
   *  subrequest-ceiling hit kills the rest of the request outright, which is
   *  strictly worse than one digest waiting 5 minutes. */
  const senderFor = (sub: PushableDevice): SendOne | null => {
    if (sub.platform === "ios" && apnsSession) {
      const session = apnsSession;
      return async (msg) => {
        if (!budget.take(1)) return { ok: false, dead: false };
        const r = await session.send(sub.token, {
          title: msg.title,
          body: msg.body,
          url: msg.url,
          tag: msg.tag,
          expiration: apnsExpiry(msg.tag, nowSec),
        });
        return { ok: r.ok, dead: isDeadToken(r) };
      };
    }
    if (sub.platform === "android" && fcm && fcmAccessToken) {
      const token = fcmAccessToken;
      return async (msg) => {
        if (!budget.take(1)) return { ok: false, dead: false };
        const r = await sendFcm(token, fcm.projectId, sub.token, {
          title: msg.title,
          body: msg.body,
          url: msg.url,
        });
        return { ok: r.ok, dead: isDeadFcmToken(r) };
      };
    }
    return null;
  };

  let morningSent = 0;
  let excellentSent = 0;
  /** Standalone coming-up pushes only (SKY_EVENTS_PLAN.md §10) — an
   *  appended one is counted inside `morningSent` (it rides the same push). */
  let comingUpSent = 0;
  /** The opt-in sun-color alert — always standalone, never coalesced. */
  let sunColorSent = 0;
  let pruned = 0;
  /** Devices the home loop could not finish. The run carries on to the next. */
  let errors = 0;
  let alerts: AtBeachCounts = { devices: 0, evaluated: 0, sent: 0, skipped: 0, errors: 0, pruned: 0, deferred: 0 };
  // How many times this run actually called getConditions — the number we're
  // trying to shrink: the 5-minute cron used to re-fetch every home beach's
  // conditions even when nobody there could receive anything (2 PM, nobody at
  // MORNING_HOUR, nobody in daylight for score-excellent).
  let conditionsFetched = 0;
  // No more static per-call charge here (Codex round-3 #4 — the old
  // COLD_CONDITIONS_BUILD_COST=21 flat charge, and the SAME flat charge
  // run.ts's own `conditionsFor` used to add on top of this one whenever the
  // at-beach engine called this SAME function as its `loadConditions`,
  // double-counting one real conditions build as 42 subrequests). Every real
  // fetch a conditions build makes is now counted exactly once, as it
  // happens, by lib/util.ts's `fetchWithTimeout` hook — see `runWithBudget`
  // below, which this whole handler runs inside of.
  const countedGetConditions = (slug: string) => {
    conditionsFetched += 1;
    return getConditions(slug);
  };
  // Home beaches actually worked this run — i.e. that had a device someone
  // could receive a digest or "turned Excellent" alert for, right now.
  let homeBeaches = 0;
  // Home beaches that had real work due but got left for next tick — either
  // PUSH_RUN_MAX_BEACHES' own cap, or the home-digests stage sitting out the
  // whole run for lack of budget (Codex round-3 #4).
  let homeBeachesDeferred = 0;

  /**
   * Does ANY device in this beach's group actually need conditions fetched
   * right now? Two kinds, so the selection below can prioritize correctly:
   *  - `due`: the morning digest's own MORNING_HOUR gate (or `?force=morning`),
   *    OR a coming-up-only device (morning off) at its own beach-local 8:00
   *    AM hour that HASN'T been checked yet today (SKY_EVENTS_PLAN.md §10 —
   *    without the base check, a device with morning off and coming-up on
   *    would never get its beach selected at all, since nothing else would
   *    mark the slug `due`; without the `comingUpCheckedDate` guard, once
   *    checked it would stay `due` for the REST of the 8 AM hour with
   *    nothing left to do, quietly starving every OTHER beach's morning
   *    digest of round-robin slots — Codex round-2 HIGH. `comingUpCheckedDate`
   *    is set by the per-device loop below the moment it evaluates
   *    coming-up eligibility for a device, regardless of outcome — same
   *    "already handled today" role `morningDate` already plays for the
   *    digest). Never gated by `force`: `?force=morning` is the on-demand
   *    weather-summary test path only and must never fire or consume a
   *    coming-up alert. Either way, time-sensitive — missing it this run
   *    means missing it for the whole day, so a `due` slug is never left
   *    out by the cap below.
   *  - `candidate`: merely eligible for "just turned Excellent" — elastic,
   *    fine to pick up next tick instead.
   * A device whose own local-hour lookup throws (a corrupt stored tz) fails
   * OPEN as `due`, so the existing per-device error handling below still
   * sees and counts it.
   */
  async function slugConditionsNeed(
    loc: Location,
    group: PushableDevice[],
  ): Promise<{ due: boolean; candidate: boolean }> {
    let candidate = false;
    for (const sub of group) {
      if (!entitled(sub.device, nowMs)) continue;
      if (!senderFor(sub)) continue;
      try {
        // Beach-local, not phone-local — see #13.
        const { hour, date } = localHourAndDate(loc.timezone, now);
        if (sub.device.prefs.morning && (force || (hour === MORNING_HOUR && sub.sent.morningDate !== date))) {
          return { due: true, candidate: true };
        }
        if (
          !force &&
          sub.device.prefs["coming-up"] === true &&
          hour === MORNING_HOUR &&
          sub.sent.comingUpCheckedDate !== date
        ) {
          return { due: true, candidate: true };
        }
        if (sub.device.prefs["score-excellent"] !== false && isDaylightAt(loc, now, date)) {
          const already = await store.lastAlert(sub.device.id, `score-excellent:${date}`);
          if (!already) candidate = true;
        }
        // Sun-color (opt-in): candidate whenever the next sun event is
        // within ~4h (computed WITHOUT fetching conditions —
        // computeSunTimes is pure), due once inside the actual send window
        // so it's never starved by the cap below. Neither flag is set once
        // this device's own `sunColorCheckedKey` already names the SAME
        // event — otherwise a device with nothing further to send this
        // hour would keep its beach `due`/`candidate` for the whole window,
        // starving other same-timezone beaches' round-robin slots (Codex
        // review item 2). One `lastAlert` check, only when there's
        // something to gain from it.
        if (sub.device.prefs["sun-color"] === true) {
          const need = sunColorSlugNeed(loc, sub.device, sub.sent, nowMs);
          if (need.eventKey && (need.due || need.candidate)) {
            const already = await store.lastAlert(sub.device.id, need.eventKey);
            if (!already) {
              if (need.due) return { due: true, candidate: true };
              candidate = true;
            }
          }
        }
      } catch {
        return { due: true, candidate: true }; // fail open — let the real error surface (and count) below
      }
    }
    return { due: false, candidate };
  }

  // --- Beach selection (Codex round-3 #4c): filter to slugs that actually
  // need conditions FIRST, then cap — the old order (cap the raw slug list,
  // THEN check which of those need anything) could burn the run's limited
  // slots on beaches with nothing due while a genuinely due digest a
  // round-robin tick away got bumped. `due` slugs (MORNING_HOUR is now, or
  // ?force=morning) always get in — missing that window means missing the
  // whole day's digest, so PUSH_RUN_MAX_BEACHES only ever trims `candidate`
  // (Excellent-only) slugs, which are fine to pick up next tick. Nothing
  // here spends any budget — `slugConditionsNeed` only reads the store.
  const dueSlugs: string[] = [];
  const candidateSlugs: string[] = [];
  for (const [slug, group] of bySlugAll) {
    const loc = getLocation(slug);
    if (!loc) continue;
    const need = await slugConditionsNeed(loc, group);
    if (need.due) dueSlugs.push(slug);
    else if (need.candidate) candidateSlugs.push(slug);
  }
  const TICK_MS = 5 * 60 * 1000; // the cron's own interval (workers/plus-cron, push-cron.yml)
  // `due` gets priority for the cap's slots — but is still itself capped
  // (round-robin, for fairness across ticks) rather than unconditionally
  // uncapped: MORNING_HOUR is a single beach-LOCAL hour gate, and this app's
  // beaches cluster in a couple of timezones, so a large number of digests
  // can plausibly come due in the very same 5-minute tick.
  const selectedDue = timeRoundRobinSlice(dueSlugs, (slug) => slug, maxBeaches, nowMs, TICK_MS);
  const candidateRoom = Math.max(0, maxBeaches - selectedDue.length);
  const selectedCandidates = timeRoundRobinSlice(candidateSlugs, (slug) => slug, candidateRoom, nowMs, TICK_MS);
  // `due` slugs the cap left unserved THIS pass (round-2 item 4) — the
  // precise signal workers/plus-cron's early-stop now uses: unlike the
  // coarser `beachesDeferred` below (which also folds in `candidate`
  // deferrals, elastic and fine to pick up later), a nonzero `dueRemaining`
  // means something time-sensitive (a morning digest, a coming-up/sun-color
  // window) is genuinely waiting on capacity RIGHT NOW, so the cron should
  // keep making passes rather than stopping early.
  let dueRemaining = dueSlugs.length - selectedDue.length;
  homeBeachesDeferred = dueRemaining + (candidateSlugs.length - selectedCandidates.length);
  const selectedDueSet = new Set(selectedDue);
  const slugsThisRunSet = new Set([...selectedDue, ...selectedCandidates]);
  const bySlug = new Map([...bySlugAll].filter(([slug]) => slugsThisRunSet.has(slug)));
  // Round-3 item 3: a slug this pass DID reach (so it isn't already counted
  // by the budget-aborted/stage-skip increments below) but where some
  // device's evaluation ended NOT terminal — a transient send failure, or a
  // lost-claim race no other run has yet confirmed (`comingUpTerminal` /
  // `sunColorTerminal` explicitly `false`, set below) — still has real,
  // time-sensitive work outstanding. Folded into `dueRemaining` after the
  // home-digest loop finishes, once per slug (matching the granularity of
  // every other `dueRemaining` increment here), so the cron's early-stop
  // correctly keeps making passes instead of treating a transient failure
  // as "nothing left to do this tick".
  const retryableDueSlugs = new Set<string>();

  try {
    await runWithBudget(budget, async () => {
    // --- Home beach: the daily digest + "turned Excellent". Plus only. --------
    // Stage reserve (Codex round-3 #4b): skip the WHOLE stage up front when
    // there isn't even enough budget left for one send — deferred slugs are
    // simply picked up again next tick, same as PUSH_RUN_MAX_BEACHES' own
    // deferrals above.
    if (mode !== "safety" && budget.left < STAGE_RESERVE.homeDigests) {
      homeBeachesDeferred += bySlug.size;
      for (const slug of bySlug.keys()) if (selectedDueSet.has(slug)) dueRemaining += 1;
    } else if (mode !== "safety") {
      const summaries = newSummaryCache();
      for (const [slug, group] of bySlug) {
        const loc = getLocation(slug);
        if (!loc) continue;
        homeBeaches += 1;
        let res;
        try {
          res = await countedGetConditions(slug);
        } catch {
          // Round-4 item 2: a thrown load is exactly as retryable as a
          // budget-aborted one below — this beach's group gets nothing
          // built off it this pass. Folded into `retryableDueSlugs` (read
          // out after the whole loop, same as the per-device outcomes
          // round-3 item 3 already tracks there) rather than bumping
          // `dueRemaining` inline, so a slug that fails here AND has a
          // device hit a transient failure later isn't double-counted.
          homeBeachesDeferred += 1;
          retryableDueSlugs.add(slug);
          continue;
        }
        if (!res) {
          // A null return (no throw, but nothing usable) is the same
          // "try again next pass" case as the throw just above.
          homeBeachesDeferred += 1;
          retryableDueSlugs.add(slug);
          continue;
        }
        if (res.budgetAborted) {
          // Codex round-5 #1: this build ran out of subrequest budget
          // partway through — one or more sources are deliberately missing,
          // not genuinely down. Never build a digest/"turned Excellent" off
          // it; leave this beach's group for next tick instead. Counted in
          // beaches (one slug), the same unit as the cap deferrals above.
          homeBeachesDeferred += 1;
          if (selectedDueSet.has(slug)) dueRemaining += 1;
          continue;
        }
        const place = { slug, name: loc.name, tz: loc.timezone };
        // Computed once per beach (every device in `group` shares the same
        // tz) — reused below both for the digest's own due-gate and for the
        // coming-up alert's "is this the 8:00 AM run" gate (§10). Never true
        // under `force`: `?force=morning` is the on-demand weather-summary
        // test path only and must never fire or consume a coming-up alert.
        const { hour: beachHour, date: beachDate } = localHourAndDate(loc.timezone, now);
        const isMorningRun = beachHour === MORNING_HOUR && !force;
        // The exact [current 8:00 AM, next 8:00 AM) window, DST-aware — only
        // computed when this really is that beach's 8:00 AM run; a naive
        // `nowMs + 24h` would land an hour off on a DST transition day.
        const comingUpWindow = isMorningRun ? beachLocal8amWindow(nowMs, loc.timezone) : null;
        // The UNCAPPED candidate list for this beach — every alert-relevant
        // SkyEvent the conditions build produced, never the "Coming up"
        // card's own already-3-row-capped rows (a 4th simultaneous rare
        // event must still be alert-eligible even if the card had to drop
        // it).
        const skyAlertCandidates = readSkyAlertCandidates(res.snapshot);
        // Computed once per beach (like `skyAlertCandidates` above) — pure,
        // off the SAME `res` this beach's group already fetched (no extra
        // outbound call), reused by every sun-color subscriber in `group`
        // below. Scored against the SNAPSHOT'S OWN clock
        // (`generatedAt`), not this run's wall clock (Codex review item 4)
        // — that's what makes the GOES-freshness read (and the "next event"
        // pick, on a served-from-cache snapshot) agree with what
        // components/SunQualityCard.tsx would show for this exact
        // snapshot. The send-WINDOW decision below still uses the real
        // wall clock (`nowMs`) — whether to push right now is a different
        // question from how the snapshot itself should be read.
        const sunColorPrediction = predictNextSunEvent(res, Date.parse(res.snapshot.generatedAt));

        for (const sub of group) {
          // Every alert is Plus. A free device gets nothing here, and nothing is
          // written for it — its dedup state stays exactly as it was, so the day
          // it upgrades it starts clean.
          if (!entitled(sub.device, nowMs)) continue;
          const sendOne = senderFor(sub);
          if (!sendOne) continue;
          // One device's failure never sinks the run — the same rule the
          // at-beach engine follows. A single unreadable row (a stored timezone
          // Intl rejects, say) must not cost everyone else their alerts.
          try {
            const summary = personalSummary(res, place, sub.device, nowMs, summaries);

            // --- Sky events "coming up" alert (Phase 3, §10) -----------------
            // Claimed up front, then resolved by EXACTLY ONE of the three
            // paths below — append to the digest, coalesce into "turned
            // Excellent", or a standalone push — decided by what else is
            // due for this device this run. Coming-up and Excellent must
            // never fire as two separate pushes back-to-back for the same
            // device, so they share one another's "is it actually going
            // out" outcome via `comingUpConsumed`, never send twice.
            // `comingUpClaim`'s reservation (coming_up_deliveries) IS the
            // sole concurrency guard for the standalone/coalesced paths —
            // no separate send_claims claim for them, so the ledger,
            // alert_log, and the caps can never disagree about a send
            // send_claims doesn't know about.
            let comingUpClaim: { eventKey: string; token: string; body: string; tag: string; title: string } | null =
              null;
            let comingUpConsumed = false;
            // Whether this device's coming-up status is DEFINITIVELY settled
            // for today — persisted (as `comingUpCheckedDate`) only when
            // true, in the ONE combined write at the end of this block
            // (Codex round-3 HIGH). True for "nothing eligible" / "claim
            // lost" (nothing to gain from retrying within the same hour) and
            // for a CONFIRMED complete/dead outcome on whichever path
            // resolves the claim; explicitly FALSE on a transient send
            // failure (a `releaseComingUp` call for any reason OTHER than a
            // dead token) — that reservation is retryable, so the beach must
            // stay "due" for a later pass to pick it back up. Starts
            // `undefined` (not evaluated this run at all — pref off, or not
            // the 8 AM hour) and only ever becomes `true`/`false` inside the
            // block below.
            let comingUpTerminal: boolean | undefined;
            // Sun-color's own "settled for this event" flags (Codex review
            // item 2) — same "undefined until evaluated, true unless a
            // transient failure" contract as `comingUpTerminal`, but keyed
            // to the specific event (`sunColorEventKeyThisRun`) rather than
            // a calendar date, since a device's next sun-color opportunity
            // can land on a different hour on a different day. Populated
            // below, after the coming-up/digest/Excellent steps (it's
            // independent of all three), and read by `persistSentState`.
            let sunColorTerminal: boolean | undefined;
            let sunColorEventKeyThisRun: string | undefined;
            // Round-3 item 1: set only on the "defer" outcome below — a
            // fetch made because the ESTIMATE was due found the real
            // snapshot's own window opening soon but not yet (same kind,
            // within SUN_COLOR_MISMATCH_DEFER_MAX_MS). Persisted instead of
            // latching, so `sunColorSlugNeed` holds the beach at
            // `candidate` until this instant instead of re-fetching every
            // tick in between.
            let sunColorDeferUntilMsThisRun: number | undefined;
            if (comingUpWindow && sub.device.prefs["coming-up"] === true) {
              const selection = selectComingUpEvent(
                skyAlertCandidates,
                nowMs,
                comingUpWindow.windowStart,
                comingUpWindow.windowEnd,
              );
              if (selection) {
                const subject = buildComingUpSubject(selection, loc.timezone);
                const decision = buildAlert(subject, { beach: loc.name });
                const token = randomUUID();
                const claim = await store.claimComingUp(sub.device.id, selection.eventKey, token, nowMs);
                switch (claim) {
                  case "claimed":
                    comingUpClaim = {
                      eventKey: selection.eventKey,
                      token,
                      body: decision.body,
                      tag: decision.tag,
                      title: decision.title,
                    };
                    comingUpTerminal = false; // claimed but not yet resolved by any path below
                    break;
                  case "already-sent":
                  case "capped":
                    // Terminal: nothing to retry this hour — a once-ever
                    // record won't change, and the cap window hasn't moved.
                    comingUpTerminal = true;
                    break;
                  case "in-flight":
                    // Codex round-4 HIGH: another run holds a LIVE
                    // reservation for this exact event right now — a race,
                    // not a terminal outcome. Stay `due` so a later pass can
                    // see whether that run finished (→ already-sent next
                    // time) or abandoned its claim (→ reclaimable).
                    comingUpTerminal = false;
                    break;
                }
              } else {
                comingUpTerminal = true; // no eligible event this run
              }
            }

            // --- 1) Append to the morning digest, when it's due this run ----
            // Same predicate `deliverMorning`'s own `decideNotifications` due
            // filter resolves to for the "morning" tag (mirrors the identical
            // check `slugConditionsNeed` above already relies on) — whether
            // it's accurate is self-correcting below either way: completion
            // only happens once `r.sent > 0` confirms a real send went out.
            const morningDueNow =
              sub.device.prefs.morning && (force || (beachHour === MORNING_HOUR && sub.sent.morningDate !== beachDate));

            const r = await deliverMorning(store, sub, summary, loc.timezone, now, sendOne, {
              force: force?.force,
              appendToBody: comingUpClaim && morningDueNow ? comingUpClaim.body : undefined,
            });
            morningSent += r.sent;
            pruned += r.pruned;
            if (comingUpClaim && morningDueNow) {
              comingUpConsumed = true;
              if (r.sent > 0) {
                await store.completeComingUp(sub.device.id, comingUpClaim.eventKey, comingUpClaim.token, nowMs);
                comingUpTerminal = true;
              } else {
                await store.releaseComingUp(sub.device.id, comingUpClaim.eventKey, comingUpClaim.token);
                comingUpTerminal = false; // transient (or the digest wasn't actually due) — retry later
              }
            }

            /** ONE combined `patchSent` call for this device's `sent` state
             *  this run — `morningDate` (from `deliverMorning`) and
             *  `comingUpCheckedDate` (only when `comingUpTerminal === true`),
             *  merged ATOMICALLY server-side via `json_patch` (Codex round-4
             *  HIGH). Deliberately NOT a `{...sub.sent, ...patch}` read-
             *  modify-write against the request-start snapshot — two
             *  overlapping runs (the 5-min Worker cron and the hourly GitHub
             *  Actions fallback both hit this route close together) can each
             *  merge a DIFFERENT field for the SAME device off that SAME
             *  stale snapshot, and whichever finishes last would silently
             *  erase the other's write. `patchSent` only ever names the
             *  keys THIS call actually means to change, so two such calls
             *  can land in either order and both survive. */
            async function persistSentState(): Promise<void> {
              const patch: Partial<SentState> = {};
              if (r.morningDate !== undefined) patch.morningDate = r.morningDate;
              if (comingUpTerminal === true) patch.comingUpCheckedDate = beachDate;
              if (sunColorTerminal === true && sunColorEventKeyThisRun) {
                patch.sunColorCheckedKey = sunColorEventKeyThisRun;
              }
              if (sunColorDeferUntilMsThisRun !== undefined) {
                patch.sunColorDeferUntilMs = sunColorDeferUntilMsThisRun;
              }
              if (Object.keys(patch).length === 0) return;
              await store
                .patchSent(sub.device.id, patch)
                .catch((e) => console.error("push: persist dedup failed for", sub.device.homeSlug, e));
            }

            if (r.pruned) {
              // The device is gone — nothing left to coalesce into or send
              // standalone to. Release an unresolved claim now rather than
              // leaving it reserved until the abandonment window passes.
              // Whether comingUpCheckedDate persists doesn't matter for a
              // tokenless device (senderFor will skip it either way), so a
              // best-effort write is fine here too.
              if (comingUpClaim && !comingUpConsumed) {
                await store.releaseComingUp(sub.device.id, comingUpClaim.eventKey, comingUpClaim.token);
              }
              await persistSentState();
              continue;
            }

            // The Excellent daily-dedup key is a calendar day in the BEACH's
            // timezone too, so it can't drift from the same day the digest uses
            // — the same `beachDate` already computed above for this slug.
            const date = beachDate;
            const excellent = excellentDecision({ device: sub.device, summary, res, nowMs, date });
            // --- 2) Coalesce into "turned Excellent", when IT's due this run
            if (excellent && !(await store.lastAlert(sub.device.id, excellent.dedupKey))) {
              // The send claim (#14): a concurrent run could have read the same
              // "not sent today" answer above, a moment before either of us
              // wrote alert_log. Only the run that wins this claim may send.
              const claimKey = sendClaimKey(sub.device.id, "score-excellent", date);
              if (await store.claimSend(claimKey, nowMs)) {
                const coalesceComingUp = !!comingUpClaim && !comingUpConsumed;
                const body = coalesceComingUp ? `${excellent.body}\n\n${comingUpClaim!.body}` : excellent.body;
                const sent = await sendOne({ tag: excellent.tag, title: excellent.title, body, url: `/${slug}` });
                if (sent.dead) {
                  await prune(store, sub).catch((e) => console.error("push: prune failed", e));
                  pruned += 1;
                  if (coalesceComingUp) {
                    comingUpConsumed = true;
                    await store.releaseComingUp(sub.device.id, comingUpClaim!.eventKey, comingUpClaim!.token);
                    comingUpTerminal = true; // device gone — moot either way
                  }
                } else if (sent.ok) {
                  excellentSent += 1;
                  await store.markAlert(sub.device.id, excellent.dedupKey, nowMs, excellent.meta);
                  await store.markSent(claimKey, nowMs);
                  if (coalesceComingUp) {
                    comingUpConsumed = true;
                    await store.completeComingUp(sub.device.id, comingUpClaim!.eventKey, comingUpClaim!.token, nowMs);
                    comingUpTerminal = true;
                  }
                }
                // A transient failure (`!sent.ok && !sent.dead`) leaves BOTH
                // Excellent's own claim/dedup state AND an unresolved
                // coming-up claim untouched (`comingUpTerminal` stays
                // `false`) — the latter still falls through to a standalone
                // attempt below, and remains retryable later even if THAT
                // attempt also doesn't land this run.
              }
              // A lost send-claim race (another run already owns today's
              // Excellent) leaves an unresolved coming-up claim untouched
              // too — falls through to standalone below.
            }

            // --- 3) Standalone, when neither of the above claimed it ---------
            if (comingUpClaim && !comingUpConsumed) {
              const sent = await sendOne({
                tag: comingUpClaim.tag,
                title: comingUpClaim.title,
                body: comingUpClaim.body,
                url: `/${slug}`,
              });
              if (sent.dead) {
                await prune(store, sub).catch((e) => console.error("push: prune failed", e));
                pruned += 1;
                await store.releaseComingUp(sub.device.id, comingUpClaim.eventKey, comingUpClaim.token);
                comingUpTerminal = true; // device gone — moot either way
              } else if (sent.ok) {
                comingUpSent += 1;
                await store.completeComingUp(sub.device.id, comingUpClaim.eventKey, comingUpClaim.token, nowMs);
                comingUpTerminal = true;
              } else {
                // Transient failure — release so the reservation is
                // immediately reclaimable, and explicitly do NOT mark this
                // device "checked" today: `persistSentState()` below must
                // skip `comingUpCheckedDate` so `slugConditionsNeed` keeps
                // this beach `due` for a later pass to retry (Codex round-3
                // HIGH — this is exactly the "morning off + excellent off +
                // coming-up on" scenario that regressed without this).
                await store.releaseComingUp(sub.device.id, comingUpClaim.eventKey, comingUpClaim.token);
                comingUpTerminal = false;
              }
            }

            // --- Sun-color alert (opt-in) — always standalone, no coalescing
            // with the digest or "turned Excellent" (unlike coming-up, it
            // fires on its own short lead-time window, not the 8 AM run those
            // two share). The send/no-send decision itself — cutoff, window,
            // 4h-trust gate — lives entirely in the pure `sunColorDecision`
            // (lib/alerts/sunColor.ts); this block does the claim/send/mark
            // dance every other standalone alert here does, PLUS the
            // "checked"/"defer" bookkeeping (round-2 item 2, round-3 item 1)
            // that keeps `slugConditionsNeed` from holding this beach
            // `due` for longer than it can possibly matter.
            //
            // Gated on the ESTIMATE being due — the SAME call
            // `slugConditionsNeed` already made for this device during
            // selection (pure, so calling it again here is safe and cheap)
            // — never on the snapshot alone: round-3 item 1 is precisely
            // about handling the case where the estimate is due but the
            // real snapshot DISAGREES (a different kind, a window that
            // hasn't opened yet, or one that already closed). Evaluating
            // only once merely a `candidate` is wrong the same way it
            // always was — hours-out is not this device's moment — but
            // `sunColorSlugNeed` already encodes that distinction, so
            // checking `need.due` covers it.
            if (sub.device.prefs["sun-color"] === true && sub.device.homeSlug) {
              const need = sunColorSlugNeed(loc, sub.device, sub.sent, nowMs);
              if (need.due && need.eventKey) {
                sunColorEventKeyThisRun = need.eventKey;
                const estimate = nextSunEventEstimate(loc, nowMs);
                const outcome = estimate
                  ? sunColorMismatchOutcome(estimate.kind, sunColorPrediction, sub.device.sunColor.leadMin, nowMs)
                  : ({ kind: "latch" } as const);

                if (outcome.kind === "defer") {
                  // The real snapshot's own window is coming, just not yet
                  // — don't latch; persistSentState below writes
                  // sunColorDeferUntilMs instead, so slugConditionsNeed
                  // holds this beach at `candidate` until that instant.
                  sunColorDeferUntilMsThisRun = outcome.deferUntilMs;
                } else {
                  // Default: evaluated this run, regardless of outcome — a
                  // transient send failure, or a lost claim race no other
                  // run has yet confirmed, flips this back to `false` below
                  // so a later tick inside the SAME window retries.
                  sunColorTerminal = true;

                  if (outcome.kind === "in-window") {
                    const sunColor = sunColorDecision({
                      device: sub.device,
                      prediction: sunColorPrediction,
                      beachName: loc.name,
                      tz: loc.timezone,
                      nowMs,
                    });
                    if (sunColor && !(await store.lastAlert(sub.device.id, sunColor.dedupKey))) {
                      const sunColorClaimKey = sendClaimKey(sub.device.id, "sun-color", sunColor.dedupKey);
                      if (await store.claimSend(sunColorClaimKey, nowMs)) {
                        const sent = await sendOne({
                          tag: sunColor.tag,
                          title: sunColor.title,
                          body: sunColor.body,
                          url: `/${slug}`,
                        });
                        if (sent.dead) {
                          await prune(store, sub).catch((e) => console.error("push: prune failed", e));
                          pruned += 1;
                        } else if (sent.ok) {
                          sunColorSent += 1;
                          await store.markAlert(sub.device.id, sunColor.dedupKey, nowMs, sunColor.meta);
                          // Ownership-safe (round-2 item 1): a false return
                          // means the claim was reclaimed by a later run
                          // before this write landed — the send already
                          // happened (and alert_log is already written
                          // above), so this is a bookkeeping race, not a
                          // failure; just log it.
                          if (!(await store.markSent(sunColorClaimKey, nowMs))) {
                            console.warn(
                              "push: sun-color markSent lost ownership (claim reclaimed)",
                              sunColorClaimKey,
                            );
                          }
                        } else {
                          // Transient failure: release the claim
                          // immediately (item 1) rather than waiting out
                          // ABANDONED_CLAIM_MS, and leave this device NOT
                          // checked so a later tick inside the SAME window
                          // can retry.
                          if (!(await store.releaseSend(sunColorClaimKey, nowMs))) {
                            console.warn(
                              "push: sun-color releaseSend lost ownership (claim reclaimed)",
                              sunColorClaimKey,
                            );
                          }
                          sunColorTerminal = false;
                        }
                      } else {
                        // Lost the claim race (round-2 item 1): another run
                        // holds it right now. Terminal ONLY if that run has
                        // ALREADY confirmed the send — otherwise this is a
                        // live race, not a settled outcome, and the device
                        // must stay un-latched so a later tick re-evaluates
                        // (sees `already-sent` next time, or a reclaimable
                        // abandoned claim if that run crashed).
                        sunColorTerminal = !!(await store.lastAlert(sub.device.id, sunColor.dedupKey));
                      }
                    }
                    // `sunColor === null` (score never reached the
                    // device's cutoff, an honest-null forecast, or already
                    // in alert_log) is also terminal — nothing will change
                    // before the window closes.
                  }
                  // `outcome.kind === "latch"`: the estimate and the real
                  // snapshot disagree beyond any hope of converging (no
                  // prediction, a different kind, the snapshot's window
                  // already closed, or it's more than
                  // SUN_COLOR_MISMATCH_DEFER_MAX_MS away) — nothing more to
                  // do; `sunColorTerminal` stays at its default `true`.
                }
              }
            }

            await persistSentState();
            // Round-3 item 3: this device's evaluation this pass is fully
            // settled once we get here — `comingUpTerminal`/`sunColorTerminal`
            // hold their FINAL values (each starts `undefined` — "not
            // evaluated" — and is only ever flipped to `true`/`false` by the
            // blocks above). `false` means a transient send failure or an
            // unresolved lost-claim race — real work this slug still owes.
            if (comingUpTerminal === false || sunColorTerminal === false) {
              retryableDueSlugs.add(slug);
            }
          } catch (e) {
            // Round-5 item 2: an exception here means this device's own
            // evaluation never reached a terminal outcome at all (unlike the
            // `comingUpTerminal`/`sunColorTerminal === false` check above,
            // which only runs when the try block completes) — just as
            // retryable as a transient send failure, so this slug still owes
            // real, time-sensitive work. Same "gated later, at read-time, by
            // selectedDueSet" pattern as every other `retryableDueSlugs.add`.
            retryableDueSlugs.add(slug);
            errors += 1;
            console.error("push: device failed", sub.device.id, e);
          }
        }
      }
    }
    // Round-3 item 3: fold retryable-this-pass slugs into `dueRemaining` —
    // only for slugs actually selected as `due` this run (a `candidate`-only
    // slug's own retry isn't time-sensitive the same way, same distinction
    // `dueRemaining`'s other increments already draw), and only once per
    // slug regardless of how many of its devices hit a retryable outcome.
    for (const slug of retryableDueSlugs) {
      if (selectedDueSet.has(slug)) dueRemaining += 1;
    }

    // --- At the beach: hazard alerts from each person's own fix. -------------
    if (mode !== "morning") {
      alerts = await runAtBeachAlerts({
        store,
        now: nowMs,
        loadConditions: countedGetConditions,
        deliver: async (sub, msg) => {
          const sendOne = senderFor(sub);
          if (!sendOne) return { ok: false, dead: false };
          return sendOne(msg);
        },
        onDeadToken: (sub) => prune(store, sub).catch((e) => console.error("push: prune failed", e)),
        // Same budget instance the home-digest loop above just spent from
        // (round-2 #4) — the at-beach engine runs SECOND in this request, so
        // it sees whatever the home loop left, and its own internal spends
        // (feed load, its own conditions builds for beaches outside
        // `bySlug`, and its Live Activity/ordinary alert sends) count
        // against the same ceiling. Its own per-stage reserve checks
        // (lightning/at-beach/LA updates/LA ends — Codex round-3 #4b) live
        // inside `runAtBeachAlerts` itself, since only it knows those
        // stages' internal shape.
        budget,
      });
      pruned += alerts.pruned;
    }
    });
  } finally {
    apnsSession?.close();
  }

  return Response.json({
    ok: true,
    mode,
    imported,
    beaches: homeBeaches,
    subscriptions: subs.length,
    ios: subs.filter((s) => s.platform === "ios").length,
    android: subs.filter((s) => s.platform === "android").length,
    sent: morningSent + excellentSent + alerts.sent + comingUpSent + sunColorSent,
    morning: morningSent,
    excellent: excellentSent,
    // Standalone coming-up pushes only (SKY_EVENTS_PLAN.md §10) — one
    // appended to the morning digest is already counted inside `morning`
    // above, since it rides that same send.
    comingUp: comingUpSent,
    sunColor: sunColorSent,
    armed: alerts.devices,
    alerts,
    conditionsFetched,
    pruned,
    errors,
    // Diagnostics for the subrequest budget (round-2 #4) — how much of the
    // ceiling this run had left when it finished, and how many home beaches
    // with real work due got left for next tick, either by
    // PUSH_RUN_MAX_BEACHES' own selection or by the home-digests stage
    // sitting out the whole run for lack of budget (Codex round-3 #4).
    // `beachesDeferred` folds in `candidate`-only deferrals too (elastic,
    // fine to pick up later); `dueRemaining` below is the narrower,
    // time-sensitive subset (a morning digest, a coming-up/sun-color
    // window genuinely waiting on capacity right now).
    subrequestBudgetLeft: budget.left,
    beachesDeferred: homeBeachesDeferred,
    // `due` slugs not served THIS pass (round-2 item 4) — the signal
    // workers/plus-cron's early-stop reads: 0 means every beach with
    // time-sensitive work due this tick got served, so the cron can stop
    // making passes; a run whose LAST pass this tick still reports > 0
    // logs a warning (the alarm for the documented per-tick capacity cap —
    // see docs/architecture.md).
    dueRemaining,
  });
}
