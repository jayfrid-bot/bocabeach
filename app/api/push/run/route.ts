// POST /api/push/run — the native push sender. Hit on a schedule (the GitHub
// Action in .github/workflows/push-cron.yml) with the shared CRON_SECRET. For
// each beach with subscribers it computes conditions once, then per device
// decides whether a morning summary or safety alert is due and sends it over the
// right transport: APNs for iOS, FCM for Android.
//
// Auth: header `x-cron-secret: <CRON_SECRET>`. Returns 503 until CRON_SECRET and
// at least one transport (APNs and/or FCM) are configured, so a half-set-up
// deploy never sends.

import { timingSafeEqual } from "node:crypto";
import { getConditions } from "@/lib/conditions";
import { getLocation } from "@/config/locations";
import {
  listNativeSubs,
  putNativeSub,
  removeNativeSub,
  type NativeSub,
} from "@/lib/push/nativeStore";
import { decideNotifications, summarizeForPush, type PushDecision } from "@/lib/push/notify";
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

interface Summary {
  slug: string;
  name: string;
  score: number;
  verdict: string;
  bestWindow?: string;
  safetyKey?: string;
  safetyText?: string;
}

/**
 * Decide + deliver for one device. `sendOne` sends a single message over its
 * transport and reports {ok, dead}; a dead token is pruned and its remaining
 * sends skipped. Returns counts. Persists dedup state unless pruned.
 */
async function deliver(
  sub: NativeSub,
  summary: Summary,
  fallbackTz: string,
  now: Date,
  sendOne: (msg: PushDecision) => Promise<{ ok: boolean; dead: boolean }>,
): Promise<{ sent: number; pruned: number }> {
  const { hour, date } = localHourAndDate(sub.tz || fallbackTz, now);
  const { sends, nextSent } = decideNotifications(sub, summary, hour, date);
  let sent = 0;
  let pruned = 0;
  let removed = false;
  // Advance a channel's dedup state ONLY if its send actually succeeded — a
  // transient failure must leave the old state so the next run retries (instead
  // of marking it "already sent" and silently skipping the alert).
  let morningFailed = false;
  let safetyFailed = false;
  for (const msg of sends) {
    const r = await sendOne(msg);
    if (r.ok) {
      sent += 1;
    } else if (r.dead) {
      await removeNativeSub(sub.token).catch((e) => console.error("push: prune failed", e));
      removed = true;
      pruned += 1;
      break;
    } else if (msg.tag === "morning") {
      morningFailed = true;
    } else if (msg.tag === "safety") {
      safetyFailed = true;
    }
  }
  if (!removed) {
    const next = { ...(sub.sent ?? {}) };
    if (!morningFailed) next.morningDate = nextSent.morningDate;
    if (!safetyFailed) next.safetyKey = nextSent.safetyKey; // also clears when hazard gone
    if (JSON.stringify(next) !== JSON.stringify(sub.sent ?? {})) {
      await putNativeSub({ ...sub, sent: next }).catch((e) =>
        console.error("push: persist dedup failed for", sub.slug, e),
      );
    }
  }
  return { sent, pruned };
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

  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const subs = await listNativeSubs();

  const bySlug = new Map<string, NativeSub[]>();
  for (const s of subs) {
    const a = bySlug.get(s.slug);
    if (a) a.push(s);
    else bySlug.set(s.slug, [s]);
  }

  // Open each transport once, only if it's configured AND has devices waiting.
  const hasIos = subs.some((s) => s.platform === "ios");
  const hasAndroid = subs.some((s) => s.platform === "android");
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

  let sent = 0;
  let pruned = 0;
  try {
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
      const summary = summarizeForPush(res, { slug, name: loc.name, tz: loc.timezone });

      for (const sub of group) {
        let result: { sent: number; pruned: number } | null = null;
        if (sub.platform === "ios" && apnsSession) {
          const session = apnsSession;
          result = await deliver(sub, summary, loc.timezone, now, async (msg) => {
            const r = await session.send(sub.token, {
              title: msg.title,
              body: msg.body,
              url: msg.url,
              tag: msg.tag,
            });
            return { ok: r.ok, dead: isDeadToken(r) };
          });
        } else if (sub.platform === "android" && fcm && fcmAccessToken) {
          const token = fcmAccessToken;
          result = await deliver(sub, summary, loc.timezone, now, async (msg) => {
            const r = await sendFcm(token, fcm.projectId, sub.token, {
              title: msg.title,
              body: msg.body,
              url: msg.url,
            });
            return { ok: r.ok, dead: isDeadFcmToken(r) };
          });
        }
        if (result) {
          sent += result.sent;
          pruned += result.pruned;
        }
      }
    }
  } finally {
    apnsSession?.close();
  }

  return Response.json({
    ok: true,
    beaches: bySlug.size,
    subscriptions: subs.length,
    ios: subs.filter((s) => s.platform === "ios").length,
    android: subs.filter((s) => s.platform === "android").length,
    sent,
    pruned,
  });
}
