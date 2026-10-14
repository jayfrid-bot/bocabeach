import { describe, it, expect } from "vitest";
import { pickCamGroup } from "@/lib/camGroup";

const g = (name: string, ok: boolean) => ({ capturedAtLocal: name, cams: ok ? [{ ok: true }] : [{ ok: false }] });
const has = (x: { cams?: unknown[] }) => (x.cams ?? []).some((c) => (c as { ok: boolean }).ok);

describe("pickCamGroup — newest group with a usable reading", () => {
  it("prefers latest, then lastSeaweed, then morning", () => {
    expect(pickCamGroup({ latest: g("L", true), lastSeaweed: g("S", true), morning: g("M", true) }, has)?.source).toBe("latest");
    expect(pickCamGroup({ latest: g("L", false), lastSeaweed: g("S", true), morning: g("M", true) }, has)?.source).toBe("lastSeaweed");
    expect(pickCamGroup({ latest: g("L", false), lastSeaweed: g("S", false), morning: g("M", true) }, has)?.source).toBe("morning");
  });

  it("returns the chosen group itself (its own capture time)", () => {
    const s = g("S", true);
    expect(pickCamGroup({ latest: g("L", false), lastSeaweed: s }, has)?.group).toBe(s);
  });

  it("is null when no group qualifies, or the feed is empty / missing", () => {
    expect(pickCamGroup({ latest: g("L", false), morning: null }, has)).toBeNull();
    expect(pickCamGroup({}, has)).toBeNull();
    expect(pickCamGroup(null, has)).toBeNull();
    expect(pickCamGroup(undefined, has)).toBeNull();
  });
});
