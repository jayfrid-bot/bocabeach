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
import { listNativeSubs, removeNativeSub } from "@/lib/push/nativeStore";
import { getStore, type DeviceStore, type PushableDevice } from "@/lib/db/store";
import { coarsePrefs, parseMode } from "@/lib/db/plus";
import { entitled, type SentState } from "@/lib/db/types";
import { decideNotifications, type PushDecision, type PushSummary } from "@/lib/push/notify";
import { excellentDecision, newSummaryCache, personalSummary } from "@/lib/alerts/morning";
import { runAtBeachAlerts, type AtBeachCounts } from "@/lib/alerts/run";
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

/**
 * How long APNs should STORE an undelivered push so an offline phone (airplane
 * mode / off) still gets it on reconnect, instead of Apple discarding it. The
 * morning summary stays relevant through the beach day; a safety alert goes
 * stale fast. 0 = deliver-or-discard.
 */
function apnsExpiry(tag: string, nowSec: number): number {
  if (tag === "morning") return nowSec + 8 * 3600; // through the beach day
  if (tag === "excellent") return nowSec + 4 * 3600; // the good stretch it names
  if (tag === "safety") return nowSec + 30 * 60; // matches the lightning freshness window
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
  fallbackTz: string,
  now: Date,
  sendOne: SendOne,
  opts?: { force?: "morning" },
): Promise<{ sent: number; pruned: number }> {
  const { hour, date } = localHourAndDate(sub.device.tz || fallbackTz, now);
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
  // it "already sent" and silently skipping the digest).
  let failed = false;
  for (const msg of due) {
    const r = await sendOne(msg);
    if (r.ok) {
      sent += 1;
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
 * Drop a dead token. The legacy KV record goes too — it is still the import
 * source, so leaving it would re-create the device on the next run.
 */
async function prune(store: DeviceStore, sub: PushableDevice): Promise<void> {
  await store.deleteDevice(sub.device.id);
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

  const pushable = await store.listPushable();
  // The home-beach loop needs a home beach; the at-beach engine does not (it
  // works off the presence fix), so only the digest is filtered here.
  const subs = pushable.filter((s) => !!s.device.homeSlug);

  const bySlug = new Map<string, PushableDevice[]>();
  for (const s of subs) {
    const slug = s.device.homeSlug as string;
    const a = bySlug.get(slug);
    if (a) a.push(s);
    else bySlug.set(slug, [s]);
  }

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
  if (fcm && hasAndroid) {
    fcmAccessToken = await getFcmAccessToken(fcm, nowSec).catch(() => null);
  }

  /** The send function for one device, or null when its transport isn't open. */
  const senderFor = (sub: PushableDevice): SendOne | null => {
    if (sub.platform === "ios" && apnsSession) {
      const session = apnsSession;
      return async (msg) => {
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
  let alerts: AtBeachCounts = { devices: 0, evaluated: 0, sent: 0, skipped: 0, errors: 0, pruned: 0 };

  try {
    // --- Home beach: the daily digest + "turned Excellent". Plus only. --------
    if (mode !== "safety") {
      const summaries = newSummaryCache();
      for (const [slug, group] of bySlug) {
        const loc = getLocation(slug);
        if (!loc) continue;
        let res;
        try {
          res = await getConditions(slug);
        } catch {
          continue;
        }
        if (!res) continue;
        const place = { slug, name: loc.name, tz: loc.timezone };

        for (const sub of group) {
          // Every alert is Plus. A free device gets nothing here, and nothing is
          // written for it — its dedup state stays exactly as it was, so the day
          // it upgrades it starts clean.
          if (!entitled(sub.device, nowMs)) continue;
          const sendOne = senderFor(sub);
          if (!sendOne) continue;
          const summary = personalSummary(res, place, sub.device, nowMs, summaries);

          const r = await deliverMorning(store, sub, summary, loc.timezone, now, sendOne, force);
          morningSent += r.sent;
          pruned += r.pruned;
          if (r.pruned) continue; // the device is gone

          const { date } = localHourAndDate(sub.device.tz || loc.timezone, now);
          const excellent = excellentDecision({ device: sub.device, summary, res, nowMs, date });
          if (!excellent) continue;
          if (await store.lastAlert(sub.device.id, excellent.dedupKey)) continue; // once per day
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
          }
        }
      }
    }

    // --- At the beach: hazard alerts from each person's own fix. -------------
    if (mode !== "morning") {
      alerts = await runAtBeachAlerts({
        store,
        now: nowMs,
        deliver: async (sub, msg) => {
          const sendOne = senderFor(sub);
          if (!sendOne) return { ok: false, dead: false };
          return sendOne(msg);
        },
        onDeadToken: (sub) => prune(store, sub).catch((e) => console.error("push: prune failed", e)),
      });
      pruned += alerts.pruned;
    }
  } finally {
    apnsSession?.close();
  }

  return Response.json({
    ok: true,
    mode,
    imported,
    beaches: bySlug.size,
    subscriptions: subs.length,
    ios: subs.filter((s) => s.platform === "ios").length,
    android: subs.filter((s) => s.platform === "android").length,
    sent: morningSent + excellentSent + alerts.sent,
    morning: morningSent,
    excellent: excellentSent,
    armed: alerts.devices,
    alerts,
    pruned,
  });
}
