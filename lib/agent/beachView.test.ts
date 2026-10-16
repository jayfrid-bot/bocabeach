import { describe, expect, it } from "vitest";
import { compactConditions, summarize, toBeachConditions } from "@/lib/agent/beachView";
import type { WatchView } from "@/lib/watchView";

const view = (over: Partial<WatchView> = {}): WatchView => ({
  v: 1,
  slug: "boca-raton",
  name: "Boca Raton",
  score: 78,
  rating: "Good",
  band: "good",
  limitedData: false,
  lines: [
    { kind: "safety", text: "Double red flag", tone: "danger" },
    { kind: "water", text: "Water 82°F", tone: "calm" },
    { kind: "best", text: "Best 4–6 PM", tone: "calm" },
  ],
  waterTempF: 82,
  sunForecast: {
    kind: "sunset",
    state: "pending",
    availableAt: "2026-10-14T21:52:00.000Z",
    eventAt: "2026-10-14T22:52:00.000Z",
    text: "Sunset forecast at 5:52 PM",
  },
  generatedAt: "2026-10-14T15:00:00.000Z",
  capturedAt: "2026-10-14T15:01:00.000Z",
  validUntil: "2026-10-14T15:15:00.000Z",
  ...over,
});

describe("summarize", () => {
  it("reads as one sentence per fact", () => {
    expect(summarize(view())).toBe("Boca Raton: 78/100 (Good). Double red flag. Water 82°F. Best 4–6 PM.");
  });
  it("says so when there is no score", () => {
    expect(summarize(view({ score: null, rating: null, lines: [] }))).toBe("Boca Raton: no usable score right now.");
  });
  it("explains a +N more line", () => {
    const s = summarize(view({ lines: [{ kind: "more", text: "+2 more", tone: "danger" }] }));
    expect(s).toContain("2 more safety notices are not listed here");
  });
});

describe("toBeachConditions", () => {
  it("adds the link, best time, attribution and safety note", () => {
    const c = toBeachConditions(view())!;
    expect(c.url).toBe("https://isitbeachday.com/");
    expect(c.bestTime).toBe("4–6 PM");
    expect(c.updatedAt).toBe("2026-10-14T15:00:00.000Z");
    expect(c.safetyNote).toMatch(/always win/);
    expect(c.attribution.credit).toMatch(/isitbeachday\.com$/);
  });
  it("passes the sun forecast through: the state and the line, never a color score", () => {
    const c = toBeachConditions(view())!;
    expect(c.sunForecast).toMatchObject({ kind: "sunset", state: "pending", text: "Sunset forecast at 5:52 PM" });
    expect(c.sunForecast).not.toHaveProperty("score");
    expect(c).not.toHaveProperty("sunScore");
    expect(toBeachConditions(view({ sunForecast: null }))!.sunForecast).toBeNull();
  });
  it("has no best time when the line says there is no good window", () => {
    expect(toBeachConditions(view({ lines: [{ kind: "best", text: "No good window today", tone: "calm" }] }))!.bestTime).toBeNull();
  });
  it("falls back to capturedAt when the snapshot time is unknown", () => {
    expect(toBeachConditions(view({ generatedAt: null }))!.updatedAt).toBe("2026-10-14T15:01:00.000Z");
  });
  it("returns null for a beach the directory does not know", () => {
    expect(toBeachConditions(view({ slug: "atlantis" }))).toBeNull();
  });
});

describe("compactConditions", () => {
  it("flags a danger-level line", () => {
    expect(compactConditions(toBeachConditions(view())!).hasDangerAlert).toBe(true);
    expect(compactConditions(toBeachConditions(view({ lines: [{ kind: "water", text: "Water 80°F", tone: "calm" }] }))!).hasDangerAlert).toBe(false);
  });
});
