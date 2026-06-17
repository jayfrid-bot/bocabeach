import { describe, it, expect } from "vitest";
import { buildGeneratedContent } from "@/lib/admin/github";
import type { Location } from "@/lib/types";

const mk = (slug: string): Location => ({
  slug,
  name: slug,
  region: "FL",
  lat: 26,
  lon: -80,
  timezone: "America/New_York",
  noaaTideStationId: "1",
  ndbcBuoyId: "B",
  cams: [],
});

describe("buildGeneratedContent", () => {
  it("appends to an empty list and pretty-prints with a trailing newline", () => {
    const r = buildGeneratedContent([], mk("cocoa-beach-fl"));
    expect("duplicate" in r).toBe(false);
    if ("duplicate" in r) return;
    expect(r.next).toHaveLength(1);
    expect(r.next[0].slug).toBe("cocoa-beach-fl");
    expect(r.json.endsWith("\n")).toBe(true);
    expect(JSON.parse(r.json)).toHaveLength(1);
  });

  it("rejects a duplicate slug", () => {
    expect("duplicate" in buildGeneratedContent([mk("a")], mk("a"))).toBe(true);
  });

  it("preserves existing entries in order", () => {
    const r = buildGeneratedContent([mk("a"), mk("b")], mk("c"));
    if ("duplicate" in r) throw new Error("unexpected duplicate");
    expect(r.next.map((l) => l.slug)).toEqual(["a", "b", "c"]);
  });
});
