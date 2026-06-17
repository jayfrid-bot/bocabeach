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
}

export interface ApnsSession {
  send: (deviceToken: string, payload: ApnsPayload) => Promise<ApnsResult>;
  close: () => void;
}

/**
 * Open one HTTP/2 session to APNs and reuse it for every send in this run (one
 * JWT, one connection). Call `close()` when done.
 */
export function openApnsSession(cfg: ApnsConfig, nowSec: number): ApnsSession {
  const host = cfg.production
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";
  const jwt = buildApnsJwt(cfg, nowSec);
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

  return {
    send,
    close: () => {
      try {
        client.close();
      } catch {
        /* already closed */
      }
    },
  };
}
