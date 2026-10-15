import { describe, it, expect } from "vitest";
import {
  buildFrameKey,
  camPrefix,
  claim8,
  isCalendarDate,
  isValidFrameKey,
  isValidId,
  parseFrameKey,
  sha8,
  buildQualityFrameKey,
  camOfKey,
  isQualityFrameKey,
  isSignableKey,
  parseQualityFrameKey,
  qualityCamPrefix,
} from "@/lib/camFrames/keys";

const SHA = "0123456789abcdef".repeat(4);
const CLAIM = "cccccccc-1111-4222-8333-444444444444";

describe("buildFrameKey", () => {
  it("builds <slug>/<cam>/<local_date>/<HHmm>Z-<sha8>-<claim8>.jpg from the UTC display time", () => {
    const key = buildFrameKey({
      slug: "boca-raton",
      camId: "boca-south",
      localDate: "2026-10-11",
      displayAtUtc: "2026-10-11T14:05:09.000Z",
      sha256Hex: SHA,
      claimId: CLAIM,
    });
    expect(key).toBe("boca-raton/boca-south/2026-10-11/1405Z-01234567-cccccccc.jpg");
  });

  it("uses the UTC clock even when the local date is the day before", () => {
    // 01:30Z on Oct 11 is 9:30 PM on Oct 10 in New York.
    const key = buildFrameKey({
      slug: "boca-raton",
      camId: "boca-south",
      localDate: "2026-10-10",
      displayAtUtc: "2026-10-11T01:30:00.000Z",
      sha256Hex: SHA,
      claimId: CLAIM,
    });
    expect(key).toBe("boca-raton/boca-south/2026-10-10/0130Z-01234567-cccccccc.jpg");
  });

  it("round-trips through the validator", () => {
    const key = buildFrameKey({
      slug: "a1",
      camId: "b-2",
      localDate: "2026-02-28",
      displayAtUtc: "2026-02-28T23:59:00.000Z",
      sha256Hex: SHA,
      claimId: CLAIM,
    });
    expect(parseFrameKey(key)).toEqual({
      slug: "a1",
      camId: "b-2",
      localDate: "2026-02-28",
      utcHour: 23,
      utcMinute: 59,
      sha8: "01234567",
      claim8: "cccccccc",
    });
  });

  it("throws on malformed input instead of writing a key the validator would refuse", () => {
    const ok = { slug: "a", camId: "b", localDate: "2026-10-11", displayAtUtc: "2026-10-11T00:00:00Z", sha256Hex: SHA, claimId: CLAIM };
    expect(() => buildFrameKey({ ...ok, slug: "A" })).toThrow();
    expect(() => buildFrameKey({ ...ok, slug: "a/b" })).toThrow();
    expect(() => buildFrameKey({ ...ok, camId: "../x" })).toThrow();
    expect(() => buildFrameKey({ ...ok, localDate: "2026-02-30" })).toThrow();
    expect(() => buildFrameKey({ ...ok, displayAtUtc: "nope" })).toThrow();
    expect(() => buildFrameKey({ ...ok, sha256Hex: "abc" })).toThrow();
    expect(() => buildFrameKey({ ...ok, claimId: "ZZZZZZZZ-0000" })).toThrow();
    expect(() => buildFrameKey({ ...ok, claimId: "abc" })).toThrow();
  });
});

describe("parseFrameKey / isValidFrameKey", () => {
  const good = "boca-raton/boca-south/2026-10-11/1405Z-01234567-cccccccc.jpg";

  it("accepts the exact shape", () => {
    expect(isValidFrameKey(good)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["not a string", 42],
    ["null", null],
    ["extra segment", "x/boca-raton/boca-south/2026-10-11/1405Z-01234567-cccccccc.jpg"],
    ["missing segment", "boca-south/2026-10-11/1405Z-01234567-cccccccc.jpg"],
    ["dot-dot", "boca-raton/../2026-10-11/1405Z-01234567-cccccccc.jpg"],
    ["leading slash", "/boca-raton/boca-south/2026-10-11/1405Z-01234567-cccccccc.jpg"],
    ["uppercase slug", "Boca-raton/boca-south/2026-10-11/1405Z-01234567-cccccccc.jpg"],
    ["uppercase hex", "boca-raton/boca-south/2026-10-11/1405Z-0123456A.jpg"],
    ["no claim part", "boca-raton/boca-south/2026-10-11/1405Z-01234567.jpg"],
    ["short claim part", "boca-raton/boca-south/2026-10-11/1405Z-01234567-ccccccc.jpg"],
    ["uppercase claim part", "boca-raton/boca-south/2026-10-11/1405Z-01234567-CCCCCCCC.jpg"],
    ["short hash", "boca-raton/boca-south/2026-10-11/1405Z-0123456.jpg"],
    ["long hash", "boca-raton/boca-south/2026-10-11/1405Z-012345678.jpg"],
    ["wrong extension", "boca-raton/boca-south/2026-10-11/1405Z-01234567.png"],
    ["no Z", "boca-raton/boca-south/2026-10-11/1405-01234567.jpg"],
    ["hour 24", "boca-raton/boca-south/2026-10-11/2405Z-01234567-cccccccc.jpg"],
    ["minute 60", "boca-raton/boca-south/2026-10-11/1460Z-01234567-cccccccc.jpg"],
    ["impossible date", "boca-raton/boca-south/2026-02-30/1405Z-01234567-cccccccc.jpg"],
    ["month 13", "boca-raton/boca-south/2026-13-01/1405Z-01234567-cccccccc.jpg"],
    ["trailing newline", `${good}\n`],
    ["query string", `${good}?x=1`],
    ["backslash", "boca-raton\\boca-south/2026-10-11/1405Z-01234567-cccccccc.jpg"],
    ["double hyphen id", "boca--raton/boca-south/2026-10-11/1405Z-01234567-cccccccc.jpg"],
    ["encoded slash", "boca-raton%2Fboca-south/2026-10-11/1405Z-01234567-cccccccc.jpg"],
    ["too long", `${"a".repeat(300)}/b/2026-10-11/1405Z-01234567-cccccccc.jpg`],
    ["id over 64 chars", `${"a".repeat(65)}/b/2026-10-11/1405Z-01234567-cccccccc.jpg`],
  ])("rejects %s", (_name, key) => {
    expect(isValidFrameKey(key)).toBe(false);
  });
});

describe("helpers", () => {
  it("isValidId", () => {
    expect(isValidId("boca-south")).toBe(true);
    expect(isValidId("a")).toBe(true);
    expect(isValidId("")).toBe(false);
    expect(isValidId("-a")).toBe(false);
    expect(isValidId("a-")).toBe(false);
    expect(isValidId("A")).toBe(false);
    expect(isValidId("a b")).toBe(false);
    expect(isValidId("a'b")).toBe(false);
    expect(isValidId("a".repeat(65))).toBe(false);
    expect(isValidId(undefined)).toBe(false);
  });

  it("isCalendarDate round-trips real dates only", () => {
    expect(isCalendarDate("2026-10-11")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2026-04-31")).toBe(false);
    expect(isCalendarDate("2026-1-1")).toBe(false);
    expect(isCalendarDate("1999-01-01")).toBe(false);
  });

  it("claim8 takes the first 8 hex characters of a UUID", () => {
    expect(claim8(CLAIM)).toBe("cccccccc");
    expect(() => claim8("not-a-uuid")).toThrow();
  });

  it("sha8 and camPrefix", () => {
    expect(sha8(SHA)).toBe("01234567");
    expect(camPrefix("boca-raton", "boca-south")).toBe("boca-raton/boca-south/");
    expect(() => camPrefix("Boca", "x")).toThrow();
  });
});

describe("quality frame keys (the exact image behind a quality alert)", () => {
  const AT = Date.parse("2026-10-13T17:20:15.000Z");

  it("builds quality/<slug>/<cam>/<utc date>/<HHmmss>Z-<sha8>.jpg", () => {
    expect(buildQualityFrameKey({ slug: "boca-raton", camId: "boca-inlet-surf", atMs: AT, sha256Hex: SHA })).toBe(
      "quality/boca-raton/boca-inlet-surf/2026-10-13/172015Z-01234567.jpg",
    );
  });

  it("parses what it builds, and nothing else", () => {
    const key = buildQualityFrameKey({ slug: "boca-raton", camId: "boca-inlet-surf", atMs: AT, sha256Hex: SHA });
    expect(parseQualityFrameKey(key)).toEqual({ slug: "boca-raton", camId: "boca-inlet-surf", utcDate: "2026-10-13", sha8: "01234567" });
    for (const bad of [
      "boca-raton/boca-inlet-surf/2026-10-13/172015Z-01234567.jpg",
      "quality/boca-raton/boca-inlet-surf/2026-10-13/172015Z-01234567.png",
      "quality/boca-raton/../2026-10-13/172015Z-01234567.jpg",
      "quality/Boca/cam/2026-10-13/172015Z-01234567.jpg",
      "quality/boca-raton/cam/2026-13-45/172015Z-01234567.jpg",
      "quality/boca-raton/cam/2026-10-13/252015Z-01234567.jpg",
      "quality/boca-raton/cam/2026-10-13/172015Z-0123456.jpg",
      "quality/boca-raton/cam/2026-10-13/172015Z-01234567.jpg/extra",
      "",
      null,
      7,
    ]) {
      expect(parseQualityFrameKey(bad), String(bad)).toBeNull();
    }
  });

  it("refuses to build from malformed input", () => {
    expect(() => buildQualityFrameKey({ slug: "Bad", camId: "c", atMs: AT, sha256Hex: SHA })).toThrow();
    expect(() => buildQualityFrameKey({ slug: "s", camId: "c", atMs: Number.NaN, sha256Hex: SHA })).toThrow();
    expect(() => buildQualityFrameKey({ slug: "s", camId: "c", atMs: AT, sha256Hex: "nope" })).toThrow();
  });

  it("is signable and names its cam, and is not an archive key", () => {
    const key = buildQualityFrameKey({ slug: "boca-raton", camId: "boca-inlet-surf", atMs: AT, sha256Hex: SHA });
    expect(isQualityFrameKey(key)).toBe(true);
    expect(isValidFrameKey(key)).toBe(false);
    expect(isSignableKey(key)).toBe(true);
    expect(isSignableKey("boca-raton/boca-south/2026-10-11/1420Z-01234567-cccccccc.jpg")).toBe(true);
    expect(isSignableKey("random/key.jpg")).toBe(false);
    expect(camOfKey(key)).toEqual({ slug: "boca-raton", camId: "boca-inlet-surf" });
    expect(camOfKey("boca-raton/boca-south/2026-10-11/1420Z-01234567-cccccccc.jpg")).toEqual({ slug: "boca-raton", camId: "boca-south" });
    expect(camOfKey("nope")).toBeNull();
  });

  it("has its own per-cam prefix, apart from the archive's", () => {
    expect(qualityCamPrefix("boca-raton", "boca-inlet-surf")).toBe("quality/boca-raton/boca-inlet-surf/");
    expect(camPrefix("boca-raton", "boca-inlet-surf")).toBe("boca-raton/boca-inlet-surf/");
    expect(() => qualityCamPrefix("Bad", "c")).toThrow();
  });
});
