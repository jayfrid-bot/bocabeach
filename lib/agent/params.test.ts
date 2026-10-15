import { describe, expect, it } from "vitest";
import { checkQueryKeys, parseBool, parseInteger, parseNumber } from "@/lib/agent/params";

describe("parseNumber", () => {
  it("accepts plain decimals in range", () => {
    expect(parseNumber("26.35", "lat", -90, 90)).toEqual({ ok: true, value: 26.35 });
    expect(parseNumber("-80.07", "lon", -180, 180)).toEqual({ ok: true, value: -80.07 });
    expect(parseNumber("+5", "x", 0, 10)).toEqual({ ok: true, value: 5 });
    expect(parseNumber(".5", "x", 0, 1)).toEqual({ ok: true, value: 0.5 });
  });
  it("refuses empty, exponent, words, hex and out-of-range values", () => {
    for (const bad of ["", " ", "abc", "1e2", "0x10", "NaN", "Infinity", "1,5", "91", "-91", "1".repeat(30)]) {
      expect(parseNumber(bad, "lat", -90, 90).ok, bad).toBe(false);
    }
  });
});

describe("parseInteger / parseBool", () => {
  it("parses whole numbers in range only", () => {
    expect(parseInteger("5", "limit", 1, 10)).toEqual({ ok: true, value: 5 });
    for (const bad of ["0", "11", "2.5", "-1", "", "x", "1e1"]) expect(parseInteger(bad, "limit", 1, 10).ok, bad).toBe(false);
  });
  it("parses true/false/1/0", () => {
    expect(parseBool("true", "s")).toEqual({ ok: true, value: true });
    expect(parseBool("0", "s")).toEqual({ ok: true, value: false });
    expect(parseBool("yes", "s").ok).toBe(false);
  });
});

describe("checkQueryKeys", () => {
  it("refuses unknown and repeated keys", () => {
    expect(checkQueryKeys(new URLSearchParams("lat=1&lon=2"), ["lat", "lon"]).ok).toBe(true);
    expect(checkQueryKeys(new URLSearchParams("x=1"), ["lat"]).ok).toBe(false);
    expect(checkQueryKeys(new URLSearchParams("lat=1&lat=2"), ["lat"]).ok).toBe(false);
    expect(checkQueryKeys(new URLSearchParams(""), []).ok).toBe(true);
  });
});
