import { describe, it, expect } from "vitest";
import {
  buildFrameKey,
  camPrefix,
  isCalendarDate,
  isValidFrameKey,
  isValidId,
  parseFrameKey,
  sha8,
} from "@/lib/camFrames/keys";

const SHA = "0123456789abcdef".repeat(4);

describe("buildFrameKey", () => {
  it("builds <slug>/<cam>/<local_date>/<HHmm>Z-<sha8>.jpg from the UTC display time", () => {
    const key = buildFrameKey({
      slug: "boca-raton",
      camId: "boca-south",
      localDate: "2026-10-11",
      displayAtUtc: "2026-10-11T14:05:09.000Z",
      sha256Hex: SHA,
    });
    expect(key).toBe("boca-raton/boca-south/2026-10-11/1405Z-01234567.jpg");
  });

  it("uses the UTC clock even when the local date is the day before", () => {
    // 01:30Z on Oct 11 is 9:30 PM on Oct 10 in New York.
    const key = buildFrameKey({
      slug: "boca-raton",
      camId: "boca-south",
      localDate: "2026-10-10",
      displayAtUtc: "2026-10-11T01:30:00.000Z",
      sha256Hex: SHA,
    });
    expect(key).toBe("boca-raton/boca-south/2026-10-10/0130Z-01234567.jpg");
  });

  it("round-trips through the validator", () => {
    const key = buildFrameKey({
      slug: "a1",
      camId: "b-2",
      localDate: "2026-02-28",
      displayAtUtc: "2026-02-28T23:59:00.000Z",
      sha256Hex: SHA,
    });
    expect(parseFrameKey(key)).toEqual({
      slug: "a1",
      camId: "b-2",
      localDate: "2026-02-28",
      utcHour: 23,
      utcMinute: 59,
      sha8: "01234567",
    });
  });

  it("throws on malformed input instead of writing a key the validator would refuse", () => {
    const ok = { slug: "a", camId: "b", localDate: "2026-10-11", displayAtUtc: "2026-10-11T00:00:00Z", sha256Hex: SHA };
    expect(() => buildFrameKey({ ...ok, slug: "A" })).toThrow();
    expect(() => buildFrameKey({ ...ok, slug: "a/b" })).toThrow();
    expect(() => buildFrameKey({ ...ok, camId: "../x" })).toThrow();
    expect(() => buildFrameKey({ ...ok, localDate: "2026-02-30" })).toThrow();
    expect(() => buildFrameKey({ ...ok, displayAtUtc: "nope" })).toThrow();
    expect(() => buildFrameKey({ ...ok, sha256Hex: "abc" })).toThrow();
  });
});

describe("parseFrameKey / isValidFrameKey", () => {
  const good = "boca-raton/boca-south/2026-10-11/1405Z-01234567.jpg";

  it("accepts the exact shape", () => {
    expect(isValidFrameKey(good)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["not a string", 42],
    ["null", null],
    ["extra segment", "x/boca-raton/boca-south/2026-10-11/1405Z-01234567.jpg"],
    ["missing segment", "boca-south/2026-10-11/1405Z-01234567.jpg"],
    ["dot-dot", "boca-raton/../2026-10-11/1405Z-01234567.jpg"],
    ["leading slash", "/boca-raton/boca-south/2026-10-11/1405Z-01234567.jpg"],
    ["uppercase slug", "Boca-raton/boca-south/2026-10-11/1405Z-01234567.jpg"],
    ["uppercase hex", "boca-raton/boca-south/2026-10-11/1405Z-0123456A.jpg"],
    ["short hash", "boca-raton/boca-south/2026-10-11/1405Z-0123456.jpg"],
    ["long hash", "boca-raton/boca-south/2026-10-11/1405Z-012345678.jpg"],
    ["wrong extension", "boca-raton/boca-south/2026-10-11/1405Z-01234567.png"],
    ["no Z", "boca-raton/boca-south/2026-10-11/1405-01234567.jpg"],
    ["hour 24", "boca-raton/boca-south/2026-10-11/2405Z-01234567.jpg"],
    ["minute 60", "boca-raton/boca-south/2026-10-11/1460Z-01234567.jpg"],
    ["impossible date", "boca-raton/boca-south/2026-02-30/1405Z-01234567.jpg"],
    ["month 13", "boca-raton/boca-south/2026-13-01/1405Z-01234567.jpg"],
    ["trailing newline", `${good}\n`],
    ["query string", `${good}?x=1`],
    ["backslash", "boca-raton\\boca-south/2026-10-11/1405Z-01234567.jpg"],
    ["double hyphen id", "boca--raton/boca-south/2026-10-11/1405Z-01234567.jpg"],
    ["encoded slash", "boca-raton%2Fboca-south/2026-10-11/1405Z-01234567.jpg"],
    ["too long", `${"a".repeat(300)}/b/2026-10-11/1405Z-01234567.jpg`],
    ["id over 64 chars", `${"a".repeat(65)}/b/2026-10-11/1405Z-01234567.jpg`],
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

  it("sha8 and camPrefix", () => {
    expect(sha8(SHA)).toBe("01234567");
    expect(camPrefix("boca-raton", "boca-south")).toBe("boca-raton/boca-south/");
    expect(() => camPrefix("Boca", "x")).toThrow();
  });
});
