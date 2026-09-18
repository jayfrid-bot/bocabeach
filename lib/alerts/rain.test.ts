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

describe("parseMinutely — a value is the accumulation ENDING at its timestamp (LOC-10)", () => {
  it("reads the bucket that contains now as raining: the 18:15 value covers 18:00–18:15", () => {
    const read = parseMinutely(minutely("2026-09-02T18:00:00Z", [{}, { precip: 0.08 }, {}, {}, {}, {}]), NOW);
    expect(read).toMatchObject({ rainingNow: true, etaMinutes: null, clearingSoon: false });
  });

  it("the report's fixture: at 13:05, a wet 13:15 value is rain NOW, not rain in 10 minutes", () => {
    const at = Date.parse("2026-09-02T13:05:00Z");
    const read = parseMinutely(
      minutely("2026-09-02T13:00:00Z", [{}, { precip: 0.05 }, {}, {}, {}, {}]),
      at,
    );
    expect(read).toMatchObject({ rainingNow: true, etaMinutes: null });
  });

  it("finds the minutes until the START of the first wet bucket ahead", () => {
    // 18:30 value covers 18:15–18:30 → rain starts 15 minutes out.
    const read = parseMinutely(minutely("2026-09-02T18:00:00Z", [{}, {}, { precip: 0.04 }, {}, {}, {}]), NOW);
    expect(read).toMatchObject({ etaMinutes: 15, rainingNow: false, clearingSoon: false, source: "forecast" });
  });

  it("interior of a bucket: 18:07 still belongs to the 18:15 value", () => {
    const at = Date.parse("2026-09-02T18:07:00Z");
    const read = parseMinutely(minutely("2026-09-02T18:00:00Z", [{}, { prob: 80 }, {}, {}, {}, {}]), at);
    expect(read?.rainingNow).toBe(true);
  });

  it("boundary: a value stamped exactly now is the interval that just ENDED, not the current one", () => {
    // 18:00 value covers 17:45–18:00 (elapsed). 18:15 value is current and dry.
    const read = parseMinutely(
      minutely("2026-09-02T18:00:00Z", [{ precip: 0.3 }, {}, {}, {}, {}, {}]),
      NOW,
    );
    expect(read?.rainingNow).toBe(false);
  });

  it("counts a high probability as rain even with no measured precipitation", () => {
    const read = parseMinutely(minutely("2026-09-02T18:00:00Z", [{}, {}, { prob: 75 }, {}, {}]), NOW);
    expect(read?.etaMinutes).toBe(15);
  });

  it("crosses UTC midnight without losing the mapping or the horizon", () => {
    const at = Date.parse("2026-09-02T23:50:00Z");
    // 00:00 value covers 23:45–00:00 (current); 00:15…01:00 cover the hour ahead.
    const read = parseMinutely(minutely("2026-09-02T23:45:00Z", [{}, {}, {}, {}, {}, {}, {}]), at);
    expect(read).toMatchObject({ rainingNow: false, clearingSoon: true, horizonKnown: true });
    const wetAfterMidnight = parseMinutely(
      minutely("2026-09-02T23:45:00Z", [{}, {}, { precip: 0.1 }, {}, {}, {}, {}]),
      at,
    );
    // 00:15 value covers 00:00–00:15 → 10 minutes out.
    expect(wetAfterMidnight).toMatchObject({ rainingNow: false, etaMinutes: 10, clearingSoon: false });
  });
});

describe("parseMinutely — unknown is unknown, never 'clearing' (LOC-11)", () => {
  it("calls a fully known dry hour ahead 'clearing'", () => {
    const read = parseMinutely(minutely("2026-09-02T18:00:00Z", [{}, {}, {}, {}, {}, {}]), NOW);
    expect(read).toMatchObject({ clearingSoon: true, etaMinutes: null, rainingNow: false, horizonKnown: true });
  });

  it("ignores rain beyond the hour when the hour itself is known and dry", () => {
    // 18:15…19:00 dry (covers 18:00–19:00); 19:15 and 19:30 wet.
    const read = parseMinutely(
      minutely("2026-09-02T18:00:00Z", [{}, {}, {}, {}, {}, { precip: 0.2 }, { precip: 0.2 }]),
      NOW,
    );
    expect(read?.etaMinutes).toBe(null);
    expect(read?.clearingSoon).toBe(true);
  });

  it("A: future timestamps with neither precipitation nor probability arrays → nothing usable", () => {
    const t0 = Date.parse("2026-09-02T18:00:00Z");
    const time = [0, 1, 2, 3, 4, 5].map((i) => new Date(t0 + i * 15 * 60_000).toISOString().slice(0, 16));
    expect(parseMinutely({ minutely_15: { time } }, NOW)).toBeNull();
  });

  it("B: a single upcoming dry bucket cannot establish a dry hour", () => {
    const read = parseMinutely(minutely("2026-09-02T18:00:00Z", [{}, {}]), NOW);
    expect(read).toMatchObject({ rainingNow: false, clearingSoon: false, horizonKnown: false });
  });

  it("a null inside the hour leaves the horizon unknown", () => {
    const payload = minutely("2026-09-02T18:00:00Z", [{}, {}, {}, {}, {}, {}]);
    payload.minutely_15.precipitation[3] = null as unknown as number;
    payload.minutely_15.precipitation_probability[3] = null as unknown as number;
    const read = parseMinutely(payload, NOW);
    expect(read).toMatchObject({ clearingSoon: false, horizonKnown: false });
  });

  it("a gap in the timestamps leaves the horizon unknown", () => {
    const payload = minutely("2026-09-02T18:00:00Z", [{}, {}, {}, {}, {}, {}]);
    payload.minutely_15.time.splice(3, 1); // drop 18:45
    payload.minutely_15.precipitation.splice(3, 1);
    payload.minutely_15.precipitation_probability.splice(3, 1);
    const read = parseMinutely(payload, NOW);
    expect(read?.clearingSoon).toBe(false);
  });

  it("a feed truncated at the day's end cannot promise a clear hour", () => {
    const at = Date.parse("2026-09-02T23:50:00Z");
    // Ends at the 00:00 value: the current bucket is known, nothing beyond.
    const read = parseMinutely(minutely("2026-09-03T00:00:00Z", [{}]), at);
    expect(read).toMatchObject({ rainingNow: false, clearingSoon: false, horizonKnown: false });
  });

  it("a wet bucket after a gap still yields an ETA — it is real information", () => {
    const payload = minutely("2026-09-02T18:00:00Z", [{}, {}, {}, { precip: 0.2 }, {}, {}]);
    payload.minutely_15.precipitation[2] = null as unknown as number;
    payload.minutely_15.precipitation_probability[2] = null as unknown as number;
    const read = parseMinutely(payload, NOW);
    // 18:45 value covers 18:30–18:45 → 30 minutes out.
    expect(read).toMatchObject({ etaMinutes: 30, clearingSoon: false });
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
        JSON.stringify(minutely("2026-09-02T18:00:00Z", [{}, {}, { precip: 0.1 }, {}])),
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
    // The raw forecast (and cell) is shared, but the anchor is honestly built
    // per caller from THEIR OWN fix — not the fix of whoever happened to
    // populate the cache first (Codex round-2 #1).
    const { anchor: anchorA, ...restA } = a as NonNullable<typeof a>;
    const { anchor: anchorB, ...restB } = b as NonNullable<typeof b>;
    expect(restA).toEqual(restB);
    expect(anchorA).toMatchObject({ kind: "point", lat: 26.3512, lon: -80.0701 });
    expect(anchorB).toMatchObject({ kind: "point", lat: 26.3549, lon: -80.0788 });
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

  it("two beaches sharing a cell each get their OWN radar hold, not each other's (Codex round-2 #1)", async () => {
    // frameAgeMinutes 40 > PRECIP_RADAR_STALE_MINUTES (25): both beaches fall
    // to the cell-forecast path and land in the SAME cell cache entry, but
    // assessRain's hold only cares about wetMinutesAgo <= 20, independent of
    // frame freshness.
    const wetRadar = radar({ rainNowMmHr: 0, wetMinutesAgo: 10, frameAgeMinutes: 40 });
    const dryRadar = radar({ rainNowMmHr: 0, wetMinutesAgo: null, frameAgeMinutes: 40 });

    for (const order of [
      ["wet", "dry"],
      ["dry", "wet"],
    ] as const) {
      const cache = newRainCache();
      const results: Record<string, Awaited<ReturnType<typeof rainForFix>>> = {};
      for (const which of order) {
        results[which] = await rainForFix(
          26.3512,
          -80.0701,
          which === "wet" ? "wet-beach" : "dry-beach",
          NOW,
          cache,
          which === "wet" ? wetRadar : dryRadar,
        );
      }
      expect(results.wet).toMatchObject({ hazardActive: true, latched: true });
      expect(results.dry).not.toMatchObject({ hazardActive: true });
    }
  });
});

describe("rainForFix — a lost forecast must not cost a still-valid radar latch (Codex round-2 #2)", () => {
  it("forecast throws but radar was wet 10 minutes ago: still hazardActive+latched, ETA null", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const read = await rainForFix(
      26.35,
      -80.07,
      "boca-raton",
      NOW,
      newRainCache(),
      radar({ rainNowMmHr: 0, wetMinutesAgo: 10 }, "stale"),
    );
    expect(read).toMatchObject({ hazardActive: true, latched: true, etaMinutes: null });
  });

  it("forecast throws and there is no radar latch: null, as before", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const read = await rainForFix(26.35, -80.07, "boca-raton", NOW, newRainCache(), null);
    expect(read).toBeNull();
  });
});
