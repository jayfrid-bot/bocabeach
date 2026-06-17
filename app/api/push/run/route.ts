// POST /api/push/run — the push sender. Hit on a schedule (the GitHub Action in
// .github/workflows/push-cron.yml) with the shared CRON_SECRET. For each beach
// with subscribers it computes conditions once, then per subscriber decides
// whether a morning summary or safety alert is due and sends it over BOTH
// transports: Web Push (browsers) and APNs (the native iOS app).
//
// Auth: header `x-cron-secret: <CRON_SECRET>`. Returns 503 until CRON_SECRET and
// at least one transport (VAPID and/or APNs) are configured, so a half-set-up
// deploy never sends.

import { timingSafeEqual } from "node:crypto";
import webpush from "web-push";
import { getConditions } from "@/lib/conditions";
import { getLocation } from "@/config/locations";
import {
  listSubscriptions,
  putSubscription,
  removeSubscription,
} from "@/lib/push/store";
import {
  listNativeSubs,
  putNativeSub,
  removeNativeSub,
} from "@/lib/push/nativeStore";
import { decideNotifications, summarizeForPush, type PushDecision } from "@/lib/push/notify";
import { getVapid } from "@/lib/push/vapid";
import { getApns, isDeadToken, openApnsSession } from "@/lib/push/apns";

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
  }).format(now); // YYYY-MM-DD
  return { hour, date };
}

function groupBySlug<T extends { slug: string }>(arr: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of arr) {
    const a = m.get(x.slug);
    if (a) a.push(x);
    else m.set(x.slug, [x]);
  }
  return m;
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
 * Decide + deliver for one subscription over a given transport. `sendOne` sends
 * a single message and reports {ok, dead}; a dead endpoint/token is pruned and
 * its remaining sends skipped. Returns the counts and whether it was pruned.
 */
async function deliver(
  sub: { prefs: { morning: boolean; safety: boolean }; sent?: { morningDate?: string; safetyKey?: string }; tz: string },
  summary: Summary,
  fallbackTz: string,
  now: Date,
  sendOne: (msg: PushDecision) => Promise<{ ok: boolean; dead: boolean }>,
  removeSub: () => Promise<void>,
  persist: (sent: { morningDate?: string; safetyKey?: string }) => Promise<void>,
): Promise<{ sent: number; pruned: number }> {
  const { hour, date } = localHourAndDate(sub.tz || fallbackTz, now);
  const { sends, nextSent } = decideNotifications(sub, summary, hour, date);
  let sent = 0;
  let pruned = 0;
  let removed = false;
  for (const msg of sends) {
    const r = await sendOne(msg);
    if (r.ok) sent += 1;
    else if (r.dead) {
      await removeSub().catch(() => {});
      removed = true;
      pruned += 1;
      break;
    }
  }
  if (!removed && JSON.stringify(nextSent) !== JSON.stringify(sub.sent ?? {})) {
    await persist(nextSent).catch(() => {});
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

  const vapid = getVapid();
  const apns = getApns();
  if (!vapid && !apns) {
    return Response.json({ error: "no push transport configured (set VAPID and/or APNS env)" }, { status: 503 });
  }
  if (vapid) webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  const now = new Date();
  const webSubs = vapid ? await listSubscriptions() : [];
  const nativeSubs = apns ? await listNativeSubs() : [];
  const webBySlug = groupBySlug(webSubs);
  const nativeBySlug = groupBySlug(nativeSubs);
  const slugs = new Set<string>([...webBySlug.keys(), ...nativeBySlug.keys()]);

  const apnsSession =
    apns && nativeSubs.length ? openApnsSession(apns, Math.floor(now.getTime() / 1000)) : null;

  let sent = 0;
  let pruned = 0;
  try {
    for (const slug of slugs) {
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

      for (const sub of webBySlug.get(slug) ?? []) {
        const r = await deliver(
          sub,
          summary,
          loc.timezone,
          now,
          async (msg) => {
            try {
              await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: sub.keys },
                JSON.stringify({ title: msg.title, body: msg.body, tag: msg.tag, url: msg.url }),
              );
              return { ok: true, dead: false };
            } catch (e) {
              const code = (e as { statusCode?: number })?.statusCode;
              return { ok: false, dead: code === 404 || code === 410 };
            }
          },
          () => removeSubscription(sub.endpoint),
          (nextSent) => putSubscription({ ...sub, sent: nextSent }),
        );
        sent += r.sent;
        pruned += r.pruned;
      }

      if (apnsSession) {
        for (const sub of nativeBySlug.get(slug) ?? []) {
          const r = await deliver(
            sub,
            summary,
            loc.timezone,
            now,
            async (msg) => {
              const res2 = await apnsSession.send(sub.token, {
                title: msg.title,
                body: msg.body,
                url: msg.url,
                tag: msg.tag,
              });
              return { ok: res2.ok, dead: isDeadToken(res2) };
            },
            () => removeNativeSub(sub.token),
            (nextSent) => putNativeSub({ ...sub, sent: nextSent }),
          );
          sent += r.sent;
          pruned += r.pruned;
        }
      }
    }
  } finally {
    apnsSession?.close();
  }

  return Response.json({
    ok: true,
    beaches: slugs.size,
    web: webSubs.length,
    native: nativeSubs.length,
    sent,
    pruned,
  });
}
