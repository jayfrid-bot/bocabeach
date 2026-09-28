// Handler-level tests for POST /api/history/[slug] — memory store, no
// network, no D1. Mirrors app/api/devices/route.test.ts (memory store) and
// app/api/hazards/route.test.ts's gate style (native UA, rate limit, install
// token, minted directly via the store rather than round-tripping through
// POST /api/devices).

import { describe, it, expect, beforeEach } from "vitest";
import { resetMemoryRateLimit } from "@/lib/plus/rateLimit";
import { getStore, hashInstallToken } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import { hourUtcOf } from "@/lib/history/archive";
import type { BeachHourlyRow } from "@/lib/history/types";

const APP_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) IsItBeachDayApp/ios";
const WEB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15";
const DEV = "11111111-2222-4333-8444-555555555555";
const INSTALL_TOKEN = "install-token-for-history-tests";
const SLUG = "boca-raton";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function post(
  slug: string,
  body: Record<string, unknown>,
  opts: { ua?: string; ip?: string; installToken?: string | null } = {},
): Request {
  const { ua = APP_UA, ip = "1.2.3.4", installToken = INSTALL_TOKEN } = opts;
  return new Request(`https://x/api/history/${slug}`, {
    method: "POST",
    headers: {
      "User-Agent": ua,
      "cf-connecting-ip": ip,
      "content-type": "application/json",
      ...(installToken ? { "x-install-token": installToken } : {}),
    },
    body: JSON.stringify(body),
  });
}

function params(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function row(over: Partial<BeachHourlyRow> = {}): BeachHourlyRow {
  return {
    slug: SLUG,
    hour_utc: hourUtcOf(Date.now()),
    snapshot_generated_at: new Date().toISOString(),
    archived_at: new Date().toISOString(),
    local_date: "2026-09-22",
    local_hour: 10,
    utc_offset_minutes: -240,
    timezone: "America/New_York",
    score: 80,
    raw_score: 80,
    rating: "Good",
    available_weight: 1,
    observed_weight: 0.2,
    coverage_tier: "full",
    air_temp_f: 85,
    water_temp_f: 84,
    sand_temp_f: 95,
    wave_ft: 2,
    surf_ft: null,
    wave_source: "model",
    wind_mph: 8,
    gust_mph: 12,
    uv: 6,
    cloud_pct: 10,
    rain_now: 0,
    lightning_near: 0,
    tide_state: "rising",
    crowd_pct: null,
    seaweed_pct: 5,
    seaweed_level: "low",
    clarity_pct: null,
    engine_version: "test-1",
    scoring_config_version: "test-1",
    build_sha: "abc123",
    row_kind: "snapshot",
    archive_reason: "cron",
    caps_json: "[]",
    factors_json: "[]",
    missing_json: "[]",
    extra_json: null,
    ...over,
  };
}

beforeEach(async () => {
  resetMemoryRateLimit();
  resetMemoryStore();
  const store = await getStore();
  await store.upsertDevice(DEV, {}); // the row setInstallTokenHash requires to already exist
  await store.setInstallTokenHash(DEV, hashInstallToken(INSTALL_TOKEN), Date.now());
});

describe("POST /api/history/[slug]", () => {
  it("403s a non-native request", async () => {
    const { POST } = await import("@/app/api/history/[slug]/route");
    const res = await POST(post(SLUG, { deviceId: DEV }, { ua: WEB_UA }), params(SLUG));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("app-only");
  });

  it("400s an unknown beach slug", async () => {
    const { POST } = await import("@/app/api/history/[slug]/route");
    const res = await POST(post("nowhere-beach", { deviceId: DEV }), params("nowhere-beach"));
    expect(res.status).toBe(400);
  });

  it("400s a missing/malformed deviceId", async () => {
    const { POST } = await import("@/app/api/history/[slug]/route");
    const res = await POST(post(SLUG, { deviceId: "short" }), params(SLUG));
    expect(res.status).toBe(400);
  });

  it("400s an out-of-range 'days' value", async () => {
    const { POST } = await import("@/app/api/history/[slug]/route");
    const res = await POST(post(SLUG, { deviceId: DEV, days: 5 }), params(SLUG));
    expect(res.status).toBe(400);
  });

  it("defaults 'days' to 7 when omitted", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { codeUntil: Date.now() + 30 * DAY });
    const { POST } = await import("@/app/api/history/[slug]/route");
    const res = await POST(post(SLUG, { deviceId: DEV }), params(SLUG));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("401 token-required for a device with no install token on file", async () => {
    const { POST } = await import("@/app/api/history/[slug]/route");
    const NEW_DEV = "22222222-2222-4333-8444-555555555555";
    const res = await POST(post(SLUG, { deviceId: NEW_DEV }), params(SLUG));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("token-required");
  });

  it("401 no-token when the header is missing or wrong for a device that has a token", async () => {
    const { POST } = await import("@/app/api/history/[slug]/route");
    const missing = await POST(post(SLUG, { deviceId: DEV }, { installToken: null }), params(SLUG));
    expect(missing.status).toBe(401);
    expect((await missing.json()).error).toBe("no-token");
    const wrong = await POST(post(SLUG, { deviceId: DEV }, { installToken: "nope" }), params(SLUG));
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error).toBe("no-token");
  });

  it("403 not-entitled for a free device", async () => {
    const { POST } = await import("@/app/api/history/[slug]/route");
    const res = await POST(post(SLUG, { deviceId: DEV }), params(SLUG));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not-entitled");
  });

  it("429 too-many-attempts once the per-device rate limit is exceeded", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { codeUntil: Date.now() + 30 * DAY });
    const { POST } = await import("@/app/api/history/[slug]/route");
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) {
      last = await POST(post(SLUG, { deviceId: DEV }, { ip: `9.9.9.${i % 250}` }), params(SLUG));
    }
    expect(last?.status).toBe(429);
    expect((await last!.json()).error).toBe("too-many-attempts");
    expect(last?.headers.get("Retry-After")).toBeTruthy();
  });

  describe("an entitled (Plus) device", () => {
    beforeEach(async () => {
      const store = await getStore();
      await store.upsertDevice(DEV, { codeUntil: Date.now() + 30 * DAY });
    });

    it("returns days: [] with no rows for this beach — no error, an honest empty state", async () => {
      const { POST } = await import("@/app/api/history/[slug]/route");
      const res = await POST(post(SLUG, { deviceId: DEV, days: 7 }), params(SLUG));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.days).toEqual([]);
      expect(body.records).toEqual({
        bestDay: null,
        hottestSand: null,
        biggestSurf: null,
        quietestDay: null,
      });
      expect(body.archiveStartedAt).toBeNull();
      expect(body.dayCount).toBe(0);
      expect(body.surfSince).toBeNull();
      expect(typeof body.since).toBe("string");
    });

    it("returns day summaries built from real beach_hourly rows, within the requested window", async () => {
      const store = await getStore();
      await store.upsertBeachHourly(
        row({ hour_utc: hourUtcOf(Date.now() - DAY), local_date: "2026-09-21", local_hour: 10, score: 72 }),
      );
      await store.upsertBeachHourly(
        row({ hour_utc: hourUtcOf(Date.now()), local_date: "2026-09-22", local_hour: 14, score: 88, sand_temp_f: 137, surf_ft: 3.2 }),
      );
      const { POST } = await import("@/app/api/history/[slug]/route");
      const res = await POST(post(SLUG, { deviceId: DEV, days: 14 }), params(SLUG));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.days.map((d: { date: string }) => d.date)).toEqual(["2026-09-21", "2026-09-22"]);
      expect(body.records.bestDay).toEqual({ date: "2026-09-22", score: 88, localHour: 14 });
      expect(body.records.biggestSurf).toEqual({ date: "2026-09-22", surfFt: 3.2, localHour: 14 });
      expect(body.archiveStartedAt).toBe("2026-09-21");
      expect(body.dayCount).toBe(2);
      // The first row (2026-09-21) has no surf_ft — coverage only starts
      // the next day, so surfSince is later than archiveStartedAt.
      expect(body.surfSince).toBe("2026-09-22");
    });

    it("records are LIFETIME — a record-setting row outside the requested window still shows up", async () => {
      const store = await getStore();
      // 40 days before "today" — outside even a 30-day window.
      await store.upsertBeachHourly(
        row({ hour_utc: hourUtcOf(Date.now() - 40 * DAY), local_date: "2026-08-19", local_hour: 10, score: 99 }),
      );
      // Inside the 7-day window, but a lower score.
      await store.upsertBeachHourly(
        row({ hour_utc: hourUtcOf(Date.now()), local_date: "2026-09-28", local_hour: 10, score: 70 }),
      );
      const { POST } = await import("@/app/api/history/[slug]/route");
      const res = await POST(post(SLUG, { deviceId: DEV, days: 7 }), params(SLUG));
      const body = await res.json();
      // The 7-day window itself never even reaches back to Aug 19...
      expect(body.days.some((d: { date: string }) => d.date === "2026-08-19")).toBe(false);
      // ...but the lifetime record still names it.
      expect(body.records.bestDay).toMatchObject({ date: "2026-08-19", score: 99 });
      expect(body.archiveStartedAt).toBe("2026-08-19");
    });

    it("only rows for THIS beach are returned — a different slug's rows never leak in", async () => {
      const store = await getStore();
      await store.upsertBeachHourly(
        row({ slug: "deerfield-beach", hour_utc: hourUtcOf(Date.now()), local_date: "2026-09-22", score: 99 }),
      );
      const { POST } = await import("@/app/api/history/[slug]/route");
      const res = await POST(post(SLUG, { deviceId: DEV }), params(SLUG));
      const body = await res.json();
      expect(body.days).toEqual([]);
      expect(body.records.bestDay).toBeNull();
    });

    it("sets Cache-Control: private, no-store", async () => {
      const { POST } = await import("@/app/api/history/[slug]/route");
      const res = await POST(post(SLUG, { deviceId: DEV }), params(SLUG));
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    });
  });
});
