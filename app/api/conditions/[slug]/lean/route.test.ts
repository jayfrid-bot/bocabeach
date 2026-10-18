// GET /api/conditions/[slug]/lean — the page's own, packed copy of the conditions
// response. Same cache and query rules as the public route; the body is the wire
// form (lib/clientConditions.ts) and the public route is left exactly as it was.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConditionsResponse } from "@/lib/types";

vi.mock("@/lib/conditions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/conditions")>();
  return { ...actual, getConditions: vi.fn() };
});

import { GET } from "@/app/api/conditions/[slug]/lean/route";
import { getConditions } from "@/lib/conditions";
import { fromWire, isWire } from "@/lib/clientConditions";
import { EDGE_DATA_HEADER, parseEdgeMarkerContent } from "@/lib/edgeMarker";

const real = JSON.parse(
  readFileSync("lib/__fixtures__/conditions-boca-raton-2026-10-18.json", "utf8"),
) as ConditionsResponse;

function req(slug: string, qs = ""): [Request, { params: Promise<{ slug: string }> }] {
  return [new Request(`https://x/api/conditions/${slug}/lean${qs}`), { params: Promise.resolve({ slug }) }];
}

afterEach(() => vi.mocked(getConditions).mockReset());

describe("GET /api/conditions/[slug]/lean", () => {
  it("404s for an unknown slug", async () => {
    vi.mocked(getConditions).mockResolvedValue(null);
    expect((await GET(...req("nope"))).status).toBe(404);
  });

  it("answers with the wire form, which unpacks to the same snapshot", async () => {
    vi.mocked(getConditions).mockResolvedValue({ ...real, budgetAborted: true });
    const res = await GET(...req("boca-raton"));
    const body = await res.json();
    expect(isWire(body)).toBe(true);
    expect(body.budgetAborted).toBeUndefined();
    expect(JSON.stringify(body).length).toBeLessThan(60_000);
    expect(fromWire(body).snapshot.hourly.data).toEqual(real.snapshot.hourly.data);
    expect(fromWire(body).score).toEqual(real.score);
  });

  it("is edge-cacheable like the public route", async () => {
    vi.mocked(getConditions).mockResolvedValue(real);
    expect((await GET(...req("boca-raton"))).headers.get("cache-control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=600",
    );
    expect((await GET(...req("boca-raton", "?fresh=1"))).headers.get("cache-control")).toBe("public, s-maxage=20");
  });

  it("tells the edge cache the snapshot time, and ok=0 for a partial build", async () => {
    vi.mocked(getConditions).mockResolvedValue(real);
    const m = parseEdgeMarkerContent((await GET(...req("boca-raton"))).headers.get(EDGE_DATA_HEADER));
    expect(m).toEqual({ generatedAtMs: Date.parse(real.snapshot.generatedAt), ok: true });
    vi.mocked(getConditions).mockResolvedValue({ ...real, budgetAborted: true });
    const partial = parseEdgeMarkerContent((await GET(...req("boca-raton"))).headers.get(EDGE_DATA_HEADER));
    expect(partial?.ok).toBe(false);
  });

  it("rejects any other query string before it reaches the conditions pipeline", async () => {
    for (const qs of ["?fresh=true", "?other=1", "?fresh=1&x=1"]) {
      const res = await GET(...req("boca-raton", qs));
      expect(res.status).toBe(400);
    }
    expect(getConditions).not.toHaveBeenCalled();
  });
});
