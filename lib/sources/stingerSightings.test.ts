import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStingerSightings } from "@/lib/sources/stingerSightings";

// Boca Raton, for realistic distances.
const LAT = 26.3587;
const LON = -80.0686;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { date: new Date().toUTCString() },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchStingerSightings", () => {
  it("parses count, most-recent date, and nearest distance from a populated response", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return jsonResponse({
          total_results: 3,
          results: [
            // ~1 degree of latitude north (~111 km away), observed 2 days ago.
            {
              observed_on: "2026-07-19",
              geojson: { type: "Point", coordinates: [LON, LAT + 1] },
            },
            // Right at the beach, observed 5 days ago — the nearest report.
            {
              observed_on: "2026-07-16",
              geojson: { type: "Point", coordinates: [LON, LAT] },
            },
            // No location published (geoprivacy-obscured) — still counts,
            // but can't contribute to nearestKm.
            { observed_on: "2026-07-10", geojson: null },
          ],
        });
      }),
    );

    const now = new Date("2026-07-21T12:00:00.000Z");
    const result = await fetchStingerSightings(LAT, LON, { now });

    expect(result).not.toBeNull();
    expect(result!.count).toBe(3);
    expect(result!.mostRecentIso).toBe("2026-07-19"); // newest observed_on, not first in the array
    expect(result!.nearestKm).toBeCloseTo(0, 1); // the co-located observation
    expect(result!.withinDays).toBe(14);

    // Sanity-check the request shape: correct taxon, coordinates, and date bound.
    expect(capturedUrl).toContain("taxon_id=117302");
    expect(capturedUrl).toContain(`lat=${LAT}`);
    expect(capturedUrl).toContain(`lng=${LON}`);
    expect(capturedUrl).toContain("radius=100");
    expect(capturedUrl).toContain("d1=2026-07-07"); // 14 days before `now`
  });

  it("picks the nearest observation, not the first one, when distances differ", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          results: [
            { observed_on: "2026-07-20", geojson: { coordinates: [LON, LAT + 1] } }, // ~111 km
            { observed_on: "2026-07-18", geojson: { coordinates: [LON + 0.1, LAT] } }, // ~10 km
          ],
        }),
      ),
    );
    const result = await fetchStingerSightings(LAT, LON);
    expect(result!.nearestKm).toBeLessThan(15);
    expect(result!.nearestKm).toBeGreaterThan(5);
  });

  it("returns count 0 (not null) for a genuinely empty result set", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ total_results: 0, results: [] })));
    const result = await fetchStingerSightings(LAT, LON);
    expect(result).not.toBeNull();
    expect(result!.count).toBe(0);
    expect(result!.mostRecentIso).toBeUndefined();
    expect(result!.nearestKm).toBeUndefined();
  });

  it("returns null (unavailable) for a 200 body that lacks a results ARRAY — never a fabricated count:0", async () => {
    // Schema-invalid successful responses must not read as "checked, nothing
    // nearby" (which would damp the man-o'-war risk). count:0 is reserved for a
    // genuinely empty `results: []`.
    for (const body of [{ total_results: 5 }, { results: "boom" }, { results: null }, {}]) {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body)));
      const result = await fetchStingerSightings(LAT, LON);
      expect(result).toBeNull();
    }
  });

  it("returns null on a non-200 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "rate limited" }, 429)));
    const result = await fetchStingerSightings(LAT, LON);
    expect(result).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>not json</html>", {
            status: 200,
            headers: { date: new Date().toUTCString() },
          }),
      ),
    );
    const result = await fetchStingerSightings(LAT, LON);
    expect(result).toBeNull();
  });

  it("returns null when the fetch itself throws (network error / timeout)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const result = await fetchStingerSightings(LAT, LON);
    expect(result).toBeNull();
  });

  it("ignores observations with unparsable dates or malformed coordinates rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          results: [
            { observed_on: "not-a-date", geojson: null },
            { observed_on: "2026-07-15", geojson: { coordinates: "nope" as unknown as [number, number] } },
            { observed_on: null, geojson: undefined },
          ],
        }),
      ),
    );
    const result = await fetchStingerSightings(LAT, LON);
    expect(result).not.toBeNull();
    expect(result!.count).toBe(3);
    expect(result!.mostRecentIso).toBe("2026-07-15");
    expect(result!.nearestKm).toBeUndefined(); // no observation had usable coordinates
  });

  it("respects a custom daysBack/radiusKm/perPage in the request", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return jsonResponse({ results: [] });
      }),
    );
    const now = new Date("2026-07-21T00:00:00.000Z");
    await fetchStingerSightings(LAT, LON, { daysBack: 30, radiusKm: 50, perPage: 10, now });
    expect(capturedUrl).toContain("radius=50");
    expect(capturedUrl).toContain("per_page=10");
    expect(capturedUrl).toContain("d1=2026-06-21");
  });
});
