// The Plus HTTP client. Every call RESOLVES — a dead network, a 500, or a
// half-JSON body all come back as `{ ok: false, error }`, so no caller needs a
// try/catch and no failure can take the dashboard down with it.
//
// Routes and shapes are the contract in docs/PLUS_BUILD_SPEC.md.

import type { AlertPrefs, DeviceRecord } from "@/lib/db/types";
import type { ScoreProfile } from "@/lib/profile/types";

export interface PlusResult {
  ok: boolean;
  device: DeviceRecord | null;
  /** Machine-readable slug from the server, or "network" when it never answered. */
  error: string | null;
  status: number;
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

async function request(url: string, init?: RequestInit): Promise<PlusResult> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, device: null, error: "network", status: 0 };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const obj = (body ?? {}) as { ok?: unknown; device?: unknown; error?: unknown };
  if (res.ok && obj.ok === true) {
    return { ok: true, device: (obj.device as DeviceRecord) ?? null, error: null, status: res.status };
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
    case "not-entitled":
      return "Alerts are part of Beach Day Plus.";
    case "not-found":
      return "We could not find a subscription for this device.";
    case "store-unavailable":
      return "Our end had a problem saving that. Try again in a minute.";
    case "bad-request":
      return "Something about that request was wrong. Try again.";
    default:
      return "That did not work. Try again in a minute.";
  }
}
