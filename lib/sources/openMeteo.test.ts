// Shared Open-Meteo client (lib/sources/openMeteo.ts): the two merged
// /v1/forecast calls must reproduce the old separate calls value for value,
// and the back-off / last-good / API-key rules must hold.
//
// Fixtures (lib/__fixtures__/openMeteo/): real responses for Boca Raton,
// captured 2026-10-18 00:22-00:23Z, one after the other (Date headers in
// boca-meta.json). "a-merged" is call A (hourly + daily), "b-merged" is call B
// (15-minute + current + GFS); the rest are the OLD separate calls, captured
// in the same minute. It was raining, so the 15-minute rain is non-zero.
// It was night in Boca, so a daytime call-B set (waikiki-*) checks UV too.
import { readFileSync } from "node:fs";
import { runWithBudget, SubrequestBudget } from "@/lib/alerts/budget";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseOpenMeteoDaily } from "@/lib/sources/forecast";
import { parseOpenMeteoHourly } from "@/lib/sources/hourlyForecast";
import { parseGfsCurrent } from "@/lib/sources/modelEnsemble";
import { parseNowcast } from "@/lib/sources/nowcast";
import {
  __resetOpenMeteoStateForTests,
  fetchForecastPoint,
  fetchOpenMeteoJson,
  forecastPointUrl,
  noteOpenMeteo429,
  nowPointUrl,
  openMeteoBackoffRemainingMs,
  openMeteoUrl,
  splitForecastPoint,
  splitNowPoint,
  OPEN_METEO_BACKOFF_MS,
  type ForecastPointJson,
  type NowPointJson,
} from "@/lib/sources/openMeteo";

const fx = (name: string) =>
  JSON.parse(readFileSync(new URL(`../__fixtures__/openMeteo/boca-${name}.json`, import.meta.url), "utf8"));
const meta = fx("meta") as Record<string, string>;
const A_REF_MS = Date.parse(meta["a-merged"]);

describe("call A (hourly + daily) reproduces the old separate calls", () => {
  const split = splitForecastPoint(fx("a-merged") as ForecastPointJson, A_REF_MS);

  it("hourly: every parsed hour equals the old hourly call", () => {
    const merged = parseOpenMeteoHourly(split.hourly as never);
    const old = parseOpenMeteoHourly(fx("a-hourly"));
    expect(merged).not.toBeNull();
    expect(merged!.length).toBe(216); // 2 past + 7 forecast GMT days
    expect(merged).toEqual(old);
  });

  it("daily: the 7 local days equal the old 7-day call", () => {
    const merged = parseOpenMeteoDaily(split.daily as never);
    const old = parseOpenMeteoDaily(fx("a-daily"));
    expect(merged).toHaveLength(7);
    expect(merged).toEqual(old);
  });

  it("every daily tile has hourly hours to score (regression: 2026-07-17 'no good window')", () => {
    // The outlook strip shows one tile per DAILY day and scores it from HOURLY
    // hours. Each daily date must have daylight hours (local 10:00-16:00) in
    // the hourly window, or the last tile claims "no good window".
    const hours = parseOpenMeteoHourly(split.hourly as never)!;
    const days = parseOpenMeteoDaily(split.daily as never)!;
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    const daylight = new Set<string>();
    for (const h of hours) {
      const p = Object.fromEntries(fmt.formatToParts(new Date(h.time)).map((x) => [x.type, x.value]));
      const hr = Number(p.hour);
      if (hr >= 10 && hr <= 16) daylight.add(`${p.year}-${p.month}-${p.day}`);
    }
    for (const d of days) expect(daylight.has(d.date)).toBe(true);
  });

  it("never asks for `current` or `minutely_15` (they change the hourly numbers)", () => {
    const url = forecastPointUrl(26.3587, -80.0686);
    expect(url).toContain("&hourly=");
    expect(url).toContain("&daily=");
    expect(url).not.toContain("current=");
    expect(url).not.toContain("minutely_15");
    expect(url).not.toContain("models=");
  });
});

describe("call B (15-minute + current + GFS) reproduces the old separate calls", () => {
  const b = fx("b-merged") as NowPointJson;
  const split = splitNowPoint(b);

  it("15-minute rain equals the old nowcast call, and so does every nowcast", () => {
    const old = fx("b-minutely");
    expect(split.minutely.minutely_15.time).toEqual(old.minutely_15.time);
    expect(split.minutely.minutely_15.precipitation).toEqual(old.minutely_15.precipitation);
    expect(old.minutely_15.precipitation.some((v: number) => v > 0)).toBe(true);
    const t0 = Date.parse("2026-10-18T00:00:00Z");
    for (let m = 0; m < 24 * 60; m += 5) {
      expect(parseNowcast(split.minutely, t0 + m * 60_000)).toEqual(parseNowcast(old, t0 + m * 60_000));
    }
  });

  it("GFS current equals the old models=gfs_seamless&current= call", () => {
    expect(split.gfs).not.toBeNull();
    expect(parseGfsCurrent(split.gfs!)).toEqual(parseGfsCurrent(fx("b-gfs")));
  });

  it("current UV + cloud equal the old marine `current=uv_index,cloud_cover` call", () => {
    const old = fx("b-uv").current;
    expect(split.current).toEqual({ uv_index: old.uv_index, cloud_cover: old.cloud_cover });
  });

  it("lists best_match FIRST (Open-Meteo fills `current` from the first model)", () => {
    expect(nowPointUrl(1, 2)).toContain("&models=best_match,gfs_seamless");
  });

  it("a stale copy reads GFS + UV for the 15-minute slot of NOW", () => {
    const at = Date.parse("2026-10-18T16:20:00Z");
    const s = splitNowPoint(b, at);
    const i = b.minutely_15!.time!.indexOf("2026-10-18T16:15");
    expect(i).toBeGreaterThan(0);
    const m = b.minutely_15 as Record<string, unknown[]>;
    expect(s.gfs!.current.temperature_2m).toBe(m.temperature_2m_gfs_seamless[i]);
    expect(s.current!.uv_index).toBe(m.uv_index_best_match[i]);
  });

  it("a stale copy that no longer covers now falls back to its own current.time", () => {
    const s = splitNowPoint(b, Date.parse("2026-10-19T03:00:00Z"));
    expect(parseGfsCurrent(s.gfs!)).toEqual(parseGfsCurrent(fx("b-gfs")));
  });
});

describe("call B in DAYTIME (Waikiki, 14:30 local, 2026-10-18 00:43Z capture)", () => {
  // The Boca capture is at night (UV 0, cloud 100 in every model), so it
  // cannot tell best-match UV/cloud from GFS. Here best-match cloud is 37 and
  // GFS cloud is 0, and UV is 5.85.
  const wk = (name: string) =>
    JSON.parse(readFileSync(new URL(`../__fixtures__/openMeteo/waikiki-${name}.json`, import.meta.url), "utf8"));
  const split = splitNowPoint(wk("b-merged") as NowPointJson);

  it("current UV + cloud equal the old best-match call (not GFS)", () => {
    const old = wk("b-uv").current;
    expect(old.uv_index).toBeGreaterThan(0);
    expect(split.current).toEqual({ uv_index: old.uv_index, cloud_cover: old.cloud_cover });
    expect(split.current!.cloud_cover).not.toBe(wk("b-gfs").current.cloud_cover);
  });

  it("GFS current equals the old GFS call", () => {
    expect(parseGfsCurrent(split.gfs!)).toEqual(parseGfsCurrent(wk("b-gfs")));
  });

  it("15-minute rain equals the old nowcast call", () => {
    const old = wk("b-minutely");
    expect(split.minutely.minutely_15).toEqual({ time: old.minutely_15.time, precipitation: old.minutely_15.precipitation });
  });
});

describe("API key (paid plan)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("without a key, uses the free hosts and adds no apikey", () => {
    vi.stubEnv("OPEN_METEO_API_KEY", "");
    expect(forecastPointUrl(1, 2)).toMatch(/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
    expect(forecastPointUrl(1, 2)).not.toContain("apikey");
    expect(openMeteoUrl("marine-api", "/v1/marine?x=1")).toBe("https://marine-api.open-meteo.com/v1/marine?x=1");
  });

  it("with a key, uses the customer hosts and appends &apikey=", () => {
    vi.stubEnv("OPEN_METEO_API_KEY", "k3y");
    expect(nowPointUrl(1, 2)).toMatch(/^https:\/\/customer-api\.open-meteo\.com\/v1\/forecast\?.*&apikey=k3y$/);
    expect(openMeteoUrl("marine-api", "/v1/marine?x=1")).toBe("https://customer-marine-api.open-meteo.com/v1/marine?x=1&apikey=k3y");
    expect(openMeteoUrl("air-quality-api", "/v1/air-quality?x=1")).toContain("https://customer-air-quality-api.open-meteo.com/");
    expect(openMeteoUrl("satellite-api", "/v1/archive?x=1")).toContain("https://customer-satellite-api.open-meteo.com/");
  });

  it("never puts the key in a note or a log line", async () => {
    vi.stubEnv("OPEN_METEO_API_KEY", "s3cret-key");
    __resetOpenMeteoStateForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":true,"reason":"Too many concurrent requests"}', { status: 429 })));
    const r = await fetchOpenMeteoJson(openMeteoUrl("api", "/v1/forecast?latitude=1"), { storeKey: "k", maxAgeMs: 1000 });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("s3cret");
    for (const call of warn.mock.calls) expect(String(call)).not.toContain("s3cret");
    vi.unstubAllGlobals();
    warn.mockRestore();
  });
});

describe("429 back-off and last-good copies", () => {
  const URL_A = "https://api.open-meteo.com/v1/forecast?latitude=1&longitude=2&hourly=x";
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetOpenMeteoStateForTests();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    warn.mockRestore();
  });

  it("the pause is 60 s jittered ±25%, per host, logged once", () => {
    const t = 1_000_000;
    noteOpenMeteo429(URL_A, null, t, () => 0);
    expect(openMeteoBackoffRemainingMs(URL_A, t)).toBe(OPEN_METEO_BACKOFF_MS * 0.75);
    noteOpenMeteo429(URL_A, null, t + 1, () => 1); // already paused: no new pause, no new log
    expect(openMeteoBackoffRemainingMs(URL_A, t)).toBe(OPEN_METEO_BACKOFF_MS * 0.75);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(openMeteoBackoffRemainingMs("https://marine-api.open-meteo.com/v1/marine", t)).toBe(0);
    __resetOpenMeteoStateForTests();
    noteOpenMeteo429(URL_A, null, t, () => 1);
    expect(openMeteoBackoffRemainingMs(URL_A, t)).toBe(OPEN_METEO_BACKOFF_MS * 1.25);
    __resetOpenMeteoStateForTests();
    noteOpenMeteo429(URL_A, "120", t, () => 0.5); // Retry-After wins when longer
    expect(openMeteoBackoffRemainingMs(URL_A, t)).toBe(120_000);
  });

  it("a 429 is not retried, starts the pause, and serves the last good copy as stale", async () => {
    const fetchMock = vi.fn(async () => new Response('{"v":1}', { status: 200, headers: { date: new Date(Date.now() - 5 * 60_000).toUTCString() } }));
    vi.stubGlobal("fetch", fetchMock);
    const first = await fetchOpenMeteoJson<{ v: number }>(URL_A, { storeKey: "a", maxAgeMs: 3600_000 });
    expect(first).toMatchObject({ ok: true, json: { v: 1 } });
    expect(first.ok && first.stale).toBeUndefined();

    fetchMock.mockImplementation(async () => new Response('{"error":true,"reason":"Too many concurrent requests"}', { status: 429 }));
    const second = await fetchOpenMeteoJson<{ v: number }>(URL_A, { storeKey: "a", maxAgeMs: 3600_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2); // one call, no retry
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.json).toEqual({ v: 1 });
      expect(second.stale!.ageMs).toBeGreaterThanOrEqual(5 * 60_000 - 2000);
      expect(second.stale!.reason).toContain("429");
      expect(second.stale!.reason).not.toContain("latitude"); // host only, no URL
    }
    expect(openMeteoBackoffRemainingMs(URL_A)).toBeGreaterThan(0);

    // While paused, no call at all — straight to the copy.
    const third = await fetchOpenMeteoJson<{ v: number }>(URL_A, { storeKey: "a", maxAgeMs: 3600_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(third.ok && third.stale?.reason).toContain("paused");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a copy older than the caller's max age is not served", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"v":1}', { status: 200, headers: { date: new Date(Date.now() - 40 * 60_000).toUTCString() } })));
    await fetchOpenMeteoJson(URL_A, { storeKey: "old", maxAgeMs: 3600_000 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 429 })));
    const r = await fetchOpenMeteoJson(URL_A, { storeKey: "old", maxAgeMs: 30 * 60_000 });
    expect(r.ok).toBe(false);
  });

  it("a 5xx is retried once; a non-429 4xx is not", async () => {
    const f500 = vi.fn(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", f500);
    await fetchOpenMeteoJson(URL_A, { storeKey: "r", maxAgeMs: 1 });
    expect(f500).toHaveBeenCalledTimes(2);
    const f400 = vi.fn(async () => new Response("bad", { status: 400 }));
    vi.stubGlobal("fetch", f400);
    await fetchOpenMeteoJson(URL_A, { storeKey: "r", maxAgeMs: 1 });
    expect(f400).toHaveBeenCalledTimes(1);
  });

  it("falls back to the edge Cache API copy when this isolate has none", async () => {
    const store = new Map<string, Response>();
    const fakeCache = {
      put: vi.fn(async (k: string, r: Response) => void store.set(k, r)),
      match: vi.fn(async (k: string) => store.get(k)?.clone()),
    };
    vi.stubGlobal("caches", { default: fakeCache });
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"v":2}', { status: 200 })));
    await fetchOpenMeteoJson(URL_A, { storeKey: "edge", maxAgeMs: 3600_000 });
    expect(fakeCache.put).toHaveBeenCalledTimes(1);

    __resetOpenMeteoStateForTests(); // a fresh isolate: memory gone, edge copy kept
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 429 })));
    const r = await fetchOpenMeteoJson<{ v: number }>(URL_A, { storeKey: "edge", maxAgeMs: 3600_000 });
    expect(r.ok && r.json).toEqual({ v: 2 });
    expect(r.ok && r.stale).toBeTruthy();
  });

  it("under a push-run budget: no edge-cache writes, and each read costs 1", async () => {
    const store = new Map<string, Response>();
    const fakeCache = {
      put: vi.fn(async (k: string, r: Response) => void store.set(k, r)),
      match: vi.fn(async (k: string) => store.get(k)?.clone()),
    };
    vi.stubGlobal("caches", { default: fakeCache });
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"v":3}', { status: 200 })));

    const b1 = new SubrequestBudget(10);
    await runWithBudget(b1, () => fetchOpenMeteoJson(URL_A, { storeKey: "bud", maxAgeMs: 3600_000 }));
    expect(fakeCache.put).not.toHaveBeenCalled();
    expect(b1.left).toBe(9); // the fetch only

    // Seed an edge copy outside any budget (a page load), then lose the isolate.
    await fetchOpenMeteoJson(URL_A, { storeKey: "bud2", maxAgeMs: 3600_000 });
    expect(fakeCache.put).toHaveBeenCalledTimes(1);
    __resetOpenMeteoStateForTests();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 429 })));

    const b2 = new SubrequestBudget(10);
    const r = await runWithBudget(b2, () => fetchOpenMeteoJson<{ v: number }>(URL_A, { storeKey: "bud2", maxAgeMs: 3600_000 }));
    expect(r.ok && r.json).toEqual({ v: 3 });
    expect(fakeCache.match).toHaveBeenCalledTimes(1);
    expect(b2.left).toBe(8); // fetch 1 + cache read 1

    // A budget with nothing left for the read skips it (no uncounted subrequest).
    __resetOpenMeteoStateForTests();
    const b3 = new SubrequestBudget(1);
    const r3 = await runWithBudget(b3, () => fetchOpenMeteoJson(URL_A, { storeKey: "bud2", maxAgeMs: 3600_000 }));
    expect(r3.ok).toBe(false);
    expect(fakeCache.match).toHaveBeenCalledTimes(1);
    expect(b3.left).toBe(0);
  });

  it("a stale call-A copy made before local midnight starts the outlook on TODAY (7 tiles)", async () => {
    // Boca: copy made 22:30 local (02:30Z), served at 00:30 local (04:30Z).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-18T02:30:00Z"));
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(readFileSync(new URL("../__fixtures__/openMeteo/boca-a-merged.json", import.meta.url), "utf8"), {
        status: 200,
        headers: { date: new Date().toUTCString() },
      }),
    ));
    const live = await fetchForecastPoint({ lat: 26.3587, lon: -80.0686 });
    expect(live.ok && parseOpenMeteoDaily(live.split.daily as never)![0].date).toBe("2026-10-17");

    vi.setSystemTime(Date.parse("2026-10-18T04:30:00Z"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 429 })));
    const stale = await fetchForecastPoint({ lat: 26.3587, lon: -80.0686 });
    expect(stale.ok && stale.stale).toBeTruthy();
    const days = stale.ok ? parseOpenMeteoDaily(stale.split.daily as never)! : [];
    expect(days).toHaveLength(7);
    expect(days[0].date).toBe("2026-10-18");
    // Every tile still has hourly hours (the old window, cut from now).
    const hours = stale.ok ? parseOpenMeteoHourly(stale.split.hourly as never)! : [];
    expect(hours.at(-1)!.time >= "2026-10-24T23:00:00.000Z").toBe(true);
  });

  it("fetchForecastPoint never rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    const r = await fetchForecastPoint({ lat: 1, lon: 2 });
    expect(r.ok).toBe(false);
  });
});
