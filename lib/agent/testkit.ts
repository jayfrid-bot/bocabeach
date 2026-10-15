// Test helpers for the agent surface. Imported only by *.test.ts files.

import fixture from "@/lib/__fixtures__/boca-2026-09-04-phantom-rain.json";
import { getLocation } from "@/config/locations";
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

export function req(path: string, init?: RequestInit): Request {
  return new Request(`https://isitbeachday.com${path}`, init);
}

export function rpc(method: string, params?: unknown, id: number | string = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
}

export function post(body: string, headers: Record<string, string> = {}): Request {
  return req("/mcp", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  });
}
