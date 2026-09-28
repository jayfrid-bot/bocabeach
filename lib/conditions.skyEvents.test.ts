// Integration test for the "Coming up" sky-events wiring (docs/SKY_EVENTS_PLAN.md
// §9, INTEGRATION/Crew H): lib/conditions.ts is responsible for (a) computing
// moon + meteor locally at zero fetch cost, always; (b) fetching launch + king
// tide together, ONLY when there's room in the ambient push-run subrequest
// budget (outside a push run — no ambient budget at all — they're always
// fetched); (c) pinning every one of those calls to the snapshot's OWN
// generatedAt, never a fresh clock read; and (d) handing the four wrapped
// results straight through to lib/skyEvents.ts's buildComingUp(), landing its
// result on ConditionsSnapshot.skyEvents untouched.
//
// The four sky-source adapters AND buildComingUp itself are mocked — their own
// merge/rating/validation logic is covered by lib/skyEvents.test.ts and each
// adapter's own *.test.ts. This file tests only the WIRING: who gets called,
// with what arguments, under what budget, and where the result lands.
//
// buildComingUp now returns { card, alertCandidates } (Codex round-2 review
// HIGH #2) — this file also checks lib/conditions.ts lands `card` on
// `snapshot.skyEvents` and `alertCandidates` on the separate, server-only
// `snapshot.skyAlertCandidates` untouched, never merged or dropped.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Location, Wrapped } from "@/lib/types";
import type {
  LaunchSkyEvent,
  MeteorSkyEvent,
  MoonSkyEvent,
  SkyEvent,
  SkyEventsCardData,
  TideSkyEvent,
} from "@/lib/skyEventsTypes";

const {
  fetchMoonEventsMock,
  fetchMeteorShowersMock,
  fetchLaunchEventsMock,
  fetchKingTideMock,
  buildComingUpMock,
  cacheStore,
} = vi.hoisted(() => ({
  fetchMoonEventsMock: vi.fn(),
  fetchMeteorShowersMock: vi.fn(),
  fetchLaunchEventsMock: vi.fn(),
  fetchKingTideMock: vi.fn(),
  buildComingUpMock: vi.fn(),
  cacheStore: new Map<string, unknown>(),
}));

vi.mock("@/lib/sources/moonEvents", () => ({ fetchMoonEvents: fetchMoonEventsMock }));
vi.mock("@/lib/sources/meteorShowers", () => ({ fetchMeteorShowers: fetchMeteorShowersMock }));
vi.mock("@/lib/sources/launchLibrary", () => ({ fetchLaunchEvents: fetchLaunchEventsMock }));
vi.mock("@/lib/sources/kingTide", () => ({ fetchKingTide: fetchKingTideMock }));
vi.mock("@/lib/skyEvents", () => ({ buildComingUp: buildComingUpMock }));

// Same fake unstable_cache lib/conditions.budgetAborted.test.ts uses: write-on-
// success, never-write-on-throw, without needing Next's real server runtime.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...a: unknown[]) => Promise<unknown>, keyParts: string[]) => {
    const key = keyParts.join(":");
    return async (...args: unknown[]) => {
      if (cacheStore.has(key)) return cacheStore.get(key);
      const result = await fn(...args);
      cacheStore.set(key, result);
      return result;
    };
  },
}));

import { SubrequestBudget, runWithBudget } from "@/lib/alerts/budget";
import { getConditions, getSnapshotForLocation } from "@/lib/conditions";

function wrap<T>(data: T | null, overrides: Partial<Wrapped<T>> = {}): Wrapped<T> {
  return {
    source: "test",
    status: data ? "ok" : "error",
    fetchedAt: "2026-10-01T00:00:00Z",
    attribution: "test",
    data,
    ...overrides,
  };
}

const LOC: Location = {
  slug: "sky-test-beach",
  name: "Sky Test Beach",
  region: "Test County, FL",
  lat: 26.35,
  lon: -80.08,
  timezone: "America/New_York",
  coast: "atlantic",
  coastNormalDeg: 90,
  noaaTideStationId: "8722670",
  ndbcBuoyId: "LKWF1",
  cams: [],
};

const FAKE_CARD: SkyEventsCardData = {
  rows: [],
  generatedAt: "2026-10-01T00:00:00Z",
};

// A distinguishable, non-empty alertCandidates pool — this only needs to be
// SOMETHING lib/conditions.ts can pass through untouched, since buildComingUp
// itself is mocked here (its real merge/rating logic is lib/skyEvents.test.ts's
// job). Deliberately NOT the same array as FAKE_CARD.rows so a test that
// accidentally read the card instead of the candidates pool would fail.
const FAKE_ALERT_CANDIDATES = [
  { eventType: "meteor", showerId: "perseids" } as unknown as SkyEvent,
];

const FAKE_RESULT = { card: FAKE_CARD, alertCandidates: FAKE_ALERT_CANDIDATES };

describe("lib/conditions.ts — sky-events wiring (SKY_EVENTS_PLAN.md §9)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cacheStore.clear();
    vi.clearAllMocks();
  });

  // Every other conditions source (tides, buoy, weather, marine, ...) is left
  // UNMOCKED — this exercises the real lib/conditions.ts pipeline exactly like
  // lib/conditions.budgetAborted.test.ts does, with a generic empty-JSON
  // response so every one of those ~20 adapters degrades gracefully instead
  // of throwing.
  function mockCoreFetch() {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  }

  function setDefaultSkyMocks() {
    fetchMoonEventsMock.mockReturnValue(wrap<(MeteorSkyEvent | MoonSkyEvent)[]>([]));
    fetchMeteorShowersMock.mockReturnValue(wrap<MeteorSkyEvent[]>([]));
    fetchLaunchEventsMock.mockResolvedValue(wrap<LaunchSkyEvent[]>([]));
    fetchKingTideMock.mockResolvedValue(wrap<TideSkyEvent[]>([]));
    buildComingUpMock.mockReturnValue(FAKE_RESULT);
  }

  it("outside a push run (no ambient budget), always fetches launch + king tide, and pins every call to the snapshot's own generatedAt", async () => {
    mockCoreFetch();
    setDefaultSkyMocks();

    const snapshot = await getSnapshotForLocation(LOC);

    expect(fetchLaunchEventsMock).toHaveBeenCalledTimes(1);
    expect(fetchKingTideMock).toHaveBeenCalledTimes(1);
    expect(fetchMoonEventsMock).toHaveBeenCalledTimes(1);
    expect(fetchMeteorShowersMock).toHaveBeenCalledTimes(1);
    expect(buildComingUpMock).toHaveBeenCalledTimes(1);

    const pinnedMs = Date.parse(snapshot.generatedAt);
    expect(Number.isFinite(pinnedMs)).toBe(true);

    // fetchMoonEvents(beach, now: Date, windowDays)
    const [moonBeach, moonNow, moonWindowDays] = fetchMoonEventsMock.mock.calls[0];
    expect(moonBeach).toEqual({
      lat: LOC.lat,
      lon: LOC.lon,
      timezone: LOC.timezone,
      coastNormalDeg: LOC.coastNormalDeg,
    });
    expect((moonNow as Date).getTime()).toBe(pinnedMs);
    expect(moonWindowDays).toBe(14);

    // fetchMeteorShowers(beach, nowMs)
    const [meteorBeach, meteorNowMs] = fetchMeteorShowersMock.mock.calls[0];
    expect(meteorBeach).toEqual({ lat: LOC.lat, lon: LOC.lon, timezone: LOC.timezone });
    expect(meteorNowMs).toBe(pinnedMs);

    // fetchLaunchEvents(beach, now: Date)
    const [launchBeach, launchNow] = fetchLaunchEventsMock.mock.calls[0];
    expect(launchBeach).toEqual({ lat: LOC.lat, lon: LOC.lon });
    expect((launchNow as Date).getTime()).toBe(pinnedMs);

    // fetchKingTide(loc, nowMs)
    const [tideLoc, tideNowMs] = fetchKingTideMock.mock.calls[0];
    expect(tideLoc).toBe(LOC);
    expect(tideNowMs).toBe(pinnedMs);

    // buildComingUp({ tide, moon, meteor, launch, hourly, nowMs, tz, lat, lon })
    const buildArgs = buildComingUpMock.mock.calls[0][0];
    expect(buildArgs.nowMs).toBe(pinnedMs);
    expect(buildArgs.tz).toBe(LOC.timezone);
    expect(buildArgs.hourly).toEqual(snapshot.hourly.data ?? []);
    expect(buildArgs.lat).toBe(LOC.lat);
    expect(buildArgs.lon).toBe(LOC.lon);

    // The mocked buildComingUp's result lands on the snapshot split exactly
    // as returned: `card` -> skyEvents (the display card), `alertCandidates`
    // -> the separate, server-only skyAlertCandidates — never merged,
    // dropped, or swapped (Codex round-2 review HIGH #2).
    expect(snapshot.skyEvents).toBe(FAKE_CARD);
    // A fresh array (lib/conditions.ts copies it to satisfy the mutable
    // `SkyEvent[]` snapshot field type, §9), so content equality, not
    // reference identity, is what "lands untouched" means here.
    expect(snapshot.skyAlertCandidates).toEqual(FAKE_ALERT_CANDIDATES);
  });

  it("with a shared ambient budget below the 2-slot reserve, skips the launch + king-tide fetches but still builds the card from moon + meteor alone", async () => {
    mockCoreFetch();
    setDefaultSkyMocks();

    const budget = new SubrequestBudget(1); // < 2: not enough for both extra fetches
    const snapshot = await runWithBudget(budget, () => getSnapshotForLocation(LOC));

    expect(fetchLaunchEventsMock).not.toHaveBeenCalled();
    expect(fetchKingTideMock).not.toHaveBeenCalled();
    // Moon + meteor cost zero fetches — still always computed.
    expect(fetchMoonEventsMock).toHaveBeenCalledTimes(1);
    expect(fetchMeteorShowersMock).toHaveBeenCalledTimes(1);
    expect(buildComingUpMock).toHaveBeenCalledTimes(1);

    const buildArgs = buildComingUpMock.mock.calls[0][0];
    // The skipped feeds reach buildComingUp as honest "best-effort, no data"
    // placeholders — never silently omitted, never faked as "ok".
    expect(buildArgs.launch.status).toBe("best-effort");
    expect(buildArgs.launch.data).toBeNull();
    expect(buildArgs.tide.status).toBe("best-effort");
    expect(buildArgs.tide.data).toBeNull();

    // No real network fetch was ever attempted for the skipped feeds (the
    // budget gate is a pre-flight check, before any fetchWithTimeout call).
    expect(globalThis.fetch).not.toHaveBeenCalledWith(expect.stringContaining("king_tide_data.json"), expect.anything());
    expect(globalThis.fetch).not.toHaveBeenCalledWith(expect.stringContaining("launch_data.json"), expect.anything());
  });

  it("gates the launch + king-tide fetch on a read-only 2-slot reserve check, after the core sources have already spent their own share", async () => {
    mockCoreFetch();
    setDefaultSkyMocks();

    // Plenty for every core source (~20 adapters, 1 subrequest each in the
    // happy path) plus the 2 sky-event fetches — this isolates the "does it
    // check for exactly 2" behavior from "how many subrequests do the other
    // ~20 unrelated sources happen to spend", which is incidental to this
    // feature and would make a tight budget a flaky proxy for the real thing.
    const budget = new SubrequestBudget(1000);
    const reserveSpy = vi.spyOn(budget, "reserve");
    await runWithBudget(budget, () => getSnapshotForLocation(LOC));

    // The sky-feed gate's own reserve(2) check — read-only, never spends by
    // itself (lib/alerts/budget.ts's `reserve` doc comment).
    expect(reserveSpy.mock.calls.some(([n]) => n === 2)).toBe(true);
    expect(fetchLaunchEventsMock).toHaveBeenCalledTimes(1);
    expect(fetchKingTideMock).toHaveBeenCalledTimes(1);
  });

  it("passes each feed's real status through to buildComingUp unmodified — fresh, stale, and failed", async () => {
    mockCoreFetch();
    fetchMoonEventsMock.mockReturnValue(wrap<(MeteorSkyEvent | MoonSkyEvent)[]>([]));
    fetchMeteorShowersMock.mockReturnValue(wrap<MeteorSkyEvent[]>([]));
    buildComingUpMock.mockReturnValue(FAKE_RESULT);

    const freshTide = wrap<TideSkyEvent[]>([
      {
        eventType: "tide",
        tier: "validated",
        stationId: "8722670",
        datum: "STND",
        episode: { start: "2026-10-02T00:00:00Z", end: "2026-10-02T00:00:00Z" },
        heightFt: 34.5,
        rating: null,
        source: { feedGeneratedAt: "2026-10-01T00:00:00Z", validThrough: "2026-10-29T00:00:00Z" },
      },
    ]);
    const staleLaunch = wrap<LaunchSkyEvent[]>(null, {
      status: "best-effort",
      note: "launch feed stale (generated 2026-09-20T00:00:00Z)",
    });
    fetchKingTideMock.mockResolvedValue(freshTide);
    fetchLaunchEventsMock.mockResolvedValue(staleLaunch);

    await getSnapshotForLocation(LOC);

    const buildArgs = buildComingUpMock.mock.calls[0][0];
    expect(buildArgs.tide).toBe(freshTide);
    expect(buildArgs.launch).toBe(staleLaunch);
    expect(buildArgs.launch.status).toBe("best-effort");
    expect(buildArgs.launch.note).toContain("stale");

    // A hard failure (e.g. a network error the adapter itself converted to a
    // Wrapped error) also passes through unmodified.
    const failedTide = wrap<TideSkyEvent[]>(null, { status: "error", note: "network error" });
    fetchKingTideMock.mockResolvedValue(failedTide);
    await getSnapshotForLocation(LOC);
    const secondCallArgs = buildComingUpMock.mock.calls[1][0];
    expect(secondCallArgs.tide).toBe(failedTide);
    expect(secondCallArgs.tide.status).toBe("error");
  });

  it("a budget-aborted build never caches — sky data included — and skips the sky feeds it had no room for", async () => {
    setDefaultSkyMocks();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch should never be called — budget is exhausted");
    }) as unknown as typeof fetch;

    const budget = new SubrequestBudget(0);
    const result = await runWithBudget(budget, () => getConditions("boca-raton"));

    expect(result).not.toBeNull();
    expect(result!.budgetAborted).toBe(true);
    expect(cacheStore.has("conditions:boca-raton")).toBe(false);
    // Zero budget means canFetchSkyFeeds() refuses before ever calling the
    // adapter — the launch/tide feeds are skipped cleanly, not partially
    // attempted, matching every other source's degrade-gracefully behavior
    // under an exhausted budget.
    expect(fetchLaunchEventsMock).not.toHaveBeenCalled();
    expect(fetchKingTideMock).not.toHaveBeenCalled();
    // Moon + meteor are free (no fetch), so they still ran — and since
    // nothing was cached, this can never leave a PARTIAL sky-events result
    // sitting in the shared cache for the next visitor.
    expect(result!.snapshot.skyEvents).toBe(FAKE_CARD);
  });
});
