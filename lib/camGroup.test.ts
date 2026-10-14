import { describe, it, expect } from "vitest";
import { pickCamGroup, groupLocalDate, type CamGroupSource } from "@/lib/camGroup";

const g = (capturedAtLocal: string, ok: boolean) => ({ capturedAtLocal, cams: [{ ok }] });
const has = (x: { cams?: unknown[] }) => (x.cams ?? []).some((c) => (c as { ok: boolean }).ok);
const SEAWEED: CamGroupSource[] = ["latest", "lastSeaweed", "morning"];
const WATER: CamGroupSource[] = ["latest", "lastWater", "morning"];
const TODAY = "2026-10-13";
const at = (hhmm: string, day = TODAY) => `${day}T${hhmm}-04:00`;

describe("pickCamGroup — newest group with a usable reading", () => {
  it("prefers latest, then the named last-group, then morning", () => {
    const all = { latest: g(at("19:10"), true), lastSeaweed: g(at("17:30"), true), morning: g(at("08:40"), true) };
    expect(pickCamGroup(all, SEAWEED, has)?.source).toBe("latest");
    expect(pickCamGroup({ ...all, latest: g(at("19:10"), false) }, SEAWEED, has)?.source).toBe("lastSeaweed");
    expect(pickCamGroup({ ...all, latest: g(at("19:10"), false), lastSeaweed: g(at("17:30"), false) }, SEAWEED, has)?.source).toBe("morning");
  });

  it("only looks at the sources it is given: water never reads lastSeaweed, seaweed never lastWater", () => {
    const feed = { latest: g(at("19:10"), false), lastSeaweed: g(at("17:30"), true), lastWater: g(at("16:00"), true) };
    expect(pickCamGroup(feed, WATER, has)?.group).toBe(feed.lastWater);
    expect(pickCamGroup(feed, SEAWEED, has)?.group).toBe(feed.lastSeaweed);
    expect(pickCamGroup({ latest: g(at("19:10"), false), lastSeaweed: g(at("17:30"), true) }, WATER, has)).toBeNull();
  });

  it("returns the chosen group itself (its own capture time)", () => {
    const s = g(at("17:30"), true);
    expect(pickCamGroup({ latest: g(at("19:10"), false), lastSeaweed: s }, SEAWEED, has)?.group).toBe(s);
  });

  it("is null when no group qualifies, or the feed is empty / missing", () => {
    expect(pickCamGroup({ latest: g(at("19:10"), false), morning: null }, SEAWEED, has)).toBeNull();
    expect(pickCamGroup({}, SEAWEED, has)).toBeNull();
    expect(pickCamGroup(null, SEAWEED, has)).toBeNull();
    expect(pickCamGroup(undefined, SEAWEED, has)).toBeNull();
  });
});

describe("pickCamGroup — beach-local date", () => {
  const yesterday = (hhmm: string) => at(hhmm, "2026-10-12");

  it("rejects a fallback group from another local date", () => {
    const feed = { latest: g(yesterday("19:10"), false), lastSeaweed: g(yesterday("17:30"), true), morning: g(yesterday("08:40"), true) };
    expect(pickCamGroup(feed, SEAWEED, has, { nowLocalDate: TODAY })).toBeNull();
    // ...but with no date known, nothing is rejected (callers that cannot say what day it is)
    expect(pickCamGroup(feed, SEAWEED, has)?.source).toBe("lastSeaweed");
  });

  it("falls past a yesterday fallback to today's morning", () => {
    const feed = { latest: g(at("06:30"), false), lastSeaweed: g(yesterday("17:30"), true), morning: g(at("08:40"), true) };
    expect(pickCamGroup(feed, SEAWEED, has, { nowLocalDate: TODAY })?.source).toBe("morning");
  });

  it("rejects yesterday's latest only when asked", () => {
    const feed = { latest: g(yesterday("19:10"), true) };
    expect(pickCamGroup(feed, SEAWEED, has, { nowLocalDate: TODAY, dateGateLatest: true })).toBeNull();
    expect(pickCamGroup(feed, WATER, has, { nowLocalDate: TODAY })?.source).toBe("latest"); // water has its own night/stale gate
  });

  it("does not reject a group whose capture time it cannot read", () => {
    expect(pickCamGroup({ latest: { cams: [{ ok: true }] } }, SEAWEED, has, { nowLocalDate: TODAY, dateGateLatest: true })?.source).toBe("latest");
    expect(groupLocalDate({ capturedAtLocal: "garbage" })).toBeUndefined();
    expect(groupLocalDate({ capturedAtLocal: at("17:30") })).toBe(TODAY);
    expect(groupLocalDate(null)).toBeUndefined();
  });
});
