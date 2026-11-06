import { describe, expect, it } from "vitest";
import { LOCATIONS } from "@/config/locations";
import {
  COURIER_CADENCE,
  FEED_CADENCE,
  camCadence,
  camOfflineSince,
  camRoster,
  camStatus,
  listOfflineCams,
  liveInstantAfter,
  offlineAfterMin,
  type CamCadence,
} from "@/lib/camStatus";

// Nov 6 2026 is Eastern Standard Time (UTC-5): noon ET = 17:00Z.
const t = (iso: string) => Date.parse(iso);
const COURIER: CamCadence = { ...COURIER_CADENCE };
const FEED: CamCadence = { ...FEED_CADENCE, tz: "America/New_York" };

describe("camStatus thresholds", () => {
  it("offline line is max(3 x interval, 6 h)", () => {
    expect(offlineAfterMin(COURIER)).toBe(360);
    expect(offlineAfterMin(FEED)).toBe(360);
    expect(offlineAfterMin({ ...COURIER, intervalMin: 180 })).toBe(540);
  });
});

describe("camStatus, courier cam (hourly, 06:00-21:00 ET)", () => {
  const good = "2026-11-06T15:00:00Z"; // 10:00 AM ET

  it("is online right after a good frame", () => {
    expect(camStatus(COURIER, good, null, t("2026-11-06T16:00:00Z"))).toBe("online");
  });
  it("is stale after 2 x interval of live time, still shown", () => {
    expect(camStatus(COURIER, good, null, t("2026-11-06T17:30:00Z"))).toBe("stale");
  });
  it("is offline after 6 live hours with no good frame", () => {
    expect(camStatus(COURIER, good, null, t("2026-11-06T20:59:00Z"))).toBe("stale");
    expect(camStatus(COURIER, good, null, t("2026-11-06T21:00:00Z"))).toBe("offline");
    expect(camOfflineSince(COURIER, good, t("2026-11-06T22:00:00Z"))).toBe("2026-11-06T21:00:00.000Z");
  });
  it("comes straight back on the first new good frame", () => {
    const now = t("2026-11-07T15:05:00Z");
    expect(camStatus(COURIER, good, null, now)).toBe("offline");
    expect(camStatus(COURIER, "2026-11-07T15:04:00Z", null, now)).toBe("online");
    expect(camOfflineSince(COURIER, "2026-11-07T15:04:00Z", now)).toBeNull();
  });

  it("does not count the night: a frame at 8:30 PM is not offline by morning", () => {
    const evening = "2026-11-07T01:30:00Z"; // 8:30 PM ET Nov 6
    // 30 live min that evening; the clock stops 21:00-06:00.
    expect(camStatus(COURIER, evening, null, t("2026-11-07T11:00:00Z"))).toBe("online"); // 6:00 AM
    expect(camStatus(COURIER, evening, null, t("2026-11-07T12:00:00Z"))).toBe("online"); // 7:00, 90 live min
    expect(camStatus(COURIER, evening, null, t("2026-11-07T13:00:00Z"))).toBe("stale"); // 8:00, 150
    // 30 + 330 min = 11:30 AM ET.
    expect(camStatus(COURIER, evening, null, t("2026-11-07T16:29:00Z"))).toBe("stale");
    expect(camStatus(COURIER, evening, null, t("2026-11-07T16:30:00Z"))).toBe("offline");
  });

  it("never changes status overnight (no flapping while nothing arrives)", () => {
    const evening = "2026-11-06T22:00:00Z"; // 5:00 PM ET
    const seen = new Set<string>();
    for (let ms = t("2026-11-07T02:00:00Z"); ms <= t("2026-11-07T11:00:00Z"); ms += 15 * 60_000) {
      seen.add(camStatus(COURIER, evening, null, ms));
    }
    expect([...seen]).toEqual(["stale"]);
  });

  it("uses the Eastern courier clock for a Central-time beach too", () => {
    const pensacola = LOCATIONS.find((l) => l.slug === "pensacola-beach")!;
    const cam = pensacola.cams.find((c) => c.snapshotMetaUrl)!;
    expect(camCadence(cam, pensacola.timezone)?.tz).toBe("America/New_York");
  });

  it("counts live hours right across the fall-back DST change (Nov 1 2026)", () => {
    // 8:00 PM EDT Oct 31 = 00:00Z Nov 1. 60 live min that night, then from 6:00 EST.
    const at = liveInstantAfter(COURIER, t("2026-11-01T00:00:00Z"), 360);
    expect(new Date(at).toISOString()).toBe("2026-11-01T16:00:00.000Z"); // 11:00 AM EST
  });
});

describe("camStatus, county feed cam (half-hourly, 08:00-17:30 local)", () => {
  it("a frame at 5:25 PM is fine at 8:00 AM, stale by 9:00, offline at 1:55 PM", () => {
    const last = "2026-11-06T22:25:00Z";
    expect(camStatus(FEED, last, null, t("2026-11-07T13:00:00Z"))).toBe("online");
    expect(camStatus(FEED, last, null, t("2026-11-07T14:00:00Z"))).toBe("stale");
    expect(camStatus(FEED, last, null, t("2026-11-07T18:54:00Z"))).toBe("stale");
    expect(camStatus(FEED, last, null, t("2026-11-07T18:55:00Z"))).toBe("offline");
  });
});

describe("camStatus evidence", () => {
  const now = t("2026-11-06T17:00:00Z");
  it("null = the source holds no good frame: offline", () => {
    expect(camStatus(COURIER, null, null, now)).toBe("offline");
    expect(camOfflineSince(COURIER, null, now)).toBeNull();
  });
  it("undefined = the lookup failed: shown (fail open)", () => {
    expect(camStatus(COURIER, undefined, null, now)).toBe("online");
  });
  it("no cadence (link-out, video embed) is always shown", () => {
    expect(camStatus(null, null, null, now)).toBe("online");
  });
  it("an unreadable time is shown", () => {
    expect(camStatus(COURIER, "not a date", null, now)).toBe("online");
  });
  it("a blank refusal after the newest good frame marks it stale, never offline by itself", () => {
    const good = "2026-11-06T16:30:00Z";
    expect(camStatus(COURIER, good, { at: "2026-11-06T16:50:00Z", blank: true }, now)).toBe("stale");
    expect(camStatus(COURIER, good, { at: "2026-11-06T16:00:00Z", blank: true }, now)).toBe("online");
    expect(camStatus(COURIER, good, { at: "2026-11-06T16:50:00Z", blank: false }, now)).toBe("online");
  });
});

describe("camRoster and listOfflineCams", () => {
  it("judges every configured still and skips the link-out cam", () => {
    const roster = camRoster(LOCATIONS);
    const stills = LOCATIONS.flatMap((l) => l.cams.filter((c) => c.embedType === "image" && c.id));
    expect(roster).toHaveLength(stills.length);
    expect(roster.some((c) => c.slug === "wabasso-beach")).toBe(false);
    const boca = roster.find((c) => c.id === "boca-south")!;
    expect(boca.cadence).toMatchObject({ intervalMin: 30, tz: "America/New_York" });
    const spinner = roster.find((c) => c.id === "deerfield-spinner-uw")!;
    expect(spinner.cadence.intervalMin).toBe(60);
  });

  it("lists offline cams with since-when, unknown first", () => {
    const roster = camRoster(LOCATIONS);
    const now = t("2026-11-06T19:00:00Z");
    const list = listOfflineCams(
      roster,
      [
        { id: "deerfield-spinner-uw", lastGoodFrameAt: null },
        { id: "fort-zachary-taylor-cam", lastGoodFrameAt: "2026-11-06T01:00:00Z" },
        { id: "deerfield-pier-cam", lastGoodFrameAt: "2026-11-06T18:30:00Z" },
        { id: "boca-south", lastGoodFrameAt: undefined },
      ],
      now,
    );
    expect(list.map((c) => c.id)).toEqual(["deerfield-spinner-uw", "fort-zachary-taylor-cam"]);
    expect(list[0].since).toBeNull();
    // 8 PM ET Nov 5: one live hour that night, then five from 6:00 AM = 11:00 AM ET.
    expect(list[1]).toMatchObject({ slug: "key-west", since: "2026-11-06T16:00:00.000Z" });
  });
});
