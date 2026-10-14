// Browser-side helpers for the owner screens (/admin/review, /admin/report).
//
// The owner's phone holds ONE credential: the owner token, handed out once by
// POST /api/quality/owner/enroll when the phone enrolled with OWNER_ENROLL_CODE (see
// lib/quality/owner.ts). Every owner call sends it as `Authorization: Bearer <token>`. It lives in
// this phone's local storage; the server keeps only its SHA-256.

export const OWNER_TOKEN_KEY = "bd:owner-token";
/** Set once an owner call succeeds, so the beach page can show its quiet "Report conditions" link without a request. Display hint only. */
export const OWNER_HINT_KEY = "bd:owner-hint";

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readOwnerToken(): string | null {
  try {
    return store()?.getItem(OWNER_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function writeOwnerToken(token: string | null): void {
  try {
    const s = store();
    if (!s) return;
    if (token) s.setItem(OWNER_TOKEN_KEY, token);
    else s.removeItem(OWNER_TOKEN_KEY);
  } catch {
    /* private mode: the owner screens just ask to enroll again */
  }
}

export function readOwnerHint(): boolean {
  try {
    return store()?.getItem(OWNER_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeOwnerHint(on: boolean): void {
  try {
    const s = store();
    if (!s) return;
    if (on) s.setItem(OWNER_HINT_KEY, "1");
    else s.removeItem(OWNER_HINT_KEY);
  } catch {
    /* private mode: the link just stays hidden */
  }
}

/** The request init for an owner call. Pure. */
export function ownerRequestInit(token: string | null, body: Record<string, unknown>): RequestInit {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return { method: "POST", headers, body: JSON.stringify(body), cache: "no-store" };
}

export type OwnerCallResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

async function post<T>(path: string, token: string | null, body: Record<string, unknown>): Promise<OwnerCallResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, ownerRequestInit(token, body));
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

/** POST to an owner route with this phone's owner token. Never throws: a network failure is `{ ok: false, error: "network" }`. */
export async function ownerPost<T>(path: string, body: Record<string, unknown> = {}): Promise<OwnerCallResult<T>> {
  const token = readOwnerToken();
  if (!token) return { ok: false, error: "unauthorized", status: 401 };
  return post<T>(path, token, body);
}

/** Enroll this phone: trade the one-time code for an owner token and keep it. The code is sent in the request body only. */
export async function enrollThisPhone(code: string, deviceId: string): Promise<OwnerCallResult<{ ok: true; token: string }>> {
  const r = await post<{ ok: true; token: string }>("/api/quality/owner/enroll", null, { code, deviceId });
  if (r.ok && typeof r.data.token === "string") writeOwnerToken(r.data.token);
  return r;
}

/**
 * Read an enrollment code from the page address and REMOVE it from the address bar. The code travels
 * ONLY in the fragment (`#enroll=<code>`): browsers never send a fragment to a server, so it cannot
 * land in a log. A `?enroll=` query is NOT read (it would already have reached the server) and is
 * left alone. `loc` and `history` are injectable for tests. Returns null when there is none.
 */
export function takeEnrollCode(
  loc: Pick<Location, "hash" | "search" | "pathname"> = window.location,
  hist: Pick<History, "replaceState"> = window.history,
): string | null {
  const h = new URLSearchParams(loc.hash.replace(/^#/, ""));
  const code = h.get("enroll");
  if (!code) return null;
  h.delete("enroll");
  const hs = h.toString();
  hist.replaceState(null, "", `${loc.pathname}${loc.search}${hs ? `#${hs}` : ""}`);
  return code;
}

/** Tell the server which phone to push to. Quietly does nothing off iOS or without a token. */
export async function syncOwnerPushToken(getToken: () => Promise<string | null>): Promise<boolean> {
  const token = await getToken();
  if (!token) return false;
  const r = await ownerPost<{ ok: true }>("/api/quality/owner/push-token", { token, platform: "ios" });
  return r.ok;
}

/** Plain words for a refusal, shown instead of an error code. Pure. */
export function ownerErrorText(error: string): string {
  switch (error) {
    case "unauthorized":
      return "This phone is not enrolled as the owner. Open the enrollment link once.";
    case "enrollment-closed":
      return "Enrollment is not open on the server.";
    case "bad-code":
      return "That enrollment code did not work.";
    case "too-many-attempts":
      return "Too many tries. Wait a while and try again.";
    case "network":
      return "No connection. Try again.";
    default:
      return "Something went wrong. Try again.";
  }
}

/**
 * The one line a phone that is NOT enrolled may be told after it tried a code. It says nothing about what the
 * owner screens are: a throttle and a lost connection are plain, and every other refusal is one sentence. Pure.
 */
export function enrollGateText(error: string): string {
  if (error === "too-many-attempts") return "Too many tries. Wait a while and try again.";
  if (error === "network") return "No connection. Try again.";
  return "That did not work.";
}

/**
 * How long until the public beach card shows an owner's answer. The server builds a fresh snapshot
 * on the next request after a tap (the conditions cache key includes the verdicts). What can still
 * hold the old card is the page's own refresh (every 5 minutes) and, if a network cache keeps
 * the public conditions answer, its `s-maxage=300, stale-while-revalidate=600`.
 */
export const CARD_REFRESH_MINUTES = 5;
export const CARD_REFRESH_WORST_CASE_MINUTES = 15;
export const CARD_UPDATE_NOTE = `The beach card updates on its next refresh, within ${CARD_REFRESH_MINUTES} minutes. A copy held by the network can take up to ${CARD_REFRESH_WORST_CASE_MINUTES}.`;
