import { describe, it, expect } from "vitest";
import {
  camFreshness,
  LIVE_CAPTURE_MAX_MIN,
  LIVE_DATA_MAX_MIN,
} from "@/lib/camFreshness";

const NOW = Date.parse("2026-08-23T15:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60000).toISOString();

describe("camFreshness", () => {
  it("says live when the capture and the page data are both recent", () => {
    expect(camFreshness({ capturedAt: minutesAgo(2), dataAt: minutesAgo(1), now: NOW })).toBe(
      "live",
    );
  });

  it("says feed-stale when our data is fresh but the capture is old", () => {
    expect(camFreshness({ capturedAt: minutesAgo(45), dataAt: minutesAgo(1), now: NOW })).toBe(
      "feed-stale",
    );
  });

  it("says data-stale when the page is holding an old snapshot", () => {
    // The app sat in the background for hours: the capture time we hold is old
    // AND the data is old. Never "feed-stale" — our own data is the problem.
    expect(camFreshness({ capturedAt: minutesAgo(180), dataAt: minutesAgo(180), now: NOW })).toBe(
      "data-stale",
    );
  });

  it("says data-stale even when the held capture time looks recent", () => {
    // The exact trust bug: a refetch failed, so the snapshot is 40 min old, but
    // its capturedAt was recent WHEN IT WAS FETCHED. Not live.
    expect(camFreshness({ capturedAt: minutesAgo(38), dataAt: minutesAgo(40), now: NOW })).toBe(
      "data-stale",
    );
  });

  it("says unverified when the source publishes no capture time", () => {
    expect(camFreshness({ capturedAt: undefined, dataAt: minutesAgo(1), now: NOW })).toBe(
      "unverified",
    );
    expect(camFreshness({ capturedAt: null, dataAt: minutesAgo(1), now: NOW })).toBe("unverified");
    expect(camFreshness({ capturedAt: "not-a-date", dataAt: minutesAgo(1), now: NOW })).toBe(
      "unverified",
    );
  });

  it("says unverified before the client clock is readable (SSR / first render)", () => {
    expect(camFreshness({ capturedAt: minutesAgo(1), dataAt: minutesAgo(1), now: null })).toBe(
      "unverified",
    );
  });

  it("treats a missing or unreadable data time as stale, never live", () => {
    expect(camFreshness({ capturedAt: minutesAgo(1), dataAt: undefined, now: NOW })).toBe(
      "data-stale",
    );
    expect(camFreshness({ capturedAt: minutesAgo(1), dataAt: "nope", now: NOW })).toBe(
      "data-stale",
    );
  });

  it("holds the 15-minute capture boundary", () => {
    expect(LIVE_CAPTURE_MAX_MIN).toBe(15);
    expect(camFreshness({ capturedAt: minutesAgo(15), dataAt: minutesAgo(1), now: NOW })).toBe(
      "live",
    );
    expect(camFreshness({ capturedAt: minutesAgo(15.1), dataAt: minutesAgo(1), now: NOW })).toBe(
      "feed-stale",
    );
  });

  it("holds the 10-minute data boundary", () => {
    expect(LIVE_DATA_MAX_MIN).toBe(10);
    expect(camFreshness({ capturedAt: minutesAgo(1), dataAt: minutesAgo(10), now: NOW })).toBe(
      "live",
    );
    expect(camFreshness({ capturedAt: minutesAgo(1), dataAt: minutesAgo(10.1), now: NOW })).toBe(
      "data-stale",
    );
  });

  it("does not trip on a slightly fast source clock (timestamps in the future)", () => {
    expect(camFreshness({ capturedAt: minutesAgo(-2), dataAt: minutesAgo(-1), now: NOW })).toBe(
      "live",
    );
  });
});
