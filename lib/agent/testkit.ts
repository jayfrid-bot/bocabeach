// Test helpers for the agent surface. Imported only by *.test.ts files.

import fixture from "@/lib/__fixtures__/boca-2026-09-04-phantom-rain.json";
import { getLocation } from "@/config/locations";
import { buildWatchView, type WatchView } from "@/lib/watchView";
import type { ConditionsResponse } from "@/lib/types";

/** When the fixture's snapshot was built. Pin the clock near this for stable cache headers. */
export const BUILT_MS = Date.parse(fixture.snapshot.generatedAt);

/** The Boca fixture re-labelled as another beach (score and lines are the fixture's). */
export function conditionsFor(slug: string): ConditionsResponse | null {
  const loc = getLocation(slug);
  if (!loc) return null;
  const copy = JSON.parse(JSON.stringify(fixture)) as ConditionsResponse;
  copy.snapshot.location = { ...copy.snapshot.location, slug: loc.slug, name: loc.name, region: loc.region, lat: loc.lat, lon: loc.lon };
  return copy;
}

/** What a warm recent-view store would hold for this beach right now (the Boca fixture, re-labelled). */
export function warmView(slug: string): WatchView | null {
  const c = conditionsFor(slug);
  return c ? buildWatchView(c, Date.now()) : null;
}

export function req(path: string, init?: RequestInit): Request {
  return new Request(`https://isitbeachday.com${path}`, init);
}

export function rpc(method: string, params?: unknown, id: number | string = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
}

/**
 * A POST to /mcp. Sends `MCP-Protocol-Version: 2025-06-18` like a real client after
 * initialize; pass `"mcp-protocol-version": "none"` to leave it out.
 */
export function post(body: string, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
    ...headers,
  };
  if (h["mcp-protocol-version"] === "none") delete h["mcp-protocol-version"];
  return req("/mcp", { method: "POST", body, headers: h });
}
