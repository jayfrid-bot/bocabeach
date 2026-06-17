// POST /api/push/run — the push sender. Hit on a schedule (a GitHub Action
// cron, see .github/workflows/push-cron.yml) with the shared CRON_SECRET. For
// each beach with subscribers it computes conditions once, then per subscriber
// decides whether a morning summary or a safety alert is due and sends it.
//
// Auth: header `x-cron-secret: <CRON_SECRET>`. Returns 503 until CRON_SECRET +
// VAPID keys are configured, so a half-set-up deploy never sends.

import { timingSafeEqual } from "node:crypto";
import webpush from "web-push";
import { getConditions } from "@/lib/conditions";
import { getLocation } from "@/config/locations";
import {
  listSubscriptions,
  putSubscription,
  removeSubscription,
  type StoredSub,
} from "@/lib/push/store";
import { decideNotifications, summarizeForPush } from "@/lib/push/notify";
import { getVapid } from "@/lib/push/vapid";

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

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "push sender not configured (CRON_SECRET unset)" }, { status: 503 });
  }
  if (!secretEqual(req.headers.get("x-cron-secret") ?? "", secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const vapid = getVapid();
  if (!vapid) {
    return Response.json({ error: "VAPID keys not configured" }, { status: 503 });
  }
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  const now = new Date();
  const subs = await listSubscriptions();

  // Group subscriptions by beach so each beach's conditions are fetched once.
  const bySlug = new Map<string, StoredSub[]>();
  for (const sub of subs) {
    const arr = bySlug.get(sub.slug);
    if (arr) arr.push(sub);
    else bySlug.set(sub.slug, [sub]);
  }

  let sent = 0;
  let pruned = 0;

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
      const { hour, date } = localHourAndDate(sub.tz || loc.timezone, now);
      const { sends, nextSent } = decideNotifications(sub, summary, hour, date);

      let removed = false;
      for (const msg of sends) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            JSON.stringify({ title: msg.title, body: msg.body, tag: msg.tag, url: msg.url }),
          );
          sent += 1;
        } catch (e) {
          const code = (e as { statusCode?: number })?.statusCode;
          if (code === 404 || code === 410) {
            await removeSubscription(sub.endpoint).catch(() => {});
            removed = true;
            pruned += 1;
            break; // dead endpoint — stop sending to it
          }
          // Other errors (network/5xx): leave the subscription, try next run.
        }
      }

      // Persist updated dedup state unless the endpoint was pruned.
      if (!removed && JSON.stringify(nextSent) !== JSON.stringify(sub.sent ?? {})) {
        await putSubscription({ ...sub, sent: nextSent }).catch(() => {});
      }
    }
  }

  return Response.json({ ok: true, beaches: bySlug.size, subscriptions: subs.length, sent, pruned });
}
