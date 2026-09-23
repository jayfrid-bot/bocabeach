import { describe, it, expect, vi, afterEach } from "vitest";
import { summarizeTraffic, fetchTraffic, type HereFlowResponse } from "@/lib/sources/traffic";
import type { Location } from "@/lib/types";

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

describe("fetchTraffic error note (Codex round-5 #2)", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.HERE_API_KEY;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.HERE_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("redacts to a fixed string, never the caught error's message (which may carry the request URL + apiKey)", async () => {
    process.env.HERE_API_KEY = "SECRET123";
    globalThis.fetch = vi.fn(async () => {
      // Mirrors what a real network-layer failure (or, pre-fix, a
      // SubrequestBudgetExhausted) can embed: the full request URL.
      throw new Error(
        "fetch failed: https://data.traffic.hereapi.com/v7/flow?in=circle:1,2;r=1000&apiKey=SECRET123",
      );
    }) as unknown as typeof fetch;

    const loc = { lat: 26.35, lon: -80.08, trafficRadiusKm: 2 } as Location;
    const result = await fetchTraffic(loc);

    expect(result.status).toBe("error");
    expect(result.note).toBe("Traffic data isn't available");
    expect(result.note).not.toContain("apiKey");
    expect(result.note).not.toContain("SECRET123");
    expect(result.note).not.toContain("?");
  });
});

describe("fetchTraffic note never leaks internal details (Codex LOW)", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.HERE_API_KEY;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.HERE_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("uses a fixed, generic note when HERE_API_KEY isn't configured — never the env var's own name", async () => {
    delete process.env.HERE_API_KEY;
    const loc = { lat: 26.35, lon: -80.08, trafficRadiusKm: 2 } as Location;
    const result = await fetchTraffic(loc);

    expect(result.status).toBe("best-effort");
    expect(result.data).toBeNull();
    expect(result.note).toBe("Traffic data isn't available");
    expect(result.note).not.toContain("HERE_API_KEY");
    expect(result.note).not.toContain("HERE");
  });

  it("uses the same fixed note when the key is rejected or throttled — never the HTTP status", async () => {
    process.env.HERE_API_KEY = "SECRET123";
    globalThis.fetch = vi.fn(async () => new Response("", { status: 429 })) as unknown as typeof fetch;
    const loc = { lat: 26.35, lon: -80.08, trafficRadiusKm: 2 } as Location;
    const result = await fetchTraffic(loc);

    expect(result.status).toBe("best-effort");
    expect(result.note).toBe("Traffic data isn't available");
  });

  it("uses the same fixed note when no road segments are in range", async () => {
    process.env.HERE_API_KEY = "SECRET123";
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const loc = { lat: 26.35, lon: -80.08, trafficRadiusKm: 2 } as Location;
    const result = await fetchTraffic(loc);

    expect(result.status).toBe("best-effort");
    expect(result.note).toBe("Traffic data isn't available");
  });

  it("carries no note at all on a healthy, known reading", async () => {
    process.env.HERE_API_KEY = "SECRET123";
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [{ currentFlow: { jamFactor: 2, confidence: 1 } }] }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    const loc = { lat: 26.35, lon: -80.08, trafficRadiusKm: 2 } as Location;
    const result = await fetchTraffic(loc);

    expect(result.status).toBe("ok");
    expect(result.note).toBeUndefined();
  });
});
