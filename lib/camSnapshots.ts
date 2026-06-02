import { LOCATIONS } from "@/config/locations";

/**
 * A cam's live-still source, keyed by cam id. The /api/cam/[id] proxy only serves
 * ids present here, so a caller can never coerce it into fetching an arbitrary
 * host (SSRF guard). Two kinds:
 *  - "direct": a fixed upstream JPEG URL (proxied as-is).
 *  - "feed":   a video-monitoring.com base dir whose latest.json names the most
 *              recent frame per view; we resolve + proxy that frame.
 */
export type CamSource =
  | { kind: "direct"; url: string }
  | { kind: "feed"; base: string; view: string; res: "mr" | "hr" };

export const CAM_SOURCES: Record<string, CamSource> = Object.fromEntries(
  LOCATIONS.flatMap((loc) =>
    loc.cams.flatMap((c): [string, CamSource][] => {
      if (!c.id) return [];
      if (c.snapshotUrl) return [[c.id, { kind: "direct", url: c.snapshotUrl }]];
      if (c.snapshotFeed) {
        const { base, view, res } = c.snapshotFeed;
        return [[c.id, { kind: "feed", base, view, res: res ?? "mr" }]];
      }
      return [];
    }),
  ),
);

/** Resolve a cam id to its allowlisted source, or undefined if not allowlisted. */
export function camSourceForId(id: string): CamSource | undefined {
  return Object.prototype.hasOwnProperty.call(CAM_SOURCES, id)
    ? CAM_SOURCES[id]
    : undefined;
}

/** Pull the most-recent frame path for a view out of a parsed latest.json. */
export function pickFeedFramePath(
  json: unknown,
  view: string,
  res: "mr" | "hr",
): string | undefined {
  const entry = (json as Record<string, Record<string, unknown>> | null)?.[view];
  const path = entry?.[res] ?? entry?.mr ?? entry?.hr;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

/**
 * Resolve a feed's (relative) frame path against its base dir, rejecting anything
 * that escapes that dir — so a tampered latest.json can't redirect the proxy to
 * another host or path (SSRF guard). Returns an absolute URL.
 */
export function resolveFeedImageUrl(base: string, framePath: string): string {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  const resolved = new URL(framePath, prefix).href;
  if (!resolved.startsWith(prefix)) {
    throw new Error("resolved cam frame escapes its allowlisted base");
  }
  return resolved;
}
