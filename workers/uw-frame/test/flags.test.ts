import { describe, expect, it } from "vitest";
import { parseVisibleFlags, summarizeVisibleText, type FlagDomEntry } from "../src/lib/flags";

describe("parseVisibleFlags", () => {
  it("returns nothing when every candidate block is hidden", () => {
    const entries: FlagDomEntry[] = [
      { text: "Green_Flag", visible: false },
      { text: "Yellow_Flag", visible: false },
    ];
    expect(parseVisibleFlags(entries)).toEqual([]);
  });

  it("reads a single visible flag by its label text", () => {
    const entries: FlagDomEntry[] = [
      { text: "Green_Flag", visible: true },
      { text: "Yellow_Flag", visible: false },
      { text: "Single_Red_Flag", visible: false },
    ];
    expect(parseVisibleFlags(entries)).toEqual(["green"]);
  });

  it("reads a flag by ArcGIS documentId when no readable label is present", () => {
    const entries: FlagDomEntry[] = [
      { src: "widget-15329.png", alt: "", visible: true }, // yellow
    ];
    expect(parseVisibleFlags(entries)).toEqual(["yellow"]);
  });

  it("never double-counts a double-red block as a plain red flag", () => {
    const entries: FlagDomEntry[] = [{ text: "Double_Red_Flag", visible: true }];
    expect(parseVisibleFlags(entries)).toEqual(["double-red"]);
  });

  it("still reads a genuine single red flag on its own", () => {
    const entries: FlagDomEntry[] = [{ text: "Single_Red_Flag", visible: true }];
    expect(parseVisibleFlags(entries)).toEqual(["red"]);
  });

  it("supports purple accompanying another flag, in canonical order", () => {
    const entries: FlagDomEntry[] = [
      { text: "Yellow_Flag", visible: true },
      { text: "Purple_Flag", alt: "dangerous marine life", visible: true },
    ];
    expect(parseVisibleFlags(entries)).toEqual(["yellow", "purple"]);
  });

  it("ignores entries that match nothing", () => {
    const entries: FlagDomEntry[] = [
      { text: "Deerfield Beach Conditions", visible: true },
      { text: "Powered by Esri", visible: true },
    ];
    expect(parseVisibleFlags(entries)).toEqual([]);
  });

  it("dedupes when the same flag is represented by more than one visible entry", () => {
    const entries: FlagDomEntry[] = [
      { text: "Green_Flag", visible: true },
      { src: "icons/15326-green.png", visible: true },
    ];
    expect(parseVisibleFlags(entries)).toEqual(["green"]);
  });

  it("reads the live ArcGIS shadow-DOM state: bare <strong> labels, Green + Purple visible, others hidden", () => {
    // Confirmed live 2026-09: the dashboard renders inside ~168 nested
    // shadow roots and labels each block with a bare color word (no "Flag"
    // suffix), toggled visible/hidden rather than swapped in/out.
    const entries: FlagDomEntry[] = [
      { text: "Beach Flags", visible: true },
      { text: "Double Red", visible: false },
      { text: "Single Red", visible: false },
      { text: "Yellow", visible: false },
      { text: "Green", visible: true },
      { text: "Purple", visible: true },
      // The visible description under Purple names three OTHER colors. Read
      // live on 2026-09-14 it produced a phantom "red"; prose never counts.
      {
        text: "Dangerous marine life, this flag can be flown with a single red, yellow, or green flag",
        visible: true,
      },
      { text: "Low hazard, calm conditions, exercise caution", visible: true },
    ];
    expect(parseVisibleFlags(entries)).toEqual(["green", "purple"]);
  });

  it("a short label still counts even when a long sentence sits beside it", () => {
    const entries: FlagDomEntry[] = [
      { text: "Single Red", visible: true },
      { text: "High hazard, high surf, strong currents — the red flag means stay out", visible: true },
    ];
    expect(parseVisibleFlags(entries)).toEqual(["red"]);
  });
});

describe("summarizeVisibleText", () => {
  it("joins only the visible entries' text, truncated to the limit", () => {
    const entries: FlagDomEntry[] = [
      { text: "Green_Flag", visible: true },
      { text: "hidden text should not appear", visible: false },
      { text: "Calm surf today", visible: true },
    ];
    expect(summarizeVisibleText(entries)).toBe("Green_Flag | Calm surf today");
    expect(summarizeVisibleText(entries, 5)).toBe("Green");
  });
});
