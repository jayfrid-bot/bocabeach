// Handler-level tests for GET /api/conditions/[slug]: the 404 path, the
// budgetAborted-stripping, and — Codex round 2/3/4 — the `?fresh=1` literal
// (components/ConditionsDashboard.tsx's staleness retry): a fixed 20-s
// shared edge entry, never a per-caller uncached rebuild amplifier, with
// any OTHER query string rejected before getConditions is ever called.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConditionsResponse } from "@/lib/types";

vi.mock("@/lib/conditions", () => ({
  getConditions: vi.fn(),
}));

import { GET } from "@/app/api/conditions/[slug]/route";
import { getConditions } from "@/lib/conditions";

function fixture(over: Partial<ConditionsResponse> = {}): ConditionsResponse {
  return {
    snapshot: { generatedAt: "2026-09-23T12:00:00.000Z" } as ConditionsResponse["snapshot"],
    score: { score: 80 } as ConditionsResponse["score"],
    hourlyScores: [],
    multiDayWindows: [],
    cams: [],
    ...over,
  };
}

function req(slug: string, qs = ""): [Request, { params: Promise<{ slug: string }> }] {
  return [
    new Request(`https://x/api/conditions/${slug}${qs}`),
    { params: Promise.resolve({ slug }) },
  ];
}

afterEach(() => {
  vi.mocked(getConditions).mockReset();
});

describe("GET /api/conditions/[slug]", () => {
  it("404s for an unknown slug", async () => {
    vi.mocked(getConditions).mockResolvedValue(null);
    const res = await GET(...req("not-a-real-beach"));
    expect(res.status).toBe(404);
  });

  it("strips budgetAborted from the public response", async () => {
    vi.mocked(getConditions).mockResolvedValue(fixture({ budgetAborted: true }));
    const res = await GET(...req("boca-raton"));
    const body = await res.json();
    expect(body.budgetAborted).toBeUndefined();
  });

  it("is edge-cacheable for a plain request", async () => {
    vi.mocked(getConditions).mockResolvedValue(fixture());
    const res = await GET(...req("boca-raton"));
    expect(res.headers.get("cache-control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=600",
    );
  });

  it("?fresh=1 gets a short, SHARED edge cache window, not no-store", async () => {
    vi.mocked(getConditions).mockResolvedValue(fixture());
    const res = await GET(...req("boca-raton", "?fresh=1"));
    // Codex round 3: NOT no-store — a unique-value/no-store cache-buster let
    // every stale-boundary visitor (or an attacker) force its own uncached
    // rebuild. `s-maxage=20`, no stale-while-revalidate, means every client
    // asking during the same 20s window shares ONE edge entry.
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=20");
  });

  it("any OTHER query string 400s with bad-query, cached briefly, and never calls getConditions", async () => {
    vi.mocked(getConditions).mockResolvedValue(fixture());
    for (const qs of ["?fresh=1758628800000", "?fresh=true", "?fresh=2", "?fresh=", "?other=1", "?fresh=1&x=1"]) {
      const res = await GET(...req("boca-raton", qs));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({ error: "bad-query" });
      expect(res.headers.get("cache-control")).toBe("public, s-maxage=300");
    }
    expect(getConditions).not.toHaveBeenCalled();
  });

  it("still returns the same data for a ?fresh=1 request — the param never changes what's fetched", async () => {
    const data = fixture();
    vi.mocked(getConditions).mockResolvedValue(data);
    await GET(...req("boca-raton", "?fresh=1"));
    expect(getConditions).toHaveBeenCalledWith("boca-raton");
  });
});
