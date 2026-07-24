import { describe, it, expect } from "vitest";
import { CHANGELOG, type ChangelogTag } from "@/lib/changelog";

const VALID_TAGS: ChangelogTag[] = ["new", "improved", "fixed"];

describe("CHANGELOG", () => {
  it("has entries", () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
  });

  it("every date parses as a valid YYYY-MM-DD date", () => {
    for (const entry of CHANGELOG) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(new Date(entry.date).getTime())).toBe(false);
    }
  });

  it("is sorted newest first", () => {
    for (let i = 1; i < CHANGELOG.length; i++) {
      const prev = CHANGELOG[i - 1].date;
      const cur = CHANGELOG[i].date;
      expect(prev >= cur).toBe(true);
    }
  });

  it("every tag, when present, is one of the known values", () => {
    for (const entry of CHANGELOG) {
      if (entry.tag !== undefined) {
        expect(VALID_TAGS).toContain(entry.tag);
      }
    }
  });

  it("every entry has a non-empty title", () => {
    for (const entry of CHANGELOG) {
      expect(entry.title.trim().length).toBeGreaterThan(0);
    }
  });
});
