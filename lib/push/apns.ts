// Apple Push Notification service (APNs) sender for the native iOS app.
//
// Token-based auth (a .p8 key) — no certs. Set as server env vars:
//   APNS_KEY_ID       the Key ID of the APNs Auth Key (.p8)
//   APNS_TEAM_ID      your Apple Developer Team ID
//   APNS_PRIVATE_KEY  the .p8 file contents (PEM; literal \n is unescaped)
//   APNS_BUNDLE_ID    the app bundle id (defaults to com.isitbeachday.app)
//   APNS_PRODUCTION   "false" to use the sandbox gateway (Xcode dev builds);
//                     anything else / unset → production (TestFlight + App Store)
//
// Pure JWT building is split out (testable); the HTTP/2 send needs Apple + a
// real device token, so it's exercised only against the live service.

import http2 from "node:http2";
import { createPrivateKey, createSign } from "node:crypto";
import { readPemEnv } from "@/lib/push/pemEnv";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKey: string;
  bundleId: string;
  production: boolean;
}

/** APNs config from env, or null when not configured (sender then no-ops). */
export function getApns(): ApnsConfig | null {
  const keyId = process.env.APNS_KEY_ID ?? "";
  const teamId = process.env.APNS_TEAM_ID ?? "";
  const privateKey = readPemEnv("APNS_PRIVATE_KEY"); // prefers APNS_PRIVATE_KEY_B64
  if (!keyId || !teamId || !privateKey) return null;
  return {
    keyId,
    teamId,
    privateKey,
    bundleId: process.env.APNS_BUNDLE_ID ?? "com.isitbeachday.app",
    production: (process.env.APNS_PRODUCTION ?? "true") !== "false",
  };
}

const b64url = (v: Buffer | string) => Buffer.from(v).toString("base64url");

/**
 * Build an ES256 provider JWT for APNs (reusable for ~1h — generate once per
 * run). Pure given its inputs; `nowSec` is whole seconds since the epoch.
 */
export function buildApnsJwt(
  cfg: Pick<ApnsConfig, "keyId" | "teamId" | "privateKey">,
  nowSec: number,
): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: cfg.keyId }));
  const payload = b64url(JSON.stringify({ iss: cfg.teamId, iat: Math.floor(nowSec) }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("SHA256")
    .update(signingInput)
    // JOSE wants the raw r||s pair, not DER — `ieee-p1363` gives that.
    .sign({ key: createPrivateKey(cfg.privateKey), dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(signature)}`;
}

export interface ApnsResult {
  ok: boolean;
  status?: number;
  /** APNs failure reason, e.g. "BadDeviceToken" / "Unregistered". */
  reason?: string;
}

/** True when APNs says this device token is dead and should be pruned. */
export function isDeadToken(r: ApnsResult): boolean {
  return r.status === 410 || (r.status === 400 && r.reason === "BadDeviceToken");
}

export interface ApnsPayload {
  title: string;
  body: string;
  url: string;
  /** Collapse id — a later push with the same id replaces an undelivered one. */
  tag?: string;
  /**
   * Unix-seconds expiry. APNs STORES the push and retries until then if the
   * device is offline. Omitted/0 means "deliver once, or discard" — which silently
   * drops the notification when the phone is in airplane mode / off at send time.
   */
  expiration?: number;
}

/**
 * A Beach Session Live Activity push (docs/LIVE_ACTIVITY_PLAN.md "Server" +
 * "APNs" sections) — a different apns-push-type/topic/payload shape than an
 * ordinary alert, per Apple's ActivityKit push contract:
 *   https://developer.apple.com/documentation/activitykit/updating-and-ending-your-live-activity-with-remote-push-notifications
 * `contentState` is whatever lib/liveActivity/state.ts's
 * `BeachSessionContentState` currently is — apns.ts stays push-transport-only
 * and never imports that module, so it takes the already-built JSON value.
 */
export interface LiveActivityUpdate {
  contentState: unknown;
  event: "update" | "end";
  /** ActivityKit `timestamp` — epoch ms; converted to whole seconds here. */
  timestampMs: number;
  /** `stale-date` — epoch ms, converted to whole seconds. */
  staleDateMs?: number;
  /** `dismissal-date` — epoch ms, converted to whole seconds. */
  dismissalDateMs?: number;
  /** `relevance-score`: 50 normal, 100 while lightning is active, 0 on end
   *  (docs/LIVE_ACTIVITY_PLAN.md). Left out of the payload when omitted. */
  relevanceScore?: number;
  /** 5 for heartbeats/ordinary changes, 10 for the lightning promotion and a
   *  timely end — never a plain number, so a caller can't accidentally send
   *  APNs an unsupported priority. */
  priority: 5 | 10;
}

export interface ApnsSession {
  send: (deviceToken: string, payload: ApnsPayload) => Promise<ApnsResult>;
  /** The Live Activity path — same JWT/HTTP/2 connection as `send`, a
   *  distinct apns-push-type/topic/payload. Does not touch `send` at all. */
  sendLiveActivityUpdate: (deviceToken: string, update: LiveActivityUpdate) => Promise<ApnsResult>;
  close: () => void;
}

const PROD_HOST = "https://api.push.apple.com";
const SANDBOX_HOST = "https://api.sandbox.push.apple.com";

/** The single HTTP/2 connection + JWT builder shared by `openApnsSession`
 *  (one environment, picked by `cfg.production`, for ordinary alert pushes)
 *  and `openLiveActivitySessions` (BOTH environments, one row's
 *  `apns_environment` at a time — Codex review #5). Pulled out so neither
 *  caller duplicates the request-building logic. */
function buildSession(host: string, jwt: string, cfg: ApnsConfig): ApnsSession {
  const client = http2.connect(host);
  // Swallow session-level errors; per-request handlers resolve their results.
  client.on("error", () => {});

  const send = (deviceToken: string, payload: ApnsPayload): Promise<ApnsResult> =>
    new Promise<ApnsResult>((resolve) => {
      const body = JSON.stringify({
        aps: { alert: { title: payload.title, body: payload.body }, sound: "default" },
        url: payload.url,
      });
      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": cfg.bundleId,
        "apns-push-type": "alert",
        "content-type": "application/json",
        ...(payload.expiration ? { "apns-expiration": String(Math.floor(payload.expiration)) } : {}),
        ...(payload.tag ? { "apns-collapse-id": payload.tag.slice(0, 64) } : {}),
      });
      let status = 0;
      let data = "";
      req.on("response", (h) => {
        status = Number(h[":status"]) || 0;
      });
      req.setEncoding("utf8");
      req.on("data", (d) => (data += d));
      req.on("end", () => {
        if (status === 200) return resolve({ ok: true, status });
        let reason = data;
        try {
          reason = (JSON.parse(data) as { reason?: string }).reason ?? data;
        } catch {
          /* keep raw */
        }
        resolve({ ok: false, status, reason });
      });
      req.on("error", (e) => resolve({ ok: false, reason: String(e) }));
      req.end(body);
    });

  // Same JWT/HTTP2 connection as `send` above (never forked); only the
  // headers/topic/payload differ, per ActivityKit's push contract.
  const sendLiveActivityUpdate = (deviceToken: string, update: LiveActivityUpdate): Promise<ApnsResult> =>
    new Promise<ApnsResult>((resolve) => {
      const aps: Record<string, unknown> = {
        timestamp: Math.floor(update.timestampMs / 1000),
        event: update.event,
        "content-state": update.contentState,
      };
      if (update.staleDateMs != null) aps["stale-date"] = Math.floor(update.staleDateMs / 1000);
      if (update.dismissalDateMs != null) aps["dismissal-date"] = Math.floor(update.dismissalDateMs / 1000);
      if (update.relevanceScore != null) aps["relevance-score"] = update.relevanceScore;
      const body = JSON.stringify({ aps });
      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": `${cfg.bundleId}.push-type.liveactivity`,
        "apns-push-type": "liveactivity",
        "apns-priority": String(update.priority),
        "content-type": "application/json",
      });
      let status = 0;
      let data = "";
      req.on("response", (h) => {
        status = Number(h[":status"]) || 0;
      });
      req.setEncoding("utf8");
      req.on("data", (d) => (data += d));
      req.on("end", () => {
        if (status === 200) return resolve({ ok: true, status });
        let reason = data;
        try {
          reason = (JSON.parse(data) as { reason?: string }).reason ?? data;
        } catch {
          /* keep raw */
        }
        resolve({ ok: false, status, reason });
      });
      req.on("error", (e) => resolve({ ok: false, reason: String(e) }));
      req.end(body);
    });

  return {
    send,
    sendLiveActivityUpdate,
    close: () => {
      try {
        client.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * Open one HTTP/2 session to APNs and reuse it for every send in this run (one
 * JWT, one connection). Call `close()` when done. Ordinary alert pushes
 * always use the server's own `cfg.production` environment — unaffected by
 * `openLiveActivitySessions` below, which is the ONLY thing that ever talks
 * to the sandbox host.
 */
export function openApnsSession(cfg: ApnsConfig, nowSec: number): ApnsSession {
  const host = cfg.production ? PROD_HOST : SANDBOX_HOST;
  const jwt = buildApnsJwt(cfg, nowSec);
  return buildSession(host, jwt, cfg);
}

export interface LiveActivitySessions {
  /** Routes by `environment` — never by `cfg.production` — so a sandbox row
   *  (a TestFlight/Xcode-dev build) can never be sent through the production
   *  gateway even when this server's OWN `APNS_PRODUCTION` is on, and vice
   *  versa (Codex review #5). `environment: null` (a row registered before
   *  the app started sending `apnsEnvironment`) falls back to `cfg.production`,
   *  same as every send did before per-row routing existed. */
  sendLiveActivityUpdate: (
    deviceToken: string,
    update: LiveActivityUpdate,
    environment: "production" | "sandbox" | null,
  ) => Promise<ApnsResult>;
  close: () => void;
}

/**
 * One JWT, up to TWO HTTP/2 connections — production and sandbox — opened
 * lazily so a run with no sandbox rows never pays for that connection.
 * `lib/alerts/run.ts` opens exactly one of these per run (never one per
 * activity) and closes it when the run finishes, same lifecycle as
 * `openApnsSession`.
 */
export function openLiveActivitySessions(cfg: ApnsConfig, nowSec: number): LiveActivitySessions {
  const jwt = buildApnsJwt(cfg, nowSec);
  let prod: ApnsSession | null = null;
  let sandbox: ApnsSession | null = null;

  function sessionFor(environment: "production" | "sandbox" | null): ApnsSession {
    const useProduction = environment === "sandbox" ? false : environment === "production" ? true : cfg.production;
    if (useProduction) {
      prod ??= buildSession(PROD_HOST, jwt, cfg);
      return prod;
    }
    sandbox ??= buildSession(SANDBOX_HOST, jwt, cfg);
    return sandbox;
  }

  return {
    sendLiveActivityUpdate: (deviceToken, update, environment) =>
      sessionFor(environment).sendLiveActivityUpdate(deviceToken, update),
    close: () => {
      prod?.close();
      sandbox?.close();
    },
  };
}
