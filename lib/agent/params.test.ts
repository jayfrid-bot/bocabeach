import { describe, expect, it } from "vitest";
import {
  DECIMAL_PATTERN,
  TEXT_PARAM_PATTERN,
  checkQueryKeys,
  parseBool,
  parseInteger,
  parseLat,
  parseLon,
  parseNumber,
  parseText,
} from "@/lib/agent/params";

describe("parseNumber (canonical decimals only)", () => {
  it("accepts plain decimals in range", () => {
    expect(parseNumber("26.35", "lat", -90, 90)).toEqual({ ok: true, value: 26.35 });
    expect(parseNumber("-80.07", "lon", -180, 180)).toEqual({ ok: true, value: -80.07 });
    expect(parseNumber("0", "x", -1, 1)).toEqual({ ok: true, value: 0 });
    expect(parseNumber("0.5", "x", 0, 1)).toEqual({ ok: true, value: 0.5 });
    expect(parseNumber("10", "x", 0, 90)).toEqual({ ok: true, value: 10 });
  });
  it("refuses every non-canonical spelling", () => {
    const bad = [
      "", " ", " 26", "26 ", "+5", ".5", "5.", "00.5", "026.35", "007", "-0", "-0.0", "1e2", "1E2", "2.635e1",
      "0x10", "NaN", "Infinity", "1,5", "abc", "91", "-91", "1".repeat(30), "26.35\n", "\t26",
    ];
    for (const b of bad) expect(parseNumber(b, "lat", -90, 90).ok, JSON.stringify(b)).toBe(false);
  });
  it("uses the same pattern the OpenAPI document publishes", () => {
    const re = new RegExp(DECIMAL_PATTERN);
    for (const good of ["0", "26.35", "-80.07", "10"]) expect(re.test(good), good).toBe(true);
    for (const bad of ["", "+5", ".5", "5.", "026", "1e2", " 1"]) expect(re.test(bad), bad).toBe(false);
  });
});

describe("parseLat / parseLon (judged by the published pattern, never by rounding)", () => {
  it("refuses a value that would only round into range", () => {
    const justOver = "90." + "0".repeat(20) + "1";
    expect(justOver.length).toBe(24);
    expect(Number(justOver)).toBe(90); // JavaScript would quietly accept it
    expect(parseLat(justOver).ok).toBe(false);
    expect(parseLat("-" + justOver.slice(0, 22) + "1").ok).toBe(false);
    expect(parseLon("180." + "0".repeat(19) + "1").ok).toBe(false);
    expect(parseLat("90").ok && parseLat("90.0").ok && parseLat("-90").ok).toBe(true);
    expect(parseLon("180").ok && parseLon("-180.000").ok && parseLon("-80.07").ok).toBe(true);
    expect(parseLat("90.1").ok || parseLat("-0").ok || parseLat("91").ok).toBe(false);
    expect(parseLon("181").ok || parseLon("-0.0").ok).toBe(false);
  });
  it("returns the number", () => {
    expect(parseLat("26.35")).toEqual({ ok: true, value: 26.35 });
    expect(parseLon("-80.07")).toEqual({ ok: true, value: -80.07 });
  });
});

describe("parseInteger / parseBool", () => {
  it("parses whole numbers in range, no leading zeros", () => {
    expect(parseInteger("5", "limit", 1, 10)).toEqual({ ok: true, value: 5 });
    for (const bad of ["0", "11", "2.5", "-1", "", "x", "1e1", "05", " 5", "5 ", "+5"]) {
      expect(parseInteger(bad, "limit", 1, 10).ok, bad).toBe(false);
    }
  });
  it("parses exactly true or false", () => {
    expect(parseBool("true", "s")).toEqual({ ok: true, value: true });
    expect(parseBool("false", "s")).toEqual({ ok: true, value: false });
    for (const bad of ["1", "0", "TRUE", "True", "yes", "", " true"]) expect(parseBool(bad, "s").ok, bad).toBe(false);
  });
});

describe("parseText", () => {
  it("accepts a plain value and refuses empty, padded, control and over-long ones", () => {
    expect(parseText("Broward", "region", 80)).toEqual({ ok: true, value: "Broward" });
    expect(parseText("Palm Beach", "region", 80).ok).toBe(true);
    for (const bad of ["", " x", "x ", "a\u0000b", "a\nb", "x".repeat(81)]) {
      expect(parseText(bad, "region", 80).ok, JSON.stringify(bad)).toBe(false);
    }
    const over = parseText("x".repeat(81), "region", 80);
    expect(over.ok === false && over.message).toMatch(/too long/);
  });
  it("matches the OpenAPI pattern on the cases that matter", () => {
    const re = new RegExp(TEXT_PARAM_PATTERN);
    expect(re.test("Broward")).toBe(true);
    expect(re.test("Palm Beach")).toBe(true);
    expect(re.test(" x")).toBe(false);
    expect(re.test("x ")).toBe(false);
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
