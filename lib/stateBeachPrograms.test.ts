import { describe, expect, it } from "vitest";
import {
  stateCodeFromRegion,
  stateProgram,
} from "@/lib/stateBeachPrograms";

describe("stateProgram", () => {
  it("returns a state-specific deep link when we have one", () => {
    const p = stateProgram("TX");
    expect(p).not.toBeNull();
    expect(p!.name).toBe("Texas beach water program");
    expect(p!.url).toContain("glo.texas.gov");
  });

  it("falls back to the EPA national page for a coastal state with no deep link", () => {
    // GA is a recognized coastal state but has no deep link in the table.
    const p = stateProgram("GA");
    expect(p).not.toBeNull();
    expect(p!.name).toBe("Georgia beach water program");
    expect(p!.url).toContain("epa.gov");
  });

  it("is case/space insensitive on the code", () => {
    expect(stateProgram(" ca ")!.url).toBe(stateProgram("CA")!.url);
  });

  it("returns null for an unrecognized or missing code", () => {
    expect(stateProgram("ZZ")).toBeNull();
    expect(stateProgram(undefined)).toBeNull();
    expect(stateProgram("")).toBeNull();
  });
});

describe("stateCodeFromRegion", () => {
  it("pulls the trailing state code from a county region", () => {
    expect(stateCodeFromRegion("Palm Beach County, FL")).toBe("FL");
  });

  it("handles a bare state code", () => {
    expect(stateCodeFromRegion("TX")).toBe("TX");
  });

  it("handles a named-area region", () => {
    expect(stateCodeFromRegion("Outer Banks, NC")).toBe("NC");
  });

  it("ignores a trailing pair that isn't a known state", () => {
    expect(stateCodeFromRegion("Somewhere, ZZ")).toBeUndefined();
    expect(stateCodeFromRegion("")).toBeUndefined();
    expect(stateCodeFromRegion(undefined)).toBeUndefined();
  });
});
