// Handler-level tests for /api/live-activity/register and /end. Called
// directly with a Request (no server, no network) — getStore() picks the
// in-memory backend because vitest sets VITEST, mirroring app/api/plusRoutes.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { POST as registerPost } from "@/app/api/live-activity/register/route";
import { POST as endPost } from "@/app/api/live-activity/end/route";
import { getStore, hashInstallToken } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import { resetMemoryRateLimit } from "@/lib/plus/rateLimit";

const DEV = "11111111-2222-4333-8444-555555555555";
const SLUG = "boca-raton";
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
/** The device's install token for every test below (Codex review #1) —
 *  minted directly via the store so these tests don't need a real
 *  POST /api/devices round trip just to get one. */
const INSTALL_TOKEN = "install-token-for-tests";

const APP_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) IsItBeachDayApp/ios";
const WEB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15";

function post(url: string, body: unknown, opts: { ua?: string; installToken?: string | null } = {}): Request {
  const { ua = APP_UA, installToken = INSTALL_TOKEN } = opts;
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": ua,
      ...(installToken ? { "x-install-token": installToken } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  resetMemoryStore();
  resetMemoryRateLimit();
});

/** Entitle the device, arm it at SLUG, and mint its install token — so it
 *  passes register's/end's gates, including the token requirement. */
async function armDevice(deviceId: string, armedUntil: number): Promise<void> {
  const store = await getStore();
  await store.upsertDevice(deviceId, { codeUntil: armedUntil + 3600_000 });
  await store.setPresence(deviceId, { slug: SLUG, armedUntil, source: "manual" });
  await store.setInstallTokenHash(deviceId, hashInstallToken(INSTALL_TOKEN), Date.now());
}

function registerBody(over: Partial<Record<string, unknown>> = {}) {
  return {
    deviceId: DEV,
    activityId: "activity-0000000000000001",
    slug: SLUG,
    pushToken: TOKEN_A,
    schemaVersion: 1,
    appBuild: "42",
    apnsEnvironment: "sandbox",
    ...over,
  };
}

describe("POST /api/live-activity/register", () => {
  it("403s a non-native request", async () => {
    const res = await registerPost(post("https://x/api/live-activity/register", registerBody(), { ua: WEB_UA }));
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("app-only");
  });

  it("403s when the device is not entitled or not armed at that slug", async () => {
    // Not entitled at all.
    const res1 = await registerPost(post("https://x/api/live-activity/register", registerBody()));
    expect(res1.status).toBe(403);
    expect((await json(res1)).error).toBe("not-armed");

    // Entitled but armed at a DIFFERENT beach.
    const store = await getStore();
    const armedUntil = Date.now() + 3600_000;
    await store.upsertDevice(DEV, { codeUntil: armedUntil + 3600_000 });
    await store.setPresence(DEV, { slug: "deerfield-beach", armedUntil, source: "manual" });
    const res2 = await registerPost(post("https://x/api/live-activity/register", registerBody()));
    expect(res2.status).toBe(403);
    expect((await json(res2)).error).toBe("not-armed");
  });

  it("400s a malformed body (bad activityId / push token / slug)", async () => {
    await armDevice(DEV, Date.now() + 3600_000);
    const badActivity = await registerPost(
      post("https://x/api/live-activity/register", registerBody({ activityId: "x" })),
    );
    expect(badActivity.status).toBe(400);
    const badToken = await registerPost(
      post("https://x/api/live-activity/register", registerBody({ pushToken: "not-hex!" })),
    );
    expect(badToken.status).toBe(400);
    const badSlug = await registerPost(
      post("https://x/api/live-activity/register", registerBody({ slug: "not-a-real-beach" })),
    );
    expect(badSlug.status).toBe(400);
  });

  it("200s and registers an armed, entitled device — never echoes the token", async () => {
    const armedUntil = Date.now() + 3600_000;
    await armDevice(DEV, armedUntil);
    const res = await registerPost(post("https://x/api/live-activity/register", registerBody()));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.activityId).toBe("activity-0000000000000001");
    expect(JSON.stringify(body)).not.toContain(TOKEN_A);

    const store = await getStore();
    const rows = await store.listLiveActivitiesForDevice(DEV);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
    expect(rows[0].pushToken).toBe(TOKEN_A);
    // expiresAt is clamped to the presence window (well under start+8h here).
    expect(rows[0].expiresAt).toBe(armedUntil);
  });

  it("a second register call for the SAME activityId rotates the token atomically", async () => {
    await armDevice(DEV, Date.now() + 3600_000);
    await registerPost(post("https://x/api/live-activity/register", registerBody({ pushToken: TOKEN_A })));
    const res = await registerPost(
      post("https://x/api/live-activity/register", registerBody({ pushToken: TOKEN_B })),
    );
    expect(res.status).toBe(200);
    const store = await getStore();
    const rows = await store.listLiveActivitiesForDevice(DEV);
    expect(rows).toHaveLength(1); // rotation, not a second row
    expect(rows[0].pushToken).toBe(TOKEN_B);
  });

  // --- Install token identity (Codex review #1) -----------------------------
  it("401 token-required when the device has never been issued an install token", async () => {
    const store = await getStore();
    const armedUntil = Date.now() + 3600_000;
    await store.upsertDevice(DEV, { codeUntil: armedUntil + 3600_000 });
    await store.setPresence(DEV, { slug: SLUG, armedUntil, source: "manual" });
    // No setInstallTokenHash call — this device has no hash on file.
    const res = await registerPost(post("https://x/api/live-activity/register", registerBody()));
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("token-required");
  });

  it("401 no-token when the device has a hash but the header is missing or wrong", async () => {
    await armDevice(DEV, Date.now() + 3600_000);
    const missing = await registerPost(
      post("https://x/api/live-activity/register", registerBody(), { installToken: null }),
    );
    expect(missing.status).toBe(401);
    expect((await json(missing)).error).toBe("no-token");

    const wrong = await registerPost(
      post("https://x/api/live-activity/register", registerBody(), { installToken: "totally-wrong" }),
    );
    expect(wrong.status).toBe(401);
    expect((await json(wrong)).error).toBe("no-token");
  });

  // --- Rotation + ownership (Codex review #4) --------------------------------
  it("device-mismatch when a different device claims an existing activityId", async () => {
    await armDevice(DEV, Date.now() + 3600_000);
    await registerPost(post("https://x/api/live-activity/register", registerBody()));

    const OTHER = "99999999-2222-4333-8444-555555555555";
    await armDevice(OTHER, Date.now() + 3600_000);
    const res = await registerPost(
      post("https://x/api/live-activity/register", registerBody({ deviceId: OTHER })),
    );
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("device-mismatch");
    // The original device's row is untouched.
    const store = await getStore();
    const rows = await store.listLiveActivitiesForDevice(DEV);
    expect(rows[0].status).toBe("active");
    expect(rows[0].deviceId).toBe(DEV);
  });

  it("a rotation counter that doesn't exceed what's on file is rejected as stale-rotation", async () => {
    await armDevice(DEV, Date.now() + 3600_000);
    await registerPost(post("https://x/api/live-activity/register", registerBody({ rotation: 5 })));
    const res = await registerPost(
      post("https://x/api/live-activity/register", registerBody({ rotation: 5, pushToken: TOKEN_B })),
    );
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("stale-rotation");
    const store = await getStore();
    const rows = await store.listLiveActivitiesForDevice(DEV);
    // The stale attempt never replaced the token.
    expect(rows[0].pushToken).toBe(TOKEN_A);
  });

  it("a higher rotation counter replaces the token", async () => {
    await armDevice(DEV, Date.now() + 3600_000);
    await registerPost(post("https://x/api/live-activity/register", registerBody({ rotation: 1 })));
    const res = await registerPost(
      post("https://x/api/live-activity/register", registerBody({ rotation: 2, pushToken: TOKEN_B })),
    );
    expect(res.status).toBe(200);
    const store = await getStore();
    const rows = await store.listLiveActivitiesForDevice(DEV);
    expect(rows[0].pushToken).toBe(TOKEN_B);
    expect(rows[0].tokenRotation).toBe(2);
  });

  it("no rotation sent at all (legacy caller) always rotates, same as before this counter existed", async () => {
    await armDevice(DEV, Date.now() + 3600_000);
    await registerPost(post("https://x/api/live-activity/register", registerBody()));
    const res = await registerPost(
      post("https://x/api/live-activity/register", registerBody({ pushToken: TOKEN_B })),
    );
    expect(res.status).toBe(200);
  });

  it("enforces one active session per device — a NEW activityId ends the old one", async () => {
    await armDevice(DEV, Date.now() + 3600_000);
    await registerPost(
      post("https://x/api/live-activity/register", registerBody({ activityId: "activity-0000000000000001" })),
    );
    await registerPost(
      post(
        "https://x/api/live-activity/register",
        registerBody({ activityId: "activity-0000000000000002", pushToken: TOKEN_B }),
      ),
    );
    const store = await getStore();
    const rows = await store.listLiveActivitiesForDevice(DEV);
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.activityId === "activity-0000000000000001");
    const second = rows.find((r) => r.activityId === "activity-0000000000000002");
    expect(first?.status).toBe("ended");
    expect(second?.status).toBe("active");
  });
});

describe("POST /api/live-activity/end", () => {
  it("403s a non-native request", async () => {
    const res = await endPost(
      post("https://x/api/live-activity/end", { deviceId: DEV, activityId: "a" }, { ua: WEB_UA }),
    );
    expect(res.status).toBe(403);
  });

  it("404s an activity that doesn't belong to (or doesn't exist for) this device", async () => {
    const res = await endPost(
      post("https://x/api/live-activity/end", { deviceId: DEV, activityId: "activity-0000000000000099" }),
    );
    expect(res.status).toBe(404);
  });

  it("ends the caller's own activity", async () => {
    await armDevice(DEV, Date.now() + 3600_000);
    await registerPost(post("https://x/api/live-activity/register", registerBody()));
    const res = await endPost(
      post("https://x/api/live-activity/end", { deviceId: DEV, activityId: "activity-0000000000000001" }),
    );
    expect(res.status).toBe(200);
    const store = await getStore();
    const rows = await store.listLiveActivitiesForDevice(DEV);
    expect(rows[0].status).toBe("ended");
    // No 72h bearer-token retention (Codex review #10) — cleared immediately.
    expect(rows[0].pushToken).toBe("");
  });

  it("401 no-token when the header is missing, even for the caller's own activity", async () => {
    await armDevice(DEV, Date.now() + 3600_000);
    await registerPost(post("https://x/api/live-activity/register", registerBody()));
    const res = await endPost(
      post(
        "https://x/api/live-activity/end",
        { deviceId: DEV, activityId: "activity-0000000000000001" },
        { installToken: null },
      ),
    );
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("no-token");
  });
});
