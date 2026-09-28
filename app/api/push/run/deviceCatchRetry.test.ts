// Route-level regression test for Codex review round-5 item 2 — "the
// per-device catch": when a device's own evaluation THROWS (an honest
// exception from the send function itself, not a controlled `{ ok: false }`
// return), the outer per-device try/catch (app/api/push/run/route.ts, the
// one that used to only increment `errors`) must also add this slug to
// `retryableDueSlugs` when it was selected as due, so `dueRemaining`
// reflects it and the cron makes another pass instead of silently treating
// a crashed device as settled.
//
// Deliberately built around the MORNING digest rather than sun-color: a
// thrown exception happens INSIDE the send-claim's own critical section (the
// code takes the claim, then calls `sendOne`, with no try/catch around that
// specific call anywhere in between) — so the claim is left ORPHANED, not
// released, exactly like a real crash mid-send. A same-INSTANT retry can
// never reclaim an orphaned claim (`claimSend`'s own abandonment check needs
// real elapsed time), so this test advances the clock past
// `ABANDONED_CLAIM_MS` (10 min) before pass 2 — still safely inside the same
// beach-local MORNING_HOUR, which (unlike sun-color's own exact 10-minute
// send window) stays "due" for the whole hour, so the retry has somewhere to
// land.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ConditionsResponse } from "@/lib/types";

const ctl = vi.hoisted(() => ({
  // The FIRST send this test makes throws outright; every send after that
  // succeeds — a one-off exception (a malformed upstream response, say)
  // that clears up by the very next attempt.
  throwNextSend: true,
  fcmSends: 0,
}));

vi.mock("@/lib/push/nativeStore", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/push/nativeStore")>();
  return { ...actual, listNativeSubs: async () => [], removeNativeSub: async () => {} };
});

vi.mock("@/lib/push/apns", () => ({
  getApns: () => null,
  openApnsSession: () => ({ send: async () => ({ ok: true }), close: () => {} }),
  isDeadToken: () => false,
}));

vi.mock("@/lib/push/fcm", () => ({
  getFcm: () => ({ projectId: "test-project" }),
  getFcmAccessToken: async () => "access-token",
  isDeadFcmToken: () => false,
  sendFcm: async () => {
    ctl.fcmSends += 1;
    if (ctl.throwNextSend) {
      ctl.throwNextSend = false;
      throw new Error("send exploded");
    }
    return { ok: true };
  },
}));

// A minimal, always-mockable conditions build — same shape
// app/api/push/run/coverage.test.ts already proves works for the morning
// digest path (score below Excellent, no sun/hourly fields needed).
vi.mock("@/lib/conditions", () => ({
  getConditions: async (): Promise<ConditionsResponse> =>
    ({
      score: { score: 55, rawScore: 55, rating: "Fair", caps: [], subScores: [] },
      snapshot: {
        lightning: { status: "ok", data: null },
        nws: { status: "ok", data: { alerts: [] } },
        cityOfficial: { status: "ok", data: null },
        waterQuality: { status: "ok", data: null },
      },
      hourlyForecast: [],
      hourlyScores: [],
    }) as unknown as ConditionsResponse,
}));

const { POST: registerPost } = await import("@/app/api/push/register-native/route");
const { POST: runPost } = await import("@/app/api/push/run/route");
const { getStore } = await import("@/lib/db/store");
const { resetMemoryStore } = await import("@/lib/db/memoryStore");
const { ABANDONED_CLAIM_MS } = await import("@/lib/db/sendClaims");

const DEV = "88888888-9999-aaaa-bbbb-cccccccccccc";
const FCM_TOKEN = "c".repeat(80);

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function run(): Promise<Response> {
  return runPost(
    new Request("https://x/api/push/run?mode=morning", {
      method: "POST",
      headers: { "x-cron-secret": "test-cron-secret" },
    }),
  );
}

async function seedDevice(): Promise<void> {
  await registerPost(
    post("https://x/api/push/register-native", {
      slug: "boca-raton",
      token: FCM_TOKEN,
      platform: "android",
      deviceId: DEV,
      prefs: { morning: false, safety: false },
    }),
  );
  const store = await getStore();
  await store.upsertDevice(DEV, {
    codeUntil: Date.now() + 30 * 24 * 3600 * 1000, // Plus
    // Only the morning digest drives selection here — sun-color/coming-up
    // off so the send function's only chance to run is the digest's own.
    prefs: { morning: true, "score-excellent": false, "coming-up": false, "sun-color": false },
  });
}

describe("POST /api/push/run — dueRemaining counts a per-device exception (round-5 item 2)", () => {
  const EIGHT_AM_ET = "2026-09-02T12:05:00Z"; // 08:05 America/New_York (boca-raton's own tz)

  beforeEach(() => {
    resetMemoryStore();
    ctl.throwNextSend = true;
    ctl.fcmSends = 0;
    process.env.CRON_SECRET = "test-cron-secret";
    delete process.env.PUSH_SAFETY_ALERTS;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(EIGHT_AM_ET));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("1-beach pool: the send function throws for the one device on pass 1 (dueRemaining 1); pass 2 sends (dueRemaining 0)", async () => {
    await seedDevice();

    const body1 = (await (await run()).json()) as Record<string, unknown>;
    expect(body1.morning).toBe(0); // the send threw — nothing counted as sent
    expect(body1.errors).toBe(1); // the per-device catch still counts it as an error too
    expect(body1.dueRemaining).toBe(1); // still due: the device never reached a terminal outcome
    expect(ctl.fcmSends).toBe(1); // the one attempt that threw

    // The claim `deliverMorning` took right before that throw is now
    // orphaned (never released) — a retry at this SAME instant cannot
    // reclaim it, so advance past ABANDONED_CLAIM_MS while staying inside
    // the same 8 AM hour, where the digest is still genuinely due.
    vi.setSystemTime(new Date(Date.parse(EIGHT_AM_ET) + ABANDONED_CLAIM_MS + 60_000));

    const body2 = (await (await run()).json()) as Record<string, unknown>;
    expect(body2.morning).toBe(1); // retried and this time the send succeeded
    expect(body2.dueRemaining).toBe(0);
    expect(ctl.fcmSends).toBe(2);

    // A third pass, moments later, must not send the digest again today.
    vi.setSystemTime(new Date(Date.parse(EIGHT_AM_ET) + ABANDONED_CLAIM_MS + 2 * 60_000));
    const body3 = (await (await run()).json()) as Record<string, unknown>;
    expect(body3.morning).toBe(0);
    expect(body3.dueRemaining).toBe(0);
    expect(ctl.fcmSends).toBe(2);
  });
});
