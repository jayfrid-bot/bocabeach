import { describe, it, expect } from "vitest";
import { summarizeTraffic, type HereFlowResponse } from "@/lib/sources/traffic";

const flow = (jamFactor: number, confidence?: number) => ({
  currentFlow: { jamFactor, confidence },
});

describe("summarizeTraffic", () => {
  it("confidence-weighted mean → level + 0-100 congestion", () => {
    // jam 2 and 6 (equal confidence) → mean 4 → heavy, 40% congestion
    const d = summarizeTraffic({ results: [flow(2, 1), flow(6, 1)] });
    expect(d).toEqual({ level: "heavy", congestion: 40, segments: 2 });
  });

  it("weights low-confidence segments down", () => {
    // (1*0.9 + 9*0.1)/1.0 = 1.8 → light, 18%
    const d = summarizeTraffic({ results: [flow(1, 0.9), flow(9, 0.1)] });
    expect(d.level).toBe("light");
    expect(d.congestion).toBe(18);
  });

  it("drops unknown (-1) and absent jamFactor segments", () => {
    const d = summarizeTraffic({
      results: [flow(-1, 1), { currentFlow: { confidence: 1 } }, flow(8, 1)],
    });
    expect(d.segments).toBe(1);
    expect(d.level).toBe("severe");
  });

  it("falls back to a plain mean when confidence is absent/zero (jam 4 → heavy boundary)", () => {
    const d = summarizeTraffic({
      results: [{ currentFlow: { jamFactor: 4 } }, { currentFlow: { jamFactor: 4, confidence: 0 } }],
    });
    expect(d.congestion).toBe(40);
    expect(d.level).toBe("heavy");
  });

  it("returns unknown for empty / missing results (no throw)", () => {
    const empty = { level: "unknown", congestion: undefined, segments: 0 };
    expect(summarizeTraffic({ results: [] })).toEqual(empty);
    expect(summarizeTraffic({} as HereFlowResponse)).toEqual(empty);
  });

  it("scores a jammed area as severe", () => {
    const d = summarizeTraffic({ results: [flow(8.5, 1), flow(9, 1)] });
    expect(d.level).toBe("severe");
    expect(d.congestion).toBeGreaterThanOrEqual(80);
  });
});
