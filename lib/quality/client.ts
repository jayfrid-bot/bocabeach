// Browser-side helpers for the owner screens (/admin/review, /admin/report).
// Every call is a POST with this device's id in the body and its install token
// in `x-install-token`; the server decides whether the device is the owner
// (lib/quality/owner.ts). Nothing here is a secret or a gate.

import { getDeviceId } from "@/lib/deviceId";
import { readInstallToken } from "@/lib/plus/storage";

/** Set on this device after the owner check passes once, so the beach page can show its quiet "Report conditions" link without asking the server on every visit. Display hint only. */
export const OWNER_HINT_KEY = "bd:owner-hint";

export function readOwnerHint(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(OWNER_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeOwnerHint(on: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (on) localStorage.setItem(OWNER_HINT_KEY, "1");
    else localStorage.removeItem(OWNER_HINT_KEY);
  } catch {
    /* private mode: the link just stays hidden */
  }
}

/** The request init for an owner call. Pure. */
export function ownerRequestInit(deviceId: string, token: string | null, body: Record<string, unknown>): RequestInit {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-install-token"] = token;
  return { method: "POST", headers, body: JSON.stringify({ ...body, deviceId }), cache: "no-store" };
}

export type OwnerCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number };

/** POST to an owner route. Never throws: a network failure is `{ ok: false, error: "network" }`. */
export async function ownerPost<T>(path: string, body: Record<string, unknown> = {}): Promise<OwnerCallResult<T>> {
  const deviceId = getDeviceId();
  if (!deviceId) return { ok: false, error: "no-device", status: 0 };
  let res: Response;
  try {
    res = await fetch(path, ownerRequestInit(deviceId, readInstallToken(), body));
  } catch {
    return { ok: false, error: "network", status: 0 };
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const obj = (data ?? {}) as { ok?: unknown; error?: unknown };
  if (res.ok && obj.ok === true) return { ok: true, data: data as T };
  return { ok: false, error: typeof obj.error === "string" ? obj.error : "server", status: res.status };
}

/** Plain words for a refusal, shown instead of an error code. Pure. */
export function ownerErrorText(error: string): string {
  switch (error) {
    case "not-owner":
      return "This phone is not on the owner list.";
    case "owner-not-configured":
      return "The owner list is not set up on the server yet.";
    case "token-required":
    case "no-token":
      return "This phone has no install token. Open the app's home screen once, then come back.";
    case "network":
      return "No connection. Try again.";
    case "no-device":
      return "This browser cannot keep a device id.";
    case "already-answered":
      return "This one was already answered.";
    default:
      return "Something went wrong. Try again.";
  }
}
