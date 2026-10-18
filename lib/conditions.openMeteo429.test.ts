// Production bug 2026-10-17 (~00:03Z, Jacksonville Beach): Open-Meteo answered
// `429 Too many concurrent requests` to the Worker for hourly, forecast, GFS and
// nowcast, so the snapshot lost them and the page said "Partial data: no UV
// index and sand temperature". This runs the REAL conditions pipeline twice:
// once with Open-Meteo healthy (that fills the last-good copies), then with
// EVERY Open-Meteo host answering 429. The second snapshot must still carry UV
// and sand temperature from the last-good hourly copy, with each Open-Meteo
// source marked "stale". Every other upstream answers 503 throughout.
//
// Only Date is faked (so retries and timeouts still run on real timers). The
// Open-Meteo bodies are the real Boca captures in lib/__fixtures__/openMeteo/,
// served at 16:00Z on the capture day (noon in Boca, so UV is well above 0 and
// the night rule "UV is 0 after sunset" cannot be what fills it).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocation } from "@/config/locations";
import { getSnapshotForLocation } from "@/lib/conditions";
import { currentHourOf, deriveMetrics } from "@/lib/score";
import { __resetOpenMeteoStateForTests } from "@/lib/sources/openMeteo";

const fx = (name: string) =>
  readFileSync(new URL(`./__fixtures__/openMeteo/boca-${name}.json`, import.meta.url), "utf8");

const T_LIVE = Date.parse("2026-10-18T16:00:00Z");

const MARINE = JSON.stringify({
  current: { wave_height: 0.6, wave_direction: 90, wave_period: 7, swell_wave_height: 0.4, swell_wave_period: 8, swell_wave_direction: 95, sea_surface_temperature: 28 },
  hourly: { time: ["2026-10-18T15:00", "2026-10-18T16:00"], wave_height: [0.6, 0.6], wave_period: [7, 7], wave_direction: [90, 90] },
});
const AIR = JSON.stringify({ current: { time: "2026-10-18T16:00", us_aqi: 31, pm2_5: 5, pm10: 9, ozone: 60, us_aqi_pm2_5: 20, us_aqi_pm10: 8, us_aqi_ozone: 31 } });
const SAT = JSON.stringify({ hourly: { time: ["2026-10-18T14:00", "2026-10-18T15:00"], shortwave_radiation: [230, 590] } });

// The Boca call-B capture is at night (UV 0). Give the live answer a daytime
// current block so the marine UV path is checked with a real value.
const B_DAY = (() => {
  const j = JSON.parse(fx("b-merged"));
  j.current = { time: "2026-10-18T16:00", interval: 900, uv_index: 3.1, cloud_cover: 40 };
  return JSON.stringify(j);
})();
const B_UV_AT_1615 = (() => {
  const m = JSON.parse(fx("b-merged")).minutely_15;
  return m.uv_index_best_match[m.time.indexOf("2026-10-18T16:15")] as number;
})();

type Mode = "healthy" | "429";

function stubFetch(mode: Mode) {
  const omCalls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const host = new URL(url).host;
    const date = new Date().toUTCString(); // faked clock
    if (!host.endsWith("open-meteo.com")) return new Response("down", { status: 503 });
    omCalls.push(host);
    if (mode === "429") {
      return new Response('{"reason":"Too many concurrent requests","error":true}', { status: 429 });
    }
    const body =
      host.startsWith("marine-api") ? MARINE
      : host.startsWith("air-quality-api") ? AIR
      : host.startsWith("satellite-api") ? SAT
      : url.includes("&hourly=") ? fx("a-merged")
      : url.includes("minutely_15=") ? B_DAY
      : "{}";
    return new Response(body, { status: 200, headers: { date, "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return omCalls;
}

const OM_SOURCES = ["hourly", "forecast", "gfs", "nowcast", "marine", "airQuality"] as const;

describe("conditions build when Open-Meteo answers 429 everywhere", () => {
  const loc = getLocation("boca-raton")!;

  beforeEach(() => {
    __resetOpenMeteoStateForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps UV and sand temperature from the last good copy and marks the sources stale", async () => {
    // 1. Healthy build at 16:00Z: fills the last-good copies.
    vi.setSystemTime(T_LIVE);
    const liveCalls = stubFetch("healthy");
    const live = await getSnapshotForLocation(loc);
    for (const k of OM_SOURCES) expect(live[k].status, k).toBe("ok");
    // Two calls to api.open-meteo.com (A + B) + marine + air + satellite.
    expect(liveCalls.filter((h) => h === "api.open-meteo.com")).toHaveLength(2);
    expect(liveCalls).toHaveLength(5);
    const liveD = deriveMetrics(live, T_LIVE);
    expect(live.marine.data?.uvIndex).toBe(3.1);
    expect(live.marine.data?.cloudCoverPct).toBe(40);

    // 2. Twenty minutes later every Open-Meteo host answers 429.
    vi.setSystemTime(T_LIVE + 20 * 60_000);
    const failCalls = stubFetch("429");
    const snap = await getSnapshotForLocation(loc);
    expect(failCalls.length).toBeGreaterThan(0); // the 429s really were served
    expect(failCalls.length).toBeLessThanOrEqual(5); // and none was retried

    for (const k of OM_SOURCES) {
      expect(snap[k].status, k).toBe("stale");
      expect(snap[k].data, k).not.toBeNull();
      expect(snap[k].note, k).toMatch(/429.*showing the copy from 20 min ago/);
      expect(snap[k].fetchedAt, k).toBe(new Date(T_LIVE).toISOString());
    }

    const now = T_LIVE + 20 * 60_000;
    const d = deriveMetrics(snap, now);
    const hour = currentHourOf(snap.hourly.data!, now)!;
    expect(hour.time).toBe("2026-10-18T16:00:00.000Z");
    // UV comes from the last-good hourly (3.6 at 16Z in the capture), not the night rule.
    expect(d.uvIndex).toBe(hour.uvIndex);
    expect(d.uvIndex).toBeGreaterThan(0);
    expect(d.sandTempF).toBeTypeOf("number");
    expect(liveD.sandTempF).toBeTypeOf("number");
    // Marine's UV from the stale call-B copy is read for the 16:15 slot (now).
    expect(B_UV_AT_1615).toBeGreaterThan(0);
    expect(snap.marine.data?.uvIndex).toBe(Math.round(B_UV_AT_1615 * 10) / 10);

    // 3. 30 s later the pause (45-75 s) is still running: a further build makes
    //    NO Open-Meteo calls at all and still serves the stale copies.
    vi.setSystemTime(T_LIVE + 20 * 60_000 + 30_000);
    const pausedCalls = stubFetch("429");
    const again = await getSnapshotForLocation(loc);
    expect(pausedCalls).toHaveLength(0);
    for (const k of OM_SOURCES) expect(again[k].status, k).toBe("stale");
    expect(deriveMetrics(again, Date.now()).uvIndex).toBeGreaterThan(0);
  });

  it("drops the nowcast once its copy is over 30 min old; the rest stay stale", async () => {
    vi.setSystemTime(T_LIVE);
    stubFetch("healthy");
    await getSnapshotForLocation(loc);

    vi.setSystemTime(T_LIVE + 45 * 60_000);
    stubFetch("429");
    const snap = await getSnapshotForLocation(loc);
    expect(snap.nowcast.status).toBe("error");
    expect(snap.nowcast.data).toBeNull();
    expect(snap.nowcast.note).toMatch(/45 min old, too old for a nowcast/);
    for (const k of ["hourly", "forecast", "gfs", "marine", "airQuality"] as const) {
      expect(snap[k].status, k).toBe("stale");
    }
    expect(deriveMetrics(snap, T_LIVE + 45 * 60_000).uvIndex).toBeGreaterThan(0);
  });

  it("at night with no copy at all, UV reads 0, not missing", async () => {
    const night = Date.parse("2026-10-18T03:00:00Z"); // 11 PM in Boca
    vi.setSystemTime(night);
    stubFetch("429");
    const snap = await getSnapshotForLocation(loc);
    expect(snap.hourly.status).toBe("error");
    expect(snap.marine.status).toBe("error");
    expect(deriveMetrics(snap, night).uvIndex).toBe(0);
  });
});
