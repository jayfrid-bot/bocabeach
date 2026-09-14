/**
 * Pure parser for the Deerfield Beach lifeguard-flag ArcGIS dashboard.
 *
 * The dashboard shows the active flag(s) by toggling the visibility of a
 * fixed set of widget blocks rather than swapping in different text, so the
 * only reliable signal is "which of the five known blocks is currently
 * visible". This file knows nothing about the DOM or puppeteer — the
 * browser-side code in index.ts walks the live page and reduces it to a
 * plain array of {text, alt, src, visible} entries, which is what actually
 * gets tested here. That split is what makes this logic testable without a
 * real browser.
 */

export type FlagName = "double-red" | "red" | "yellow" | "green" | "purple";

export interface FlagDomEntry {
  readonly text?: string;
  readonly alt?: string;
  readonly src?: string;
  readonly visible: boolean;
}

// Canonical display/priority order, and the order results are returned in.
const CANONICAL_ORDER: readonly FlagName[] = ["double-red", "red", "yellow", "green", "purple"];

interface FlagMatcher {
  readonly name: FlagName;
  readonly test: (haystack: string) => boolean;
}

// Order matters: "double-red" is checked before "red" so a block labelled
// "Double_Red_Flag" (ArcGIS documentId 15330) is never also read as a plain
// single red flag — classifyEntry below returns the FIRST match only.
//
// The live dashboard (confirmed 2026-09, walking its ~168 nested shadow
// roots) labels each block with a BARE <strong> — "Double Red", "Single
// Red", "Yellow", "Green", "Purple" — with no "Flag" word anywhere in the
// label text. So the yellow/green/purple matchers must accept the bare
// color word, not only "<color>_flag"/"<color> Flag".
const FLAG_MATCHERS: readonly FlagMatcher[] = [
  { name: "double-red", test: (h) => /double[_\s-]*red/i.test(h) || /\b15330\b/.test(h) },
  {
    name: "red",
    test: (h) => /single[_\s-]*red/i.test(h) || /\bred[_\s-]*flag\b/i.test(h) || /\b15332\b/.test(h),
  },
  { name: "yellow", test: (h) => /yellow([_\s-]*flag)?/i.test(h) || /\b15329\b/.test(h) },
  { name: "green", test: (h) => /green([_\s-]*flag)?/i.test(h) || /\b15326\b/.test(h) },
  { name: "purple", test: (h) => /purple([_\s-]*flag)?/i.test(h) || /\b15327\b/.test(h) },
];

function classifyEntry(entry: FlagDomEntry): FlagName | null {
  const haystack = [entry.text, entry.alt, entry.src].filter(Boolean).join(" ");
  if (!haystack) return null;
  for (const matcher of FLAG_MATCHERS) {
    if (matcher.test(haystack)) return matcher.name;
  }
  return null;
}

/**
 * Reduce a snapshot of candidate DOM entries to the set of flags currently
 * shown, in canonical order. Only `visible: true` entries can contribute —
 * an entry that matches a flag's name/id but is hidden (display:none, zero
 * bounding box, etc.) is the normal "not currently flying" case.
 */
export function parseVisibleFlags(entries: readonly FlagDomEntry[]): FlagName[] {
  const present = new Set<FlagName>();
  for (const entry of entries) {
    if (!entry.visible) continue;
    const flag = classifyEntry(entry);
    if (flag) present.add(flag);
  }
  return CANONICAL_ORDER.filter((f) => present.has(f));
}

/** First `limit` characters of the combined visible-entry text, for rawText. */
export function summarizeVisibleText(entries: readonly FlagDomEntry[], limit = 400): string {
  const text = entries
    .filter((e) => e.visible && e.text)
    .map((e) => e.text!.trim())
    .filter(Boolean)
    .join(" | ");
  return text.slice(0, limit);
}
