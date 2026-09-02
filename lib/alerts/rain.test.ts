// The rain read: radar first when the frame is fresh, the 15-minute forecast for
// the person's cell otherwise — and one fetch per cell per run, whoever is on it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { newRainCache, parseMinutely, rainForFix } from "@/lib/alerts/rain";
import type { PrecipRadarData, Wrapped } from "@/lib/types";

const NOW = Date.parse("2026-09-02T18:00:00Z");

function radar(
  over: Partial<PrecipRadarData> = {},
  status: Wrapped<PrecipRadarData>["status"] = "ok",
): Wrapped<PrecipRadarData> {
  return {
    source: "NOAA MRMS",
    status,
    fetchedAt: "2026-09-02T18:00:00Z",
    attribution: "NOAA MRMS",
    data: {
      rainNowMmHr: 0,
      nearestRainKm: null,
      nearestBearingDeg: null,
      coveragePct: null,
      motion: null,
      etaMinutes: null,
      frameIso: "2026-09-02T17:56:00Z",
      framesUsed: 2,
      frameAgeMinutes: 4,
      ...over,
    },
  };
}

/** An Open-Meteo minutely_15 payload starting at `startIso`, 15-minute steps. */
function minutely(startIso: string, rows: { precip?: number; prob?: number }[]) {
  const t0 = Date.parse(startIso);
  return {
    minutely_15: {
      time: rows.map((_, i) =>
        new Date(t0 + i * 15 * 60_000).toISOString().slice(0, 16),
      ),
      precipitation: rows.map((r) => r.precip ?? 0),
      precipitation_probability: rows.map((r) => r.prob ?? 0),
    },
  };
}

describe("parseMinutely", () => {
  it("finds the minutes until the first wet bucket", () => {
    const read = parseMinutely(
      minutely("2026-09-02T17:45:00Z", [{}, {}, { precip: 0.04 }, {}]),
      NOW,
    );
    expect(read).toMatchObject({ etaMinutes: 15, rainingNow: false, source: "forecast" });
  });

  it("counts a high probability as rain even with no measured precipitation", () => {
    const read = parseMinutely(minutely("2026-09-02T18:00:00Z", [{}, { prob: 75 }]), NOW);
    expect(read?.etaMinutes).toBe(15);
  });

  it("reads the bucket containing now as raining", () => {
    const read = parseMinutely(
      minutely("2026-09-02T17:55:00Z", [{ precip: 0.08 }, {}, {}, {}, {}]),
      NOW,
    );
    expect(read?.rainingNow).toBe(true);
    expect(read?.clearingSoon).toBe(false);
  });

  it("calls a dry hour ahead 'clearing'", () => {
    const read = parseMinutely(minutely("2026-09-02T18:00:00Z", [{}, {}, {}, {}, {}]), NOW);
    expect(read).toMatchObject({ clearingSoon: true, etaMinutes: null, rainingNow: false });
  });

  it("ignores rain beyond the hour", () => {
    const read = parseMinutely(
      minutely("2026-09-02T18:00:00Z", [{}, {}, {}, {}, { precip: 0.2 }, { precip: 0.2 }]),
      NOW,
    );
    expect(read?.etaMinutes).toBe(null);
    expect(read?.clearingSoon).toBe(true);
  });

  it("returns null when there is nothing usable", () => {
    expect(parseMinutely({}, NOW)).toBeNull();
    expect(parseMinutely({ minutely_15: { time: [] } }, NOW)).toBeNull();
  });
});

describe("rainForFix", () => {
  let calls: string[];

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify(minutely("2026-09-02T18:00:00Z", [{}, { precip: 0.1 }, {}, {}])),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a fresh radar frame and never touches the network", async () => {
    const read = await rainForFix(
      26.35,
      -80.07,
      "boca-raton",
      NOW,
      newRainCache(),
      radar({ rainNowMmHr: 2.1, etaMinutes: null }),
    );
    expect(read).toMatchObject({ rainingNow: true, source: "radar" });
    expect(calls).toEqual([]);
  });

  it("passes the radar ETA straight through", async () => {
    const read = await rainForFix(26.35, -80.07, "boca-raton", NOW, newRainCache(), radar({ etaMinutes: 18 }));
    expect(read).toMatchObject({ etaMinutes: 18, rainingNow: false, source: "radar" });
  });

  it("calls a dry radar box with no ETA 'clearing'", async () => {
    const read = await rainForFix(26.35, -80.07, "boca-raton", NOW, newRainCache(), radar());
    expect(read?.clearingSoon).toBe(true);
  });

  it("falls back to the forecast when the radar frame is stale", async () => {
    const read = await rainForFix(
      26.35,
      -80.07,
      "boca-raton",
      NOW,
      newRainCache(),
      radar({ frameAgeMinutes: 40 }, "stale"),
    );
    expect(read?.source).toBe("forecast");
    expect(calls).toHaveLength(1);
  });

  it("fetches once for two people standing in the same cell", async () => {
    const cache = newRainCache();
    const a = await rainForFix(26.3512, -80.0701, "boca-raton", NOW, cache, null);
    const b = await rainForFix(26.3549, -80.0788, "deerfield-beach", NOW, cache, null);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("fetches once per cell for people three miles apart", async () => {
    const cache = newRainCache();
    await rainForFix(26.35, -80.07, "boca-raton", NOW, cache, null);
    await rainForFix(26.46, -80.07, "delray-beach", NOW, cache, null);
    expect(calls).toHaveLength(2);
  });

  it("asks about the cell centre, not the person's exact spot", async () => {
    await rainForFix(26.3512, -80.0701, "boca-raton", NOW, newRainCache(), null);
    expect(calls[0]).toContain("latitude=26.375");
    expect(calls[0]).toContain("longitude=-80.075");
  });

  it("returns null instead of throwing when the fetch fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const read = await rainForFix(26.35, -80.07, "boca-raton", NOW, newRainCache(), null);
    expect(read).toBeNull();
  });

  it("returns null on a bad response", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    const read = await rainForFix(26.35, -80.07, "boca-raton", NOW, newRainCache(), null);
    expect(read).toBeNull();
  });
});
