import { LOCATIONS } from "@/config/locations";

/**
 * Allowlist of cam id -> upstream snapshot URL, derived from the location config.
 * The /api/cam/[id] proxy only fetches URLs that appear here, so a caller can
 * never coerce the proxy into fetching an arbitrary host (SSRF guard).
 */
export const CAM_SNAPSHOTS: Record<string, string> = Object.fromEntries(
  LOCATIONS.flatMap((loc) =>
    loc.cams
      .filter((c) => c.id && c.snapshotUrl)
      .map((c) => [c.id as string, c.snapshotUrl as string]),
  ),
);

/** Resolve a cam id to its upstream snapshot URL, or undefined if not allowlisted. */
export function snapshotUrlForId(id: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(CAM_SNAPSHOTS, id)
    ? CAM_SNAPSHOTS[id]
    : undefined;
}
