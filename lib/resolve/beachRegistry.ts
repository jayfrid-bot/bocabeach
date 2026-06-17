// Beach registry access: load the static US beach registry and answer the two
// spatial/text queries the resolver needs — "what beaches are near this point"
// and "find the beach the user typed by name".
//
// House style mirror: a pure core (nearestBeaches/matchBeachByName — no I/O, no
// throwing) split from a thin, side-effecting loader (loadBeachRegistry). The
// loader never throws: a missing/unreadable/malformed registry yields [] so the
// resolver degrades gracefully instead of crashing.

import { readFileSync } from "node:fs";
import path from "node:path";

import { bearingDeg, haversineMiles, round } from "@/lib/util";
import type { BeachEntry } from "./types";

/** Path (relative to the project root) of the built US beach registry snapshot. */
const REGISTRY_PATH = "data/registry/beaches.us.json";

/** A beach plus its distance/bearing from a query point. */
export type RankedBeach = BeachEntry & { distanceMi: number; bearingDeg: number };

/** Narrow an unknown parsed value to a usable BeachEntry, dropping junk rows. */
function isBeachEntry(v: unknown): v is BeachEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.name === "string" &&
    typeof e.lat === "number" &&
    Number.isFinite(e.lat) &&
    typeof e.lon === "number" &&
    Number.isFinite(e.lon) &&
    typeof e.state === "string"
  );
}

/**
 * Load the US beach registry from `data/registry/beaches.us.json`. Returns the
 * parsed, validated entries, or [] if the file is missing, unreadable, not JSON,
 * not an array, or contains no valid rows. Never throws.
 */
export function loadBeachRegistry(registryPath: string = REGISTRY_PATH): BeachEntry[] {
  try {
    const file = path.isAbsolute(registryPath)
      ? registryPath
      : path.join(process.cwd(), registryPath);
    const raw = readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isBeachEntry);
  } catch {
    return [];
  }
}

/** Query parameters for {@link nearestBeaches}. */
export interface NearestQuery {
  lat: number;
  lon: number;
  /** Max results to return (default 5). */
  limit?: number;
  /** Discard beaches farther than this many statute miles (default 30). */
  maxMiles?: number;
}

/**
 * Nearest coast-confirmed beaches to a query point. Excludes entries explicitly
 * flagged `coastalConfirmed: false` (inland false-positives), keeps those within
 * `maxMiles`, sorts ascending by distance, and returns the top `limit`. Distance
 * and bearing are computed once via the shared haversine/bearing helpers.
 */
export function nearestBeaches(
  reg: BeachEntry[],
  q: NearestQuery,
): RankedBeach[] {
  const limit = q.limit ?? 5;
  const maxMiles = q.maxMiles ?? 30;
  return reg
    .filter((b) => b.coastalConfirmed !== false)
    .map((b) => ({
      ...b,
      distanceMi: round(haversineMiles(q.lat, q.lon, b.lat, b.lon), 2),
      bearingDeg: round(bearingDeg(q.lat, q.lon, b.lat, b.lon), 0),
    }))
    .filter((b) => b.distanceMi <= maxMiles)
    .sort((a, b) => a.distanceMi - b.distanceMi)
    .slice(0, limit);
}

/** Split a beach name into lowercased word tokens (drops punctuation). */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Find beaches matching a free-text name, case-insensitively. A row matches when
 * the query is a substring of the beach name, or when every query token appears
 * among the name's tokens (so "south beach" matches "South Beach Park", and
 * "beach south" still matches). Matches may span multiple states — the caller
 * disambiguates. Returns [] for a blank query.
 */
export function matchBeachByName(reg: BeachEntry[], name: string): BeachEntry[] {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];
  const tokens = tokenize(name);
  return reg.filter((b) => {
    const hay = b.name.toLowerCase();
    if (hay.includes(needle)) return true;
    if (!tokens.length) return false;
    const nameTokens = new Set(tokenize(b.name));
    return tokens.every((t) => nameTokens.has(t));
  });
}
