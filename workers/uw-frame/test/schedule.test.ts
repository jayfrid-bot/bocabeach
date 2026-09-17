import { describe, expect, it } from "vitest";
import {
  CAMERA_REGISTRY,
  camsDueAtTick,
  easternHour,
  findCamera,
  isDaylightEastern,
  isSurfaceCamHour,
} from "../src/lib/schedule";

describe("registry", () => {
  it("has exactly the five documented cameras", () => {
    expect(CAMERA_REGISTRY.map((c) => c.id)).toEqual([
      "deerfield-spinner-uw",
      "deerfield-beach-cam",
      "deerfield-surf-cam",
      "deerfield-pier-cam",
      "ftl-elbo-beach-cam",
    ]);
  });

  it("keeps the Spinner cam's video id and hourly cadence unchanged", () => {
    const spinner = findCamera("deerfield-spinner-uw");
    expect(spinner?.videoId).toBe("SHfAtWHr9Ks");
    expect(spinner?.cadence).toBe("hourly");
  });

  it("finds a known camera by id and returns undefined for an unknown one", () => {
    expect(findCamera("deerfield-surf-cam")?.videoId).toBe("hIeFPNHfuoY");
    expect(findCamera("not-a-cam")).toBeUndefined();
    expect(findCamera(null)).toBeUndefined();
    expect(findCamera(undefined)).toBeUndefined();
  });

  it("finds the Fort Lauderdale (Elbo Room) cam by id", () => {
    const ftl = findCamera("ftl-elbo-beach-cam");
    expect(ftl?.videoId).toBe("1j1lgppb0PY");
    expect(ftl?.cadence).toBe("3h-daylight");
  });
});

describe("easternHour / isDaylightEastern", () => {
  it("converts a UTC instant to the correct Eastern hour (EDT, UTC-4)", () => {
    // 2026-07-15 is well inside EDT.
    expect(easternHour(new Date("2026-07-15T10:00:00Z"))).toBe(6);
    expect(easternHour(new Date("2026-07-15T23:00:00Z"))).toBe(19);
    expect(easternHour(new Date("2026-07-16T00:00:00Z"))).toBe(20);
  });

  it("converts correctly across the EST offset (UTC-5) too", () => {
    // 2026-01-15 is well inside EST.
    expect(easternHour(new Date("2026-01-15T10:00:00Z"))).toBe(5);
    expect(easternHour(new Date("2026-01-15T15:00:00Z"))).toBe(10);
  });

  it("treats 06:00-20:00 Eastern as daylight, inclusive", () => {
    expect(isDaylightEastern(new Date("2026-07-15T10:00:00Z"))).toBe(true); // 6am ET
    expect(isDaylightEastern(new Date("2026-07-16T00:00:00Z"))).toBe(true); // 8pm ET
    expect(isDaylightEastern(new Date("2026-07-15T09:00:00Z"))).toBe(false); // 5am ET
    expect(isDaylightEastern(new Date("2026-07-16T02:00:00Z"))).toBe(false); // 10pm ET
  });
});

describe("isSurfaceCamHour", () => {
  it("is true only on UTC hours congruent to 1 mod 3", () => {
    // Full 0-23 set for the raw mod-3 predicate. The cron only ever fires at
    // 10-23 and 0, so only 10/13/16/19/22 of these are reachable in practice
    // (see the camsDueAtTick tests below), but the predicate itself is
    // defined for any hour.
    const dueHours = [1, 4, 7, 10, 13, 16, 19, 22];
    for (let h = 0; h < 24; h++) {
      const date = new Date(Date.UTC(2026, 6, 15, h, 0, 0));
      expect(isSurfaceCamHour(date)).toBe(dueHours.includes(h));
    }
  });
});

describe("camsDueAtTick", () => {
  it("grabs only the underwater cam on a non-surface daylight hour", () => {
    // 11:00 UTC = 7am EDT: daylight, but not a surface hour.
    const due = camsDueAtTick(new Date("2026-07-15T11:00:00Z"));
    expect(due.map((c) => c.id)).toEqual(["deerfield-spinner-uw"]);
  });

  it("grabs all five cams on a daylight surface hour", () => {
    // 13:00 UTC = 9am EDT: daylight AND a surface hour.
    const due = camsDueAtTick(new Date("2026-07-15T13:00:00Z"));
    expect(due.map((c) => c.id).sort()).toEqual(
      [
        "deerfield-spinner-uw",
        "deerfield-beach-cam",
        "deerfield-surf-cam",
        "deerfield-pier-cam",
        "ftl-elbo-beach-cam",
      ].sort()
    );
  });

  it("still grabs the underwater cam, but not the surface cams, outside daylight", () => {
    // 09:00 UTC = 5am EDT: not daylight, even though hour%3===0 not 1 anyway.
    const due = camsDueAtTick(new Date("2026-07-15T09:00:00Z"));
    expect(due.map((c) => c.id)).toEqual(["deerfield-spinner-uw"]);
  });

  it("never grabs a surface cam at a surface hour that falls outside daylight", () => {
    // 01:00 UTC is congruent to 1 mod 3 (a "surface hour"), but it's 9pm EDT
    // — outside the daylight window. The hourly underwater cam is still due;
    // only the daylight-gated surface cams are skipped.
    const due = camsDueAtTick(new Date("2026-07-15T01:00:00Z"));
    expect(due.map((c) => c.id)).toEqual(["deerfield-spinner-uw"]);
  });
});
