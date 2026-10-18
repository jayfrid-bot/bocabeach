// The one signal a beach page or the conditions JSON gives the edge cache (lib/edgeCache.ts):
// "this answer is a complete conditions build, generated at <time>". A page carries it as
//   <meta name="ibd-edge" content="v1;gen=<ISO>;ok=1">
// and /api/conditions/<slug> as the response header `x-ibd-edge` with the same value.
//
// The edge cache stores a 200 beach page or conditions answer ONLY when the marker is present
// and says ok=1. So a page that is not a beach page, the "couldn't load conditions" fallback,
// a build that ran out of upstream budget (budgetAborted) and a total data outage are never
// stored: those keep rendering per request, as before.
//
// No imports except types: the Worker entry bundles this file outside Next.

import type { ConditionsResponse } from "./types";

export const EDGE_MARKER_NAME = "ibd-edge";
export const EDGE_DATA_HEADER = "x-ibd-edge";

type MarkerInput = {
  snapshot?: { generatedAt?: string } | null;
  score?: { dataAvailable?: boolean } | null;
  budgetAborted?: boolean;
};

/** The marker value for one conditions answer. ok=0 for a partial build or no usable data. */
export function edgeMarkerContent(data: MarkerInput | ConditionsResponse): string {
  const d = data as MarkerInput;
  const genIso = d.snapshot?.generatedAt ?? "";
  const genMs = Date.parse(genIso);
  const valid = Number.isFinite(genMs);
  const ok = valid && d.budgetAborted !== true && d.score?.dataAvailable !== false;
  return `v1;gen=${valid ? new Date(genMs).toISOString() : "none"};ok=${ok ? 1 : 0}`;
}

export interface EdgeMarker {
  /** When the snapshot was generated (ms since epoch). */
  generatedAtMs: number;
  /** True only for a complete build with usable data. */
  ok: boolean;
}

/** Parse a marker value; null for anything that is not exactly the v1 shape. */
export function parseEdgeMarkerContent(value: string | null | undefined): EdgeMarker | null {
  if (!value) return null;
  const m = /^v1;gen=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z);ok=([01])$/.exec(value.trim());
  if (!m) return null;
  const generatedAtMs = Date.parse(m[1]);
  if (!Number.isFinite(generatedAtMs)) return null;
  return { generatedAtMs, ok: m[2] === "1" };
}

const META_RE = /<meta name="ibd-edge" content="([^"<>]{1,120})"\s*\/?>/;

/** The marker of a rendered HTML page, or null when the page has none. */
export function findEdgeMarker(html: string): EdgeMarker | null {
  const m = META_RE.exec(html);
  return m ? parseEdgeMarkerContent(m[1]) : null;
}
