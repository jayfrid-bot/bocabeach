import { describe, it, expect } from "vitest";
import { SCORING_ENGINE_VERSION } from "@/lib/score";
import {
  compareEngineVersions,
  findScoringVersion,
  LATEST_SCORING_VERSION,
  SCORING_VERSIONS,
} from "@/lib/scoringVersions";

describe("SCORING_VERSIONS", () => {
  // The CI guard: bumping SCORING_ENGINE_VERSION in lib/score.ts without
  // adding a dated note to lib/scoringVersions.ts fails here.
  it("ends with the current SCORING_ENGINE_VERSION", () => {
    expect(SCORING_VERSIONS[SCORING_VERSIONS.length - 1].version).toBe(SCORING_ENGINE_VERSION);
    expect(LATEST_SCORING_VERSION.version).toBe(SCORING_ENGINE_VERSION);
  });

  it("lists each version once, in order, with a valid date and a non-empty note", () => {
    const seen = new Set<string>();
    SCORING_VERSIONS.forEach((v, i) => {
      expect(seen.has(v.version)).toBe(false);
      seen.add(v.version);
      expect(v.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(v.note.trim().length).toBeGreaterThan(0);
      if (i > 0) {
        expect(v.since >= SCORING_VERSIONS[i - 1].since).toBe(true);
        expect(compareEngineVersions(SCORING_VERSIONS[i - 1].version, v.version)).toBeLessThan(0);
      }
    });
  });

  it("each note stays plain: no jargon word", () => {
    for (const v of SCORING_VERSIONS) expect(v.note).not.toMatch(/\bAI\b/);
  });
});

describe("compareEngineVersions", () => {
  it("is negative for older, positive for newer, zero for equal", () => {
    expect(compareEngineVersions("2026-09-28.1", "2026-09-28.2")).toBeLessThan(0);
    expect(compareEngineVersions("2026-10-09.1", "2026-10-06.1")).toBeGreaterThan(0);
    expect(compareEngineVersions("2026-10-09.1", "2026-10-09.1")).toBe(0);
  });

  it("orders by the list position for listed versions", () => {
    const first = SCORING_VERSIONS[0].version;
    const last = SCORING_VERSIONS[SCORING_VERSIONS.length - 1].version;
    expect(compareEngineVersions(first, last)).toBeLessThan(0);
    expect(compareEngineVersions(last, first)).toBeGreaterThan(0);
  });

  it("falls back to string order when a version is not listed", () => {
    expect(compareEngineVersions("2026-01-01.1", "2026-10-09.1")).toBeLessThan(0);
    expect(compareEngineVersions("2027-01-01.1", "2026-10-09.1")).toBeGreaterThan(0);
  });

  it("sorts a mixed list oldest first", () => {
    expect(["2026-10-09.1", "2026-09-22.1", "2026-10-06.1"].sort(compareEngineVersions)).toEqual([
      "2026-09-22.1",
      "2026-10-06.1",
      "2026-10-09.1",
    ]);
  });
});

describe("findScoringVersion", () => {
  it("finds a listed version and returns null for an unknown one", () => {
    expect(findScoringVersion("2026-10-09.1")?.since).toBe("2026-10-09");
    expect(findScoringVersion("nope")).toBeNull();
  });
});
