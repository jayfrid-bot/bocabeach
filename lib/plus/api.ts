// The Plus HTTP client. Every call RESOLVES — a dead network, a 500, or a
// half-JSON body all come back as `{ ok: false, error }`, so no caller needs a
// try/catch and no failure can take the dashboard down with it.
//
// Routes and shapes are the contract in docs/PLUS_BUILD_SPEC.md.

import type { AlertPrefs, DeviceRecord } from "@/lib/db/types";
import type { ScoreProfile } from "@/lib/profile/types";
import { readInstallToken, writeInstallToken } from "@/lib/plus/storage";

export interface PlusResult {
  ok: boolean;
  device: DeviceRecord | null;
  /** Machine-readable slug from the server, or "network" when it never answered. */
  error: string | null;
  status: number;
  /**
   * `/api/presence` only (LOC-03): the server holds a push token for this
   * device, so an armed session can actually be delivered to. Undefined on
   * every other route.
   */
  pushReady?: boolean;
}

/** What a client may change about its own device row. */
export interface DevicePatchBody {
  platform?: "ios" | "android" | "web";
  tz?: string;
  homeSlug?: string;
  profile?: ScoreProfile;
  prefs?: Partial<AlertPrefs>;
  previewSeen?: boolean;
}

/** One armed "I am at this beach" window. */
export interface PresenceBody {
  slug: string;
  lat?: number | null;
  lon?: number | null;
  accuracyM?: number | null;
  fixAt?: number | null;
  armedUntil: number;
  source: "auto" | "manual";
}

/** Every Plus call carries the install token (Codex review #1), when this
 *  phone has one — `/api/live-activity/register`, `/end`, and `/api/hazards`
 *  require it once a device has a hash on file; every other route accepts it
 *  optionally and logs nothing. A phone with no token yet (never called
 *  POST /api/devices, or lost local storage) simply omits the header, same
 *  as before this existed. */
function withInstallToken(init?: RequestInit): RequestInit | undefined {
  const token = readInstallToken();
  // No token → leave `init` exactly as the caller passed it (including
  // `undefined` for a bare GET) rather than manufacturing an empty object.
  if (!token) return init;
  const headers = new Headers(init?.headers);
  headers.set("x-install-token", token);
  return { ...init, headers };
}

async function request(url: string, init?: RequestInit): Promise<PlusResult> {
  let res: Response;
  try {
    res = await fetch(url, withInstallToken(init));
  } catch {
    return { ok: false, device: null, error: "network", status: 0 };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const obj = (body ?? {}) as {
    ok?: unknown;
    device?: unknown;
    error?: unknown;
    pushReady?: unknown;
    installToken?: unknown;
  };
  // POST /api/devices mints this at most once per device — capture it the
  // moment it arrives, whichever call site triggered the mint.
  if (typeof obj.installToken === "string" && obj.installToken) writeInstallToken(obj.installToken);
  if (res.ok && obj.ok === true) {
    return {
      ok: true,
      device: (obj.device as DeviceRecord) ?? null,
      error: null,
      status: res.status,
      ...(typeof obj.pushReady === "boolean" ? { pushReady: obj.pushReady } : {}),
    };
  }
  const error = typeof obj.error === "string" ? obj.error : "server";
  return { ok: false, device: null, error, status: res.status };
}

function postJson(url: string, body: unknown): Promise<PlusResult> {
  return request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const plusApi = {
  /** Read this device's row. 404 `not-found` for a device the server never saw. */
  getDevice(deviceId: string): Promise<PlusResult> {
    return request(`/api/devices?deviceId=${encodeURIComponent(deviceId)}`);
  },
  /** Upsert: only the fields present change. */
  saveDevice(deviceId: string, patch: DevicePatchBody): Promise<PlusResult> {
    return postJson("/api/devices", { deviceId, ...patch });
  },
  startTrial(deviceId: string): Promise<PlusResult> {
    return postJson("/api/devices/trial", { deviceId });
  },
  unlock(deviceId: string, code: string): Promise<PlusResult> {
    return postJson("/api/devices/unlock", { deviceId, code });
  },
  /** After an App Store purchase or Restore: have the server confirm it with
   *  RevenueCat and turn Plus on. Never turns it off. */
  syncPurchase(deviceId: string): Promise<PlusResult> {
    return postJson("/api/devices/purchase", { deviceId });
  },
  arm(deviceId: string, presence: PresenceBody): Promise<PlusResult> {
    return postJson("/api/presence", { deviceId, ...presence });
  },
  disarm(deviceId: string): Promise<PlusResult> {
    return request("/api/presence", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId }),
    });
  },
};

/** Plain English for every error slug the Plus routes can answer with. */
export function plusErrorMessage(error: string | null): string {
  switch (error) {
    case null:
      return "";
    case "network":
      return "No connection. Check your signal and try again.";
    case "trial-used":
      return "You have already used the free trial on this device.";
    case "bad-code":
      return "That code did not work. Check it and try again.";
    case "too-many-attempts":
      return "Too many tries. Wait a bit and try again.";
    case "not-entitled":
      return "That is part of Beach Day Plus.";
    case "app-only":
      return "Beach Day Plus lives in the iPhone app. Get the app to start your trial.";
    case "server-trial-off":
      return "Free trials come from the App Store now. Open the plan picker to start yours.";
    case "not-found":
      return "We could not find a subscription for this device.";
    case "store-unavailable":
      return "Our end had a problem saving that. Try again in a minute.";
    case "billing-unavailable":
    case "not-configured":
      return "We could not reach billing to confirm that. Try again in a minute.";
    case "purchase-failed":
      return "The App Store could not complete that purchase. Try again.";
    case "purchase-unconfirmed":
      return "Your purchase went through, but we couldn't confirm it yet. Tap Restore in a moment, or reopen the app.";
    case "bad-request":
      return "Something about that request was wrong. Try again.";
    default:
      return "That did not work. Try again in a minute.";
  }
}
