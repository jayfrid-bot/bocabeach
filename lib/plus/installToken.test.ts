// The phone's side of the install token: make it, save it BEFORE sending, claim
// it idempotently, never delete it on a 401, and make every write wait for the
// claim (lib/plus/installToken.ts, lib/plus/api.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const DEV = "11111111-2222-4333-8444-555555555555";
vi.mock("@/lib/deviceId", () => ({ getDeviceId: () => DEV }));
vi.mock("@/lib/push/native", () => ({
  isNativePlatform: () => true,
  nativePlatform: () => "ios",
}));

const {
  claimInstallToken,
  claimBeforeWrite,
  generateInstallToken,
  localInstallToken,
  resetClaimState,
} = await import("@/lib/plus/installToken");
const { plusApi } = await import("@/lib/plus/api");
const store = await import("@/lib/plus/storage");

interface Call {
  url: string;
  method: string;
  token: string | null;
  body: Record<string, unknown>;
}
let calls: Call[];
let replies: (Response | Error | Promise<Response>)[];
let map: Map<string, string>;
let storageBroken: boolean;

const reply = (status: number, body: unknown = { ok: status < 300, device: { id: DEV } }) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = [];
  replies = [];
  map = new Map();
  storageBroken = false;
  resetClaimState();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    // A broken store accepts the write and keeps nothing (private mode / quota).
    setItem: (k: string, v: string) => void (storageBroken ? undefined : map.set(k, v)),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({
      url,
      method: init.method ?? "GET",
      token: headers.get("x-install-token"),
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    const next = replies.shift() ?? reply(200);
    if (next instanceof Error) throw next;
    return next;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("making the token", () => {
  it("is 32 random bytes, base64url, different every time", () => {
    const a = generateInstallToken()!;
    const b = generateInstallToken()!;
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("is saved before anything uses it, and the same one comes back next time", () => {
    const t = localInstallToken()!;
    expect(store.readInstallToken()).toBe(t);
    expect(localInstallToken()).toBe(t);
  });

  it("if storage will not keep it, there is no token and no claim is sent", async () => {
    storageBroken = true;
    expect(localInstallToken()).toBeNull();
    const out = await claimInstallToken();
    expect(out.token).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("claiming it", () => {
  it("sends the saved token with the push token as proof, and remembers the server confirmed", async () => {
    map.set("native-push:boca-raton", "p".repeat(64));
    const out = await claimInstallToken();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/devices");
    expect(calls[0].token).toBe(store.readInstallToken());
    expect(calls[0].body.deviceId).toBe(DEV);
    expect(calls[0].body.pushProof).toBe("p".repeat(64));
    expect(out.token).toBe(store.readInstallToken());
    expect(store.readInstallClaimed()).toBe(true);
    // Confirmed once: no more round trips.
    await claimInstallToken();
    expect(calls).toHaveLength(1);
  });

  it("a lost response never strands the phone: the token was saved first, and the retry sends the same one", async () => {
    replies = [new Error("connection dropped after the server stored it")];
    const first = await claimInstallToken();
    expect(first.token).toBeNull(); // not confirmed
    const saved = store.readInstallToken();
    expect(saved).toBeTruthy();
    expect(store.readInstallClaimed()).toBe(false);

    const second = await claimInstallToken();
    expect(calls).toHaveLength(2);
    expect(calls[1].token).toBe(saved);
    expect(second.token).toBe(saved);
  });

  it("a server error is retried next time, not treated as a refusal", async () => {
    replies = [reply(500, { ok: false })];
    expect((await claimInstallToken()).token).toBeNull();
    expect((await claimInstallToken()).token).toBeTruthy();
    expect(calls).toHaveLength(2);
  });

  it("a 401 does NOT delete the saved token, stops asking this session, and force asks exactly once more", async () => {
    replies = [reply(401, { ok: false, error: "no-token" }), reply(401, { ok: false, error: "no-token" })];
    const saved = localInstallToken();
    expect((await claimInstallToken()).token).toBeNull();
    expect(store.readInstallToken()).toBe(saved);
    await claimInstallToken();
    expect(calls).toHaveLength(1); // latched

    await claimInstallToken({ forceRefresh: true });
    expect(calls).toHaveLength(2);
    expect(store.readInstallToken()).toBe(saved);
    await claimInstallToken({ forceRefresh: true });
    expect(calls).toHaveLength(2); // one forced retry per session
  });

  it("overlapping callers share one request (single flight)", async () => {
    let release: (r: Response) => void = () => {};
    replies = [new Promise<Response>((r) => (release = r))];
    const a = claimInstallToken();
    const b = claimInstallToken();
    const c = claimBeforeWrite();
    release(reply(200));
    await Promise.all([a, b, c]);
    expect(calls).toHaveLength(1);
  });
});

describe("every write waits for the claim", () => {
  it("a presence write is not sent until the claim has finished, and carries the same token", async () => {
    let release: (r: Response) => void = () => {};
    replies = [new Promise<Response>((r) => (release = r)), reply(200)];
    void claimInstallToken(); // the start-up claim, still in flight
    const write = plusApi.arm(DEV, { slug: "boca-raton", armedUntil: Date.now() + 1000, source: "manual" });
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.map((c) => c.url)).toEqual(["/api/devices"]); // the write is waiting
    release(reply(200));
    await write;
    expect(calls.map((c) => c.url)).toEqual(["/api/devices", "/api/presence"]);
    expect(calls[1].token).toBe(calls[0].token);
  });

  it("a read does not wait", async () => {
    replies = [reply(200)];
    await plusApi.getDevice(DEV);
    expect(calls.map((c) => c.url)).toEqual([`/api/devices?deviceId=${DEV}`]);
  });

  it("a refused claim does not hold the write back; the write gets its own answer", async () => {
    replies = [reply(401, { ok: false, error: "no-token" }), reply(401, { ok: false, error: "no-token" })];
    const res = await plusApi.arm(DEV, { slug: "boca-raton", armedUntil: Date.now() + 1000, source: "manual" });
    expect(res.status).toBe(401);
    expect(res.error).toBe("no-token");
  });
});
