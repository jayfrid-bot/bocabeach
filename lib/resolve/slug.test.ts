import { describe, it, expect } from "vitest";
import { toSlug, uniqueSlug } from "@/lib/resolve/slug";

describe("toSlug", () => {
  it("lowercases and replaces spaces with dashes", () => {
    expect(toSlug("Boca Raton")).toBe("boca-raton");
    expect(toSlug("Fort Lauderdale Beach")).toBe("fort-lauderdale-beach");
  });

  it("strips punctuation", () => {
    expect(toSlug("St. Augustine")).toBe("st-augustine");
    expect(toSlug("O'Brien's Cove")).toBe("o-brien-s-cove");
    expect(toSlug("Folly Beach, SC")).toBe("folly-beach-sc");
  });

  it("collapses runs of separators into a single dash and trims edges", () => {
    expect(toSlug("  Palm   Beach  ")).toBe("palm-beach");
    expect(toSlug("Sea--Isle__City")).toBe("sea-isle-city");
    expect(toSlug("--Edge--")).toBe("edge");
  });

  it("strips accents to ASCII", () => {
    expect(toSlug("Cañón Beach")).toBe("canon-beach");
    expect(toSlug("Île de Ré")).toBe("ile-de-re");
  });

  it("keeps digits", () => {
    expect(toSlug("Beach 90")).toBe("beach-90");
  });
});

describe("uniqueSlug", () => {
  it("returns the plain slug when there is no collision", () => {
    expect(uniqueSlug("Boca Raton", [])).toBe("boca-raton");
    expect(uniqueSlug("Boca Raton", ["miami-beach"])).toBe("boca-raton");
  });

  it("appends the state suffix on collision when provided", () => {
    expect(uniqueSlug("South Beach", ["south-beach"], "FL")).toBe("south-beach-fl");
  });

  it("falls back to numeric suffixes when no state is given", () => {
    expect(uniqueSlug("South Beach", ["south-beach"])).toBe("south-beach-2");
    expect(uniqueSlug("South Beach", ["south-beach", "south-beach-2"])).toBe(
      "south-beach-3",
    );
  });

  it("uses numeric suffixes when even the state-suffixed slug is taken", () => {
    expect(
      uniqueSlug("South Beach", ["south-beach", "south-beach-fl"], "FL"),
    ).toBe("south-beach-2");
    expect(
      uniqueSlug("South Beach", ["south-beach", "south-beach-fl", "south-beach-2"], "FL"),
    ).toBe("south-beach-3");
  });

  it("compares against taken slugs case-insensitively", () => {
    expect(uniqueSlug("South Beach", ["SOUTH-BEACH"])).toBe("south-beach-2");
  });
});
