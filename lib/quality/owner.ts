// Who is the owner? A short list of device ids in the OWNER_DEVICE_IDS secret
// (comma-separated), checked with the same install token every Plus call uses.
//
// An owner request carries `deviceId` in its JSON body and `x-install-token`
// in its headers. It passes when:
//   1. OWNER_DEVICE_IDS is set (else 503: the screens stay closed),
//   2. the deviceId is on that list (else 403 "not-owner"),
//   3. the install token matches the hash on file for that device (else 401).
// The deviceId alone is NOT enough: it is not secret (lib/db/installTokenAuth.ts
// has the threat model). The list holds no tokens; nothing about the owner is
// hard-coded in the repo.
//
// The pages under /admin/review and /admin/report are public shells with no
// data in them. Every number and picture they show arrives through the routes
// that call this gate.

import { fail, isDeviceId } from "@/lib/db/api";
import { requireInstallToken } from "@/lib/db/installTokenAuth";
import { getStore } from "@/lib/db/store";
import { checkRateLimit, clientIp } from "@/lib/plus/rateLimit";

const MAX_ATTEMPTS_IP = 240;
const WINDOW_MS = 60 * 60 * 1000;

/** The owner device ids from the OWNER_DEVICE_IDS secret; malformed entries are dropped. */
export function ownerDeviceIds(raw: string | undefined = process.env.OWNER_DEVICE_IDS): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(isDeviceId);
}

export function isOwnerDevice(deviceId: string, raw?: string): boolean {
  return ownerDeviceIds(raw).includes(deviceId);
}

/** Run the three checks. A Response is the refusal to return; otherwise the verified device id. */
export async function requireOwner(req: Request, body: Record<string, unknown> | null): Promise<Response | { deviceId: string }> {
  const ids = ownerDeviceIds();
  if (!ids.length) return fail("owner-not-configured", 503);
  if (!body || !isDeviceId(body.deviceId)) return fail("bad-request", 400);
  const deviceId = body.deviceId;

  const limited = await checkRateLimit(`quality-owner:ip:${clientIp(req) ?? "unknown"}`, MAX_ATTEMPTS_IP, WINDOW_MS);
  if (limited.limited) {
    return Response.json(
      { ok: false, error: "too-many-attempts" },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } },
    );
  }

  if (!ids.includes(deviceId)) return fail("not-owner", 403);

  try {
    const store = await getStore();
    const check = await requireInstallToken(store, deviceId, req.headers.get("x-install-token"), Date.now());
    if (check !== "ok") return fail(check, 401);
  } catch (e) {
    console.error("quality owner: token check failed", e);
    return fail("store-unavailable", 500);
  }
  return { deviceId };
}
