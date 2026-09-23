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

import { timingSafeEqual } from "node:crypto";
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
 * its remaining sends skipped. Persists dedup state unless pruned.
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
  opts?: { force?: "morning" },
): Promise<{ sent: number; pruned: number }> {
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
    const r = await sendOne(msg);
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
  if (!removed && !failed) {
    const next: SentState = { ...sub.sent, morningDate: nextSent.morningDate };
    if (JSON.stringify(next) !== JSON.stringify(sub.sent)) {
      await store
        .setSent(sub.device.id, next)
        .catch((e) => console.error("push: persist dedup failed for", sub.device.homeSlug, e));
    }
  }
  return { sent, pruned };
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
    } catch {
      apnsSession = null; // bad .p8 → skip iOS this run
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
   *  - `due`: the morning digest's own MORNING_HOUR gate (or `?force=morning`)
   *    — time-sensitive, missing it this run means missing it for the whole
   *    day, so a `due` slug is never left out by the cap below.
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
        if (sub.device.prefs["score-excellent"] !== false && isDaylightAt(loc, now, date)) {
          const already = await store.lastAlert(sub.device.id, `score-excellent:${date}`);
          if (!already) candidate = true;
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
  homeBeachesDeferred = dueSlugs.length - selectedDue.length + (candidateSlugs.length - selectedCandidates.length);
  const slugsThisRunSet = new Set([...selectedDue, ...selectedCandidates]);
  const bySlug = new Map([...bySlugAll].filter(([slug]) => slugsThisRunSet.has(slug)));

  try {
    await runWithBudget(budget, async () => {
    // --- Home beach: the daily digest + "turned Excellent". Plus only. --------
    // Stage reserve (Codex round-3 #4b): skip the WHOLE stage up front when
    // there isn't even enough budget left for one send — deferred slugs are
    // simply picked up again next tick, same as PUSH_RUN_MAX_BEACHES' own
    // deferrals above.
    if (mode !== "safety" && budget.left < STAGE_RESERVE.homeDigests) {
      homeBeachesDeferred += bySlug.size;
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
          continue;
        }
        if (!res) continue;
        if (res.budgetAborted) {
          // Codex round-5 #1: this build ran out of subrequest budget
          // partway through — one or more sources are deliberately missing,
          // not genuinely down. Never build a digest/"turned Excellent" off
          // it; leave this beach's group for next tick instead. Counted in
          // beaches (one slug), the same unit as the cap deferrals above.
          homeBeachesDeferred += 1;
          continue;
        }
        const place = { slug, name: loc.name, tz: loc.timezone };

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

            const r = await deliverMorning(store, sub, summary, loc.timezone, now, sendOne, force);
            morningSent += r.sent;
            pruned += r.pruned;
            if (r.pruned) continue; // the device is gone

            // The Excellent daily-dedup key is a calendar day in the BEACH's
            // timezone too, so it can't drift from the same day the digest uses.
            const { date } = localHourAndDate(loc.timezone, now);
            const excellent = excellentDecision({ device: sub.device, summary, res, nowMs, date });
            if (!excellent) continue;
            if (await store.lastAlert(sub.device.id, excellent.dedupKey)) continue; // once per day
            // The send claim (#14): a concurrent run could have read the same
            // "not sent today" answer above, a moment before either of us
            // wrote alert_log. Only the run that wins this claim may send.
            const claimKey = sendClaimKey(sub.device.id, "score-excellent", date);
            if (!(await store.claimSend(claimKey, nowMs))) continue;
            const sent = await sendOne({
              tag: excellent.tag,
              title: excellent.title,
              body: excellent.body,
              url: `/${slug}`,
            });
            if (sent.dead) {
              await prune(store, sub).catch((e) => console.error("push: prune failed", e));
              pruned += 1;
            } else if (sent.ok) {
              excellentSent += 1;
              await store.markAlert(sub.device.id, excellent.dedupKey, nowMs, excellent.meta);
              await store.markSent(claimKey, nowMs);
            }
          } catch (e) {
            errors += 1;
            console.error("push: device failed", sub.device.id, e);
          }
        }
      }
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
    sent: morningSent + excellentSent + alerts.sent,
    morning: morningSent,
    excellent: excellentSent,
    armed: alerts.devices,
    alerts,
    conditionsFetched,
    pruned,
    errors,
    // Diagnostics for the subrequest budget (round-2 #4) — how much of the
    // ceiling this run had left when it finished, and how many home beaches
    // with real work due (candidate-only — `due` digests are never deferred)
    // got left for next tick, either by PUSH_RUN_MAX_BEACHES' own selection
    // or by the home-digests stage sitting out the whole run for lack of
    // budget (Codex round-3 #4).
    subrequestBudgetLeft: budget.left,
    beachesDeferred: homeBeachesDeferred,
  });
}
