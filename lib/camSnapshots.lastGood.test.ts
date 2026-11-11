import { describe, expect, it } from "vitest";
import { feedLastGood, metaLastGood } from "@/lib/camSnapshots";

// What a feed or meta answer proves about a cam (lib/camStatus.ts): null hides it,
// undefined keeps it shown. Only a real feed list missing the view may hide it.

const REAL = { s4: { hr: "pics/s4/a.jpg", mr: "pics/s4/a_.jpg", timestamp: 1_793_990_000 } };

describe("feedLastGood", () => {
  it("reads the view's capture time", () => {
    expect(feedLastGood(REAL, "s4")).toBe(new Date(1_793_990_000_000).toISOString());
  });
  it("a real feed list without the view: dropped (null)", () => {
    expect(feedLastGood(REAL, "s9")).toBeNull();
  });
  it("a view that is present, even as null or without a time: unknown (shown)", () => {
    expect(feedLastGood({ ...REAL, s9: null }, "s9")).toBeUndefined();
    expect(feedLastGood({ ...REAL, s9: { mr: "x_.jpg" } }, "s9")).toBeUndefined();
  });
  it("an odd document is not a feed list: unknown (shown)", () => {
    expect(feedLastGood({ error: "rate limited" }, "s4")).toBeUndefined();
    expect(feedLastGood({ s1: "nope", s2: { timestamp: 1 } }, "s4")).toBeUndefined();
    expect(feedLastGood({}, "s4")).toBeUndefined();
    expect(feedLastGood([], "s4")).toBeUndefined();
    expect(feedLastGood("text", "s4")).toBeUndefined();
  });
  it("an inherited name is not the view", () => {
    expect(feedLastGood(REAL, "toString")).toBeNull();
  });
});

describe("metaLastGood", () => {
  it("ok:true time, ok:false none, anything else unknown", () => {
    expect(metaLastGood({ ok: true, grabbedAtUtc: "2026-11-06T18:00:00Z" })).toBe("2026-11-06T18:00:00.000Z");
    expect(metaLastGood({ ok: false, grabbedAtUtc: null })).toBeNull();
    expect(metaLastGood({})).toBeUndefined();
  });
});
