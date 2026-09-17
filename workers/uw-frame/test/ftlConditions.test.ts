import { describe, expect, it } from "vitest";
import { parseFortLauderdaleConditions } from "../src/lib/ftlConditions";

const SAMPLE =
  "Date Wednesday, September 16th, 2026 Ocean Water Conditions Moderate chop 1-2ft " +
  "Ocean Water Temperature Approximately 85 degrees. High Tide 12:54 PM Low Tide 7:22 PM " +
  "Flags Yellow Flags for moderate surf and currents. Sea Pests No sea pests reported at " +
  "this time, subject to change. Beach Water Quality Good";

describe("parseFortLauderdaleConditions", () => {
  it("parses the full sample page", () => {
    const r = parseFortLauderdaleConditions(SAMPLE);
    expect(r.pageDate).toBe("2026-09-16");
    expect(r.flags).toEqual(["yellow"]);
    expect(r.flagsText).toMatch(/Yellow Flags for moderate surf/);
    expect(r.seaPests).toMatch(/No sea pests reported/);
    expect(r.seaPestsPresent).toBe(false);
    expect(r.waterTempF).toBe(85);
    expect(r.oceanConditions).toMatch(/Moderate chop/);
  });

  it("parses a red-flag day", () => {
    const text =
      "Date Monday, September 14th, 2026 Ocean Water Conditions Choppy Ocean Water Temperature " +
      "Approximately 83 degrees. High Tide 1:00 PM Low Tide 7:00 PM Flags Red Flags for high surf. " +
      "Sea Pests No sea pests reported at this time. Beach Water Quality Good";
    const r = parseFortLauderdaleConditions(text);
    expect(r.flags).toEqual(["red"]);
  });

  it("parses a double-red day without also reporting a plain red flag", () => {
    const text =
      "Date Tuesday, September 15th, 2026 Flags Double Red Flags for dangerous conditions, " +
      "water closed to the public. Sea Pests No sea pests reported.";
    const r = parseFortLauderdaleConditions(text);
    expect(r.flags).toEqual(["double-red"]);
  });

  it("parses a combined purple and yellow flag day with a present sea-pests note", () => {
    const text =
      "Date Sunday, September 13th, 2026 Flags Purple and Yellow Flags for moderate surf and " +
      "marine pests. Sea Pests Portuguese man-o-war present, use caution.";
    const r = parseFortLauderdaleConditions(text);
    expect(r.flags).toEqual(["yellow", "purple"]);
    expect(r.seaPestsPresent).toBe(true);
    expect(r.seaPests).toMatch(/Portuguese man-o-war present/);
  });

  it("handles a missing Sea Pests section", () => {
    const text =
      "Date Friday, September 11th, 2026 Flags Green Flags for calm conditions. Beach Water Quality Good";
    const r = parseFortLauderdaleConditions(text);
    expect(r.flags).toEqual(["green"]);
    expect(r.seaPests).toBeNull();
    expect(r.seaPestsPresent).toBeNull();
  });

  it("returns nulls/empties for empty input rather than throwing", () => {
    const r = parseFortLauderdaleConditions("");
    expect(r.pageDate).toBeNull();
    expect(r.flags).toEqual([]);
    expect(r.flagsText).toBe("");
    expect(r.seaPests).toBeNull();
    expect(r.seaPestsPresent).toBeNull();
    expect(r.waterTempF).toBeNull();
    expect(r.oceanConditions).toBeNull();
  });

  it("is robust to extra whitespace/newlines between sections", () => {
    const text =
      "Date\n  Wednesday,   September 16th, 2026  \n\nOcean Water Conditions\nCalm\n\n" +
      "Flags\n  Green Flags for calm conditions.\n\nSea Pests\nNone reported.\n";
    const r = parseFortLauderdaleConditions(text);
    expect(r.pageDate).toBe("2026-09-16");
    expect(r.flags).toEqual(["green"]);
    expect(r.seaPestsPresent).toBe(false);
  });
});
