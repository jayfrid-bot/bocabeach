import { describe, it, expect } from "vitest";
import { summarizeSargassum, type SargassumFeed } from "@/lib/sources/sargassum";

const BOCA = { lat: 26.3587, lon: -80.0686 };
const NOW = Date.parse("2026-06-03T12:00:00.000Z");

function feed(segments: [number, number, number][]): SargassumFeed {
  return { generatedAt: "2026-06-03T12:00:00Z", sourceDate: "20260602", segments };
}

describe("summarizeSargassum", () => {
  it("maps the nearest coastline segment's risk to a category", () => {
    const d = summarizeSargassum(
      feed([
        [26.36, -80.07, 2], // ~0.6 mi from Boca -> the match
        [25.0, -80.3, 3], // far south, higher risk -> ignored
      ]),
      BOCA.lat,
      BOCA.lon,
      NOW,
    );
    expect(d.risk).toBe("moderate");
    expect(d.riskLevel).toBe(2);
    expect(d.nearestMi).toBeLessThan(2);
    expect(d.dataAgeDays).toBe(1); // 20260602 vs 2026-06-03
  });

  it("returns 'unknown' when the nearest segment is too far away", () => {
    const d = summarizeSargassum(feed([[20.0, -75.0, 3]]), BOCA.lat, BOCA.lon, NOW);
    expect(d.risk).toBe("unknown");
    expect(d.riskLevel).toBe(-1);
  });

  it("handles an empty feed", () => {
    const d = summarizeSargassum(feed([]), BOCA.lat, BOCA.lon, NOW);
    expect(d.risk).toBe("unknown");
    expect(d.nearestMi).toBeUndefined();
  });
});
