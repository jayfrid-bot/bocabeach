// Emitters for a resolved Location: a paste-ready TypeScript object literal that
// matches the hand-written style of config/locations.ts (with inline provenance
// comments + owner-TODO placeholders for curated fields), and a human-readable
// report that surfaces per-field source/confidence/distance, the warnings, and a
// "FIELDS NEEDING ATTENTION" checklist.
//
// Pure: no I/O, no network. Operates only on the ResolveResult.

import type {
  Confidence,
  Provenance,
  ResolveResult,
  ResolvedField,
  Warning,
} from "./types";

/** Quote a string as a TS double-quoted literal, escaping quotes/backslashes. */
function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Compact provenance tail comment, e.g. "// tide-registry, 0.26mi, high". */
function provComment(f: ResolvedField<unknown> | undefined): string {
  if (!f) return "";
  const parts: string[] = [f.source, f.confidence];
  if (f.distanceMi !== undefined) parts.splice(1, 0, `${f.distanceMi}mi`);
  return `// ${parts.join(", ")}`;
}

/**
 * Emit a paste-ready `Location` object literal in the config/locations.ts hand
 * style: two-space indentation, double-quoted strings, inline provenance comments
 * on auto-resolved fields, and owner-TODO placeholders for the curated fields the
 * resolver intentionally leaves blank (healthyBeaches, cityConditionsUrl, cams).
 *
 * Returns a single-line `// (no resolved location)` comment when the result is
 * not a resolved one.
 */
export function emitLocationSnippet(r: ResolveResult): string {
  const loc = r.location;
  const prov = r.provenance;
  if (!loc || !prov) return "// (no resolved location)";

  const L: string[] = [];
  L.push("{");
  L.push(`  slug: ${q(loc.slug)},`);
  L.push(`  name: ${q(loc.name)},`);
  L.push(`  region: ${q(loc.region)},`);
  if (loc.tier) L.push(`  tier: ${q(loc.tier)},`);
  L.push(`  lat: ${loc.lat}, ${provComment(prov.lat)}`);
  L.push(`  lon: ${loc.lon}, ${provComment(prov.lon)}`);
  L.push(`  timezone: ${q(loc.timezone)}, ${provComment(prov.timezone)}`);
  L.push(
    `  noaaTideStationId: ${q(loc.noaaTideStationId)}, ${provComment(prov.noaaTideStationId)}`,
  );
  if (loc.noaaTideStationFallbackId !== undefined) {
    L.push(`  noaaTideStationFallbackId: ${q(loc.noaaTideStationFallbackId)},`);
  }
  L.push(`  ndbcBuoyId: ${q(loc.ndbcBuoyId)}, ${provComment(prov.ndbcBuoyId)}`);
  if (loc.ndbcBuoyFallbackId !== undefined) {
    L.push(`  ndbcBuoyFallbackId: ${q(loc.ndbcBuoyFallbackId)},`);
  }
  if (loc.surfZone) {
    L.push(
      `  surfZone: { office: ${q(loc.surfZone.office)}, name: ${q(loc.surfZone.name)} }, ${provComment(prov.surfZone)}`,
    );
  } else {
    L.push(`  // surfZone: { office: "", name: "" }, // TODO owner — unresolved`);
  }
  // Curated fields the resolver leaves blank for a human to fill in.
  L.push(`  // healthyBeaches: { county: "", sites: [] }, // TODO owner`);
  L.push(`  // cityConditionsUrl: "", // TODO owner`);
  L.push(`  cams: [], // TODO owner`);
  L.push("},");
  return L.join("\n");
}

/** Human label for a confidence level, padded for column alignment. */
function confLabel(c: Confidence): string {
  return c.toUpperCase().padEnd(6);
}

/** One report line per resolved field. */
function fieldLine(
  label: string,
  f: ResolvedField<unknown> | undefined,
): string {
  if (!f) return `  ${label.padEnd(22)}  (not resolved)`;
  const val =
    f.value === null
      ? "—"
      : typeof f.value === "object"
        ? JSON.stringify(f.value)
        : String(f.value);
  const dist = f.distanceMi !== undefined ? `  ${f.distanceMi}mi` : "";
  const note = f.note ? `  (${f.note})` : "";
  return `  ${label.padEnd(22)}  ${confLabel(f.confidence)}  ${f.source.padEnd(14)}  ${val}${dist}${note}`;
}

/** True when a field warrants human attention (missing, or medium/low confidence). */
function needsAttention(f: ResolvedField<unknown> | undefined): boolean {
  return !f || f.value === null || f.confidence !== "high";
}

const SEVERITY_ORDER: Record<Warning["severity"], number> = {
  blocker: 0,
  warn: 1,
  info: 2,
};

/**
 * Emit a human-readable resolution report: a header, per-field
 * source/confidence/distance lines, the warnings (most severe first), and a
 * "FIELDS NEEDING ATTENTION" checklist of every medium/low/missing field plus the
 * curated owner-TODO fields the resolver never fills.
 */
export function emitReport(r: ResolveResult): string {
  const out: string[] = [];
  out.push(`Resolve report for ${JSON.stringify(r.query)} — status: ${r.status}`);

  if (r.chosen) {
    const c = r.chosen;
    out.push(
      `Chosen: ${c.name}${c.state ? `, ${c.state}` : ""} (${c.lat}, ${c.lon})` +
        (c.geocodeName ? `  via geocode "${c.geocodeName}"` : ""),
    );
  }

  if (r.status === "pick-list") {
    out.push("");
    out.push(`Candidates (${r.candidates.length}):`);
    for (const c of r.candidates) {
      out.push(
        `  - ${c.name}${c.state ? `, ${c.state}` : ""}  ${c.distanceMi}mi @ ${c.bearingDeg}°  [${c.source}]`,
      );
    }
  }

  const prov = r.provenance;
  if (prov) {
    out.push("");
    out.push("Fields:");
    out.push(fieldLine("lat", prov.lat));
    out.push(fieldLine("lon", prov.lon));
    out.push(fieldLine("timezone", prov.timezone));
    out.push(fieldLine("noaaTideStationId", prov.noaaTideStationId));
    out.push(fieldLine("ndbcBuoyId", prov.ndbcBuoyId));
    out.push(fieldLine("surfZone", prov.surfZone));
  }

  out.push("");
  if (r.warnings.length === 0) {
    out.push("Warnings: none");
  } else {
    out.push("Warnings:");
    const sorted = [...r.warnings].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
    for (const w of sorted) {
      out.push(`  [${w.severity}] ${w.code}: ${w.message}`);
    }
  }

  // FIELDS NEEDING ATTENTION: medium/low/missing resolved fields + curated TODOs.
  out.push("");
  out.push("FIELDS NEEDING ATTENTION:");
  const attention: string[] = [];
  if (prov) {
    const entries: [string, ResolvedField<unknown>][] = [
      ["timezone", prov.timezone],
      ["noaaTideStationId", prov.noaaTideStationId],
      ["ndbcBuoyId", prov.ndbcBuoyId],
      ["surfZone", prov.surfZone],
      ["lat", prov.lat],
      ["lon", prov.lon],
    ];
    for (const [label, f] of entries) {
      if (needsAttention(f)) {
        const why = !f || f.value === null ? "unresolved" : `${f.confidence} confidence`;
        attention.push(`  - ${label}: ${why}`);
      }
    }
  }
  // Curated fields are always owner-TODO — the resolver never fills them.
  attention.push("  - healthyBeaches: owner-todo (curate FL Healthy Beaches county + sites)");
  attention.push("  - cityConditionsUrl: owner-todo (curate official conditions page)");
  attention.push("  - cams: owner-todo (curate beach cams)");
  out.push(...attention);

  return out.join("\n");
}
