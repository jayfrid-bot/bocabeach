// Firebase Cloud Messaging (FCM) sender for the native Android app.
//
// Uses the FCM HTTP v1 API with a service account. Set as server env vars
// (from the service-account JSON you download in the Firebase console →
// Project settings → Service accounts → Generate new private key):
//   FCM_PROJECT_ID    the Firebase project id
//   FCM_CLIENT_EMAIL  the service account's client_email
//   FCM_PRIVATE_KEY   the service account's private_key (PEM; literal \n unescaped)
//
// Pure JWT building is split out (testable); the OAuth2 exchange + send need
// Google + a real device token, so they run only against the live service.

import { createSign } from "node:crypto";
import { readPemEnv } from "@/lib/push/pemEnv";

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/** FCM config from env, or null when not configured (sender then no-ops). */
export function getFcm(): FcmConfig | null {
  const projectId = process.env.FCM_PROJECT_ID ?? "";
  const clientEmail = process.env.FCM_CLIENT_EMAIL ?? "";
  const privateKey = readPemEnv("FCM_PRIVATE_KEY"); // prefers FCM_PRIVATE_KEY_B64
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

const b64url = (v: Buffer | string) => Buffer.from(v).toString("base64url");

/**
 * Build the RS256 service-account JWT for the Google OAuth2 token exchange.
 * Pure given its inputs; `nowSec` is whole seconds since the epoch.
 */
export function buildGoogleJwt(
  cfg: Pick<FcmConfig, "clientEmail" | "privateKey">,
  nowSec: number,
): string {
  const iat = Math.floor(nowSec);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: cfg.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(cfg.privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

/** Exchange the service-account JWT for an OAuth2 access token (reuse per run). */
export async function getFcmAccessToken(cfg: FcmConfig, nowSec: number): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: buildGoogleJwt(cfg, nowSec),
    }),
  });
  if (!res.ok) throw new Error(`FCM token exchange ${res.status}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("FCM token exchange: no access_token");
  return json.access_token;
}

export interface FcmResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

/** True when FCM says this token is gone and should be pruned. */
export function isDeadFcmToken(r: FcmResult): boolean {
  return r.status === 404 || /UNREGISTERED/i.test(r.reason ?? "");
}

export interface FcmPayload {
  title: string;
  body: string;
  url: string;
}

/** Send one notification via FCM HTTP v1. */
export async function sendFcm(
  accessToken: string,
  projectId: string,
  token: string,
  payload: FcmPayload,
): Promise<FcmResult> {
  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: payload.title, body: payload.body },
            data: { url: payload.url },
            android: { priority: "high" },
          },
        }),
      },
    );
    if (res.ok) return { ok: true, status: res.status };
    let reason = await res.text();
    try {
      reason = (JSON.parse(reason) as { error?: { status?: string } }).error?.status ?? reason;
    } catch {
      /* keep raw */
    }
    return { ok: false, status: res.status, reason };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}
