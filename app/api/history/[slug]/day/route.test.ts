// Handler-level tests for POST /api/history/[slug]/day. Device rows come from
// the memory store (as in ../route.test.ts); hours and camera shots come from a
// real SQLite database with every migration applied, so the actual SQL runs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMemoryRateLimit } from "@/lib/plus/rateLimit";
import { getStore, hashInstallToken } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { CLAIM_A, frameRow } from "@/lib/camFrames/testFixtures";
import { claimSlot, markReady } from "@/lib/camFrames/store";
import { verify } from "@/lib/camFrames/sign";
import { summarizeDay } from "@/lib/history/summary";
import type { BeachHourlyRow } from "@/lib/history/types";
import { SCORING_ENGINE_VERSION } from "@/lib/score";

const ctl = vi.hoisted(() => ({ db: null as unknown, disabled: new Set<string>(), statements: 0 }));
vi.mock("@/lib/db/d1Store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db/d1Store")>();
  return { ...real, getD1: async () => ctl.db };
});
vi.mock("@/lib/camFrames/manifest", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/camFrames/manifest")>();
  return { ...real, archiveCams: () => real.archiveCams().filter((c) => !ctl.disabled.has(c.camId)) };
});

import { POST } from "@/app/api/history/[slug]/day/route";

const APP_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) IsItBeachDayApp/ios";
const WEB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15";
const DEV = "11111111-2222-4333-8444-555555555555";
const INSTALL_TOKEN = "install-token-for-day-tests";
const SLUG = "boca-raton";
const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-10-11T18:00:00Z");
const SIGNING_KEY = "unit-test-signing-key-not-a-secret";

let h: CamDb;

function post(
  body: Record<string, unknown>,
  opts: { ua?: string; slug?: string; installToken?: string | null } = {},
): Request {
  const { ua = APP_UA, slug = SLUG, installToken = INSTALL_TOKEN } = opts;
  return new Request(`https://x/api/history/${slug}/day`, {
    method: "POST",
    headers: {
      "User-Agent": ua,
      "cf-connecting-ip": "1.2.3.4",
      "content-type": "application/json",
      ...(installToken ? { "x-install-token": installToken } : {}),
    },
    body: JSON.stringify(body),
  });
}

function call(body: Record<string, unknown>, opts: { ua?: string; slug?: string; installToken?: string | null } = {}) {
  return POST(post(body, opts), { params: Promise.resolve({ slug: opts.slug ?? SLUG }) });
}

/** Insert one beach_hourly row straight into SQLite. */
function hour(over: Partial<BeachHourlyRow> = {}): void {
  const r: Record<string, unknown> = {
    slug: SLUG,
    hour_utc: "2026-10-10T14:00:00.000Z",
    snapshot_generated_at: "2026-10-10T14:05:00.000Z",
    archived_at: "2026-10-10T14:06:00.000Z",
    local_date: "2026-10-10",
    local_hour: 10,
    utc_offset_minutes: -240,
    timezone: "America/New_York",
    score: 80,
    rating: "Good",
    engine_version: SCORING_ENGINE_VERSION,
    scoring_config_version: "test-1",
    row_kind: "snapshot",
    ...over,
  };
  const cols = Object.keys(r);
  h.all(
    `INSERT INTO beach_hourly (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => r[c]),
  );
}

/** A READY (or pending) camera shot. `slot` is a UTC hour; the shot is taken at :`minute` of it. */
async function shot(
  cam: string,
  slot: string,
  opts: { localHour: number; minute?: number; date?: string; ready?: boolean; attribution?: string | null; slug?: string } = {
    localHour: 10,
  },
): Promise<string> {
  const minute = opts.minute ?? 42;
  const hhmm = `${slot.slice(11, 13)}${String(minute).padStart(2, "0")}`;
  const date = opts.date ?? slot.slice(0, 10);
  const key = `${opts.slug ?? SLUG}/${cam}/${date}/${hhmm}Z-01234567-cccccccc.jpg`;
  const row = frameRow({
    slug: opts.slug ?? SLUG,
    cam_id: cam,
    slot_utc: slot,
    display_at_utc: `${slot.slice(0, 14)}${String(minute).padStart(2, "0")}:00.000Z`,
    local_date: date,
    local_hour: opts.localHour,
    local_minute: minute,
    r2_key: key,
    attribution: opts.attribution === undefined ? "Courtesy Test Cams" : opts.attribution,
  });
  await claimSlot(h.db, row);
  if (opts.ready !== false) await markReady(h.db, row.slug, cam, slot, CLAIM_A);
  return key;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.CAM_FRAME_URL_KEY = SIGNING_KEY;
  resetMemoryRateLimit();
  resetMemoryStore();
  ctl.disabled = new Set();
  ctl.statements = 0;
  const made = makeCamDb({ allMigrations: true });
  h = made as CamDb;
  if (made) {
    // Count every statement the route prepares.
    const real = made.db.prepare.bind(made.db);
    ctl.db = {
      prepare: (sql: string) => {
        ctl.statements += 1;
        return real(sql);
      },
    };
  } else {
    ctl.db = null;
  }
  const store = await getStore();
  await store.upsertDevice(DEV, {});
  await store.setInstallTokenHash(DEV, hashInstallToken(INSTALL_TOKEN), Date.now());
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CAM_FRAME_URL_KEY;
  h?.close();
});

async function makePlus(): Promise<void> {
  const store = await getStore();
  await store.upsertDevice(DEV, { codeUntil: Date.now() + 30 * DAY });
}

describe("gates", () => {
  it("403 app-only for a request from a plain browser", async () => {
    const res = await call({ deviceId: DEV, date: "2026-10-10" }, { ua: WEB_UA });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("app-only");
  });

  it("400s an unknown beach, a bad deviceId and every kind of bad date", async () => {
    await makePlus();
    expect((await call({ deviceId: DEV, date: "2026-10-10" }, { slug: "nowhere-beach" })).status).toBe(400);
    expect((await call({ deviceId: "short", date: "2026-10-10" })).status).toBe(400);
    for (const date of [undefined, null, 20261010, "", "2026-1-5", "2026-02-30", "2026-13-01", "2026-10-10T00:00", " 2026-10-10", "1999-12-31"]) {
      const res = await call({ deviceId: DEV, date });
      expect(res.status, String(date)).toBe(400);
    }
  });

  it("401 for a device whose install token is missing or wrong", async () => {
    await makePlus();
    expect((await call({ deviceId: DEV, date: "2026-10-10" }, { installToken: null })).status).toBe(401);
    expect((await call({ deviceId: DEV, date: "2026-10-10" }, { installToken: "nope" })).status).toBe(401);
  });

  it("403 not-entitled for a free device, and no signed link ever leaves", async () => {
    const res = await call({ deviceId: DEV, date: "2026-10-10" });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text).error).toBe("not-entitled");
    expect(text).not.toContain("sig=");
    expect(ctl.statements).toBe(0);
  });

  it("503 when the database binding is missing", async () => {
    await makePlus();
    ctl.db = null;
    expect((await call({ deviceId: DEV, date: "2026-10-10" })).status).toBe(503);
  });
});

describe.skipIf(!HAS_SQLITE)("date range", () => {
  beforeEach(async () => {
    await makePlus();
    hour({ hour_utc: "2026-10-08T14:00:00.000Z", local_date: "2026-10-08" });
  });

  it("400s a date before the first archived day or after today in the beach's timezone", async () => {
    expect((await call({ deviceId: DEV, date: "2026-10-07" })).status).toBe(400);
    expect((await call({ deviceId: DEV, date: "2026-10-12" })).status).toBe(400);
    expect((await call({ deviceId: DEV, date: "2027-01-01" })).status).toBe(400);
  });

  it("accepts the first archived day and today", async () => {
    expect((await call({ deviceId: DEV, date: "2026-10-08" })).status).toBe(200);
    expect((await call({ deviceId: DEV, date: "2026-10-11" })).status).toBe(200);
  });

  it("uses the BEACH's today, not UTC's: 01:00 UTC on Oct 12 is still Oct 11 in Boca", async () => {
    vi.setSystemTime(Date.parse("2026-10-12T01:00:00Z"));
    expect((await call({ deviceId: DEV, date: "2026-10-11" })).status).toBe(200);
    expect((await call({ deviceId: DEV, date: "2026-10-12" })).status).toBe(400);
  });

  it("400s every date when this beach has no archive at all", async () => {
    h.all("DELETE FROM beach_hourly");
    expect((await call({ deviceId: DEV, date: "2026-10-10" })).status).toBe(400);
  });
});

describe.skipIf(!HAS_SQLITE)("hours", () => {
  beforeEach(async () => {
    await makePlus();
  });

  it("shapes one local day's snapshot rows, ordered by hour_utc, with private no-store headers", async () => {
    hour({ hour_utc: "2026-10-10T16:00:00.000Z", local_hour: 12, score: 90, rating: "Great" });
    hour({
      hour_utc: "2026-10-10T14:00:00.000Z",
      local_hour: 10,
      score: 70,
      air_temp_f: 84,
      water_temp_f: 83,
      wind_mph: 9,
      wave_ft: 4.4, // raw Hs: must NOT be what the surf line shows
      surf_ft: 1.8,
      rain_now: 1,
      uv: 8,
      sand_temp_f: 101,
      seaweed_level: "low",
      crowd_pct: 35,
      extra_json: JSON.stringify({
        v: 1,
        rip: { av: "x", level: "moderate", source: "srf", modelPct: null, srf: null, watch: 0, alert: 0 },
        flags: { av: "x", colors: ["green", "yellow", "unknown"], status: "ok" },
      }),
    });
    hour({ hour_utc: "2026-10-10T15:00:00.000Z", local_hour: 11, score: null, rating: null, extra_json: "{not json", rain_now: 0 });
    // Not part of the day: other date, other beach, backfill row.
    hour({ hour_utc: "2026-10-09T14:00:00.000Z", local_date: "2026-10-09" });
    hour({ slug: "deerfield-beach", hour_utc: "2026-10-10T14:00:00.000Z" });
    hour({ hour_utc: "2026-10-10T17:00:00.000Z", row_kind: "cam-backfill", score: null });

    const res = await call({ deviceId: DEV, date: "2026-10-10" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.date).toBe("2026-10-10");
    expect(body.timezone).toBe("America/New_York");
    expect(body.archiveStart).toBe("2026-10-09");
    expect(body.framesStart).toBeNull();
    expect(body.hours.map((x: { hourUtc: string }) => x.hourUtc)).toEqual([
      "2026-10-10T14:00:00.000Z",
      "2026-10-10T15:00:00.000Z",
      "2026-10-10T16:00:00.000Z",
    ]);
    expect(body.hours[0]).toEqual({
      hourUtc: "2026-10-10T14:00:00.000Z",
      localHour: 10,
      utcOffsetMinutes: -240,
      score: 70,
      rating: "Good",
      engineVersion: SCORING_ENGINE_VERSION,
      readings: {
        airF: 84,
        waterF: 83,
        windMph: 9,
        windDir: null,
        surfFt: 1.8,
        rainNow: true,
        uv: 8,
        sandF: 101,
        flag: "yellow",
        rip: "moderate",
        seaweed: "low",
        crowdPct: 35,
      },
    });
    // Malformed extra_json, null score: every reading missing, nothing thrown.
    expect(body.hours[1]).toMatchObject({
      score: null,
      rating: null,
      readings: { airF: null, surfFt: null, rainNow: false, flag: null, rip: null, sandF: null },
    });
  });

  it("returns the DaySummary summarizeDay builds and the formula versions for that day", async () => {
    hour({ hour_utc: "2026-10-10T14:00:00.000Z", local_hour: 10, score: 70 });
    hour({ hour_utc: "2026-10-10T16:00:00.000Z", local_hour: 12, score: 91 });
    const body = await (await call({ deviceId: DEV, date: "2026-10-10" })).json();
    expect(body.summary).toMatchObject({ date: "2026-10-10", best: { score: 91, localHour: 12 }, hours: 2 });
    expect(body.summary.hourly.map((x: { hourUtc: string }) => x.hourUtc)).toEqual([
      "2026-10-10T14:00:00.000Z",
      "2026-10-10T16:00:00.000Z",
    ]);
    expect(typeof summarizeDay).toBe("function");
    expect(body.versions).toMatchObject({ current: SCORING_ENGINE_VERSION });
    expect(body.versions.inRange).toEqual([SCORING_ENGINE_VERSION]);
  });

  it("keys a DST fall-back day by hourUtc: two rows both read local hour 1", async () => {
    vi.setSystemTime(Date.parse("2026-11-02T15:00:00Z"));
    const fall = { local_date: "2026-11-01", local_hour: 1 };
    hour({ hour_utc: "2026-11-01T05:00:00.000Z", utc_offset_minutes: -240, score: 60, ...fall });
    hour({ hour_utc: "2026-11-01T06:00:00.000Z", utc_offset_minutes: -300, score: 62, ...fall });
    hour({ hour_utc: "2026-11-01T07:00:00.000Z", utc_offset_minutes: -300, score: 64, local_date: "2026-11-01", local_hour: 2 });
    const body = await (await call({ deviceId: DEV, date: "2026-11-01" })).json();
    expect(body.hours.map((x: { hourUtc: string; localHour: number; utcOffsetMinutes: number }) => [x.hourUtc, x.localHour, x.utcOffsetMinutes])).toEqual([
      ["2026-11-01T05:00:00.000Z", 1, -240],
      ["2026-11-01T06:00:00.000Z", 1, -300],
      ["2026-11-01T07:00:00.000Z", 2, -300],
    ]);
  });

  it("answers an in-range day with no rows: hours [] and a calm summary", async () => {
    hour({ hour_utc: "2026-10-08T14:00:00.000Z", local_date: "2026-10-08" });
    const res = await call({ deviceId: DEV, date: "2026-10-09" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hours).toEqual([]);
    expect(body.summary).toMatchObject({ date: "2026-10-09", hours: 0, best: null });
  });
});

describe.skipIf(!HAS_SQLITE)("camera shots", () => {
  beforeEach(async () => {
    await makePlus();
    hour({ hour_utc: "2026-10-10T14:00:00.000Z" });
  });

  async function day() {
    const res = await call({ deviceId: DEV, date: "2026-10-10" });
    expect(res.status).toBe(200);
    return res.json();
  }

  it("lists every archived cam of the beach; a cam with no shot has frames: []", async () => {
    await shot("boca-south", "2026-10-10T14:00:00.000Z", { localHour: 10 });
    const body = await day();
    const ids = body.cams.map((c: { id: string }) => c.id);
    expect(ids).toEqual([
      "boca-south",
      "boca-inlet-north",
      "boca-south-surf",
      "boca-inlet",
      "boca-inlet-surf",
      "boca-inlet-jetty",
    ]);
    const south = body.cams.find((c: { id: string }) => c.id === "boca-south");
    expect(south.name).toBe("Boca Raton South Beach Cam");
    expect(south.frames).toHaveLength(1);
    expect(south.frames[0]).toMatchObject({ hourUtc: "2026-10-10T14:00:00.000Z", displayAtLocal: "10:42 AM" });
    expect(body.cams.find((c: { id: string }) => c.id === "boca-inlet").frames).toEqual([]);
    expect(body.framesStart).toBe("2026-10-10");
  });

  it("hides pending shots, shots of other days and other beaches", async () => {
    await shot("boca-south", "2026-10-10T14:00:00.000Z", { localHour: 10, ready: false });
    await shot("boca-south", "2026-10-10T15:00:00.000Z", { localHour: 11 });
    await shot("boca-south", "2026-10-09T15:00:00.000Z", { localHour: 11 });
    await shot("deerfield-beach-cam", "2026-10-10T15:00:00.000Z", { localHour: 11, slug: "deerfield-beach" });
    const body = await day();
    const south = body.cams.find((c: { id: string }) => c.id === "boca-south");
    expect(south.frames.map((f: { hourUtc: string }) => f.hourUtc)).toEqual(["2026-10-10T15:00:00.000Z"]);
    expect(body.cams.map((c: { id: string }) => c.id)).not.toContain("deerfield-beach-cam");
  });

  it("hides a cam the manifest no longer archives (archive: false), shots and all", async () => {
    await shot("boca-inlet-jetty", "2026-10-10T14:00:00.000Z", { localHour: 10 });
    await shot("boca-south", "2026-10-10T14:00:00.000Z", { localHour: 10 });
    ctl.disabled.add("boca-inlet-jetty");
    const body = await day();
    expect(body.cams.map((c: { id: string }) => c.id)).not.toContain("boca-inlet-jetty");
    expect(JSON.stringify(body)).not.toContain("boca-inlet-jetty");
    expect(body.cams.find((c: { id: string }) => c.id === "boca-south").frames).toHaveLength(1);
  });

  it("takes the credit from each stored row, not from today's config", async () => {
    await shot("boca-south", "2026-10-10T14:00:00.000Z", { localHour: 10, attribution: "OLD credit line" });
    await shot("boca-south", "2026-10-10T15:00:00.000Z", { localHour: 11, attribution: null });
    const body = await day();
    const south = body.cams.find((c: { id: string }) => c.id === "boca-south");
    expect(south.frames.map((f: { attribution: string | null }) => f.attribution)).toEqual(["OLD credit line", null]);
    expect(JSON.stringify(body)).not.toContain("Palm Beach County ERM");
  });

  it("signs each link for 15 minutes, with a signature the image route accepts", async () => {
    const key = await shot("boca-south", "2026-10-10T14:00:00.000Z", { localHour: 10 });
    const body = await day();
    const url = new URL(body.cams[0].frames[0].url, "https://x");
    expect(url.pathname).toBe("/api/cam-frames/img");
    expect(url.searchParams.get("k")).toBe(key);
    const exp = Number(url.searchParams.get("exp"));
    const nowSec = Math.floor(NOW / 1000);
    expect(exp).toBe(nowSec + 900);
    expect(await verify(key, exp, url.searchParams.get("sig"), nowSec)).toBe(true);
    // Not valid for another key, nor after it expires.
    expect(await verify(key.replace("1442Z", "1443Z"), exp, url.searchParams.get("sig"), nowSec)).toBe(false);
    expect(await verify(key, exp, url.searchParams.get("sig"), exp)).toBe(false);
  });

  it("uses at most three D1 statements", async () => {
    await shot("boca-south", "2026-10-10T14:00:00.000Z", { localHour: 10 });
    ctl.statements = 0;
    await day();
    expect(ctl.statements).toBeLessThanOrEqual(3);
  });

  it("503 not-configured when the signing key is unset and there are shots to sign", async () => {
    await shot("boca-south", "2026-10-10T14:00:00.000Z", { localHour: 10 });
    delete process.env.CAM_FRAME_URL_KEY;
    const res = await call({ deviceId: DEV, date: "2026-10-10" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("not-configured");
  });

  it("never signs a ready row whose key points at another beach, cam or date", async () => {
    const good = await shot("boca-south", "2026-10-10T14:00:00.000Z", { localHour: 10 });
    await shot("boca-inlet", "2026-10-10T14:00:00.000Z", { localHour: 10 });
    await shot("boca-south-surf", "2026-10-10T15:00:00.000Z", { localHour: 11 });
    await shot("boca-inlet-surf", "2026-10-10T16:00:00.000Z", { localHour: 12 });
    const other = "deerfield-beach/deerfield-beach-cam/2026-10-10/1442Z-01234567-cccccccc.jpg";
    const otherCam = "boca-raton/boca-south/2026-10-10/1442Z-89abcdef-cccccccc.jpg";
    const otherDate = "boca-raton/boca-inlet-surf/2026-10-09/1642Z-01234567-cccccccc.jpg";
    h.all("UPDATE cam_frames SET r2_key = ? WHERE cam_id = 'boca-inlet'", other);
    h.all("UPDATE cam_frames SET r2_key = ? WHERE cam_id = 'boca-south-surf'", otherCam);
    h.all("UPDATE cam_frames SET r2_key = ? WHERE cam_id = 'boca-inlet-surf'", otherDate);
    const body = await day();
    const byId = (id: string) => body.cams.find((c: { id: string }) => c.id === id);
    expect(byId("boca-south").frames).toHaveLength(1);
    expect(decodeURIComponent(byId("boca-south").frames[0].url)).toContain(good);
    for (const id of ["boca-inlet", "boca-south-surf", "boca-inlet-surf"]) expect(byId(id).frames).toEqual([]);
    const text = JSON.stringify(body);
    for (const k of [other, otherCam, otherDate]) expect(text).not.toContain(encodeURIComponent(k));
  });

  it("skips a stored row whose key is malformed instead of failing the day", async () => {
    await shot("boca-south", "2026-10-10T14:00:00.000Z", { localHour: 10 });
    h.all("UPDATE cam_frames SET r2_key = '../bad' WHERE cam_id = 'boca-south'");
    const body = await day();
    expect(body.cams[0].frames).toEqual([]);
  });
});
