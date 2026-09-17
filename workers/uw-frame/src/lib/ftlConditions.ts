/**
 * Pure parser for the City of Fort Lauderdale Fire Rescue "Beach Conditions"
 * page (fortlauderdale.gov/.../Beach-Conditions). The page is plain text
 * laid out as a series of labeled sections — "Date ...", "Ocean Water
 * Conditions ...", "Ocean Water Temperature ...", "High Tide ...",
 * "Low Tide ...", "Flags ...", "Sea Pests ...", "Beach Water Quality ..." —
 * with no machine-readable markup, so index.ts reads document.body.innerText
 * from a real headless-Chrome load (a plain fetch gets a 403 bot-block) and
 * hands the resulting string here. This file knows nothing about the DOM or
 * puppeteer, which is what makes it testable without a browser.
 */

import type { FlagName } from "./flags";

// Canonical order + matching, shared with the Deerfield parser so both
// feeds report flags the same way.
const CANONICAL_ORDER: readonly FlagName[] = ["double-red", "red", "yellow", "green", "purple"];

export interface FortLauderdaleConditions {
  /** ISO date (e.g. "2026-09-16") parsed from the "Date" line, or null. */
  pageDate: string | null;
  /** Flags named in the "Flags" section, in canonical order. */
  flags: FlagName[];
  /** The raw "Flags" section text, e.g. "Yellow Flags for moderate surf and currents." */
  flagsText: string;
  /** The raw "Sea Pests" section prose, or null if the section is missing. */
  seaPests: string | null;
  /** true when seaPests prose reports pests present; false when it says none;
   *  null when the section is missing entirely. */
  seaPestsPresent: boolean | null;
  /** Parsed from "Ocean Water Temperature ... NN degrees", or null. */
  waterTempF: number | null;
  /** The raw "Ocean Water Conditions" section prose, or null. */
  oceanConditions: string | null;
}

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/** Normalize runs of whitespace (including newlines) to single spaces, trimmed. */
function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Cut `text` into named sections, given the labels in the order they're
 * expected to appear. Each section runs from just after its label to just
 * before the next label found (or end of string). A missing label yields no
 * section for it. Labels are matched case-sensitively on word boundaries,
 * as they appear on the live page (title case).
 */
function sliceSections(text: string, labels: readonly string[]): Map<string, string> {
  const found: { label: string; index: number; end: number }[] = [];
  for (const label of labels) {
    const re = new RegExp(`\\b${label.replace(/\s+/g, "\\s+")}\\b`, "i");
    const m = re.exec(text);
    if (m) found.push({ label, index: m.index, end: m.index + m[0].length });
  }
  found.sort((a, b) => a.index - b.index);

  const sections = new Map<string, string>();
  for (let i = 0; i < found.length; i++) {
    const start = found[i].end;
    const stop = i + 1 < found.length ? found[i + 1].index : text.length;
    sections.set(found[i].label, collapseWs(text.slice(start, stop)));
  }
  return sections;
}

const SECTION_LABELS = [
  "Date",
  "Ocean Water Conditions",
  "Ocean Water Temperature",
  "High Tide",
  "Low Tide",
  "Flags",
  "Sea Pests",
  "Beach Water Quality",
] as const;

function parsePageDate(dateSection: string | undefined): string | null {
  if (!dateSection) return null;
  // e.g. "Wednesday, September 16th, 2026"
  const m = dateSection.match(
    /([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/,
  );
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (!day || !year) return null;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function parseFlags(flagsSection: string | undefined): FlagName[] {
  if (!flagsSection) return [];
  const present = new Set<FlagName>();
  const isDoubleRed = /double\s*red/i.test(flagsSection);
  if (isDoubleRed) present.add("double-red");
  // A bare "red" only counts when it isn't part of "double red" — avoids
  // double-counting a "Double Red" posting as both double-red and red.
  if (!isDoubleRed && /\bred\b/i.test(flagsSection)) present.add("red");
  if (/\byellow\b/i.test(flagsSection)) present.add("yellow");
  if (/\bgreen\b/i.test(flagsSection)) present.add("green");
  if (/\bpurple\b/i.test(flagsSection)) present.add("purple");
  return CANONICAL_ORDER.filter((f) => present.has(f));
}

function parseWaterTemp(tempSection: string | undefined): number | null {
  if (!tempSection) return null;
  const m = tempSection.match(/(\d{2,3}(?:\.\d+)?)\s*(?:degrees|°)/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}

const NO_SEA_PESTS = /\bno\s+sea\s*pests?\b|\bnone\s+reported\b|\bnot\s+reported\b/i;

function parseSeaPestsPresent(seaPestsSection: string | undefined): boolean | null {
  if (seaPestsSection === undefined) return null;
  if (!seaPestsSection) return false;
  return !NO_SEA_PESTS.test(seaPestsSection);
}

export function parseFortLauderdaleConditions(innerText: string): FortLauderdaleConditions {
  const text = innerText ?? "";
  const sections = sliceSections(text, SECTION_LABELS);

  const flagsText = sections.get("Flags") ?? "";
  const seaPestsSection = sections.get("Sea Pests");

  return {
    pageDate: parsePageDate(sections.get("Date")),
    flags: parseFlags(flagsText),
    flagsText,
    seaPests: seaPestsSection ?? null,
    seaPestsPresent: parseSeaPestsPresent(seaPestsSection),
    waterTempF: parseWaterTemp(sections.get("Ocean Water Temperature")),
    oceanConditions: sections.get("Ocean Water Conditions") ?? null,
  };
}
