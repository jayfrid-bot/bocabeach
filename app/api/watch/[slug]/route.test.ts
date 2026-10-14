import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "@/lib/__fixtures__/boca-2026-09-04-phantom-rain.json";
import type { ConditionsResponse } from "@/lib/types";

vi.mock("@/lib/conditions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/conditions")>();
  return { ...actual, getConditions: vi.fn() };
});

import { GET } from "@/app/api/watch/[slug]/route";
import { getConditions } from "@/lib/conditions";

const req = (slug: string, qs = ""): [Request, { params: Promise<{ slug: string }> }] => [
  new Request(`https://x/api/watch/${slug}${qs}`),
  { params: Promise.resolve({ slug }) },
];

afterEach(() => vi.mocked(getConditions).mockReset());

describe("GET /api/watch/[slug]", () => {
  it("404s for an unknown beach", async () => {
    vi.mocked(getConditions).mockResolvedValue(null);
    expect((await GET(...req("nope"))).status).toBe(404);
  });

  it("404s a malformed slug without touching the pipeline, and lets the edge keep the 404", async () => {
    for (const bad of ["Boca Raton", "../x", "a--b", "x".repeat(65)]) {
      const res = await GET(...req(bad));
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300");
    }
    expect(getConditions).not.toHaveBeenCalled();
  });

  it("rejects any query string before touching the pipeline", async () => {
    const res = await GET(...req("boca-raton", "?x=1"));
    expect(res.status).toBe(400);
    expect(getConditions).not.toHaveBeenCalled();
  });

  it("returns a small view cached for at most a minute, with no stale-while-revalidate", async () => {
    vi.mocked(getConditions).mockResolvedValue(JSON.parse(JSON.stringify(fixture)) as ConditionsResponse);
    const res = await GET(...req("boca-raton"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=60");
    const text = await res.text();
    expect(text.length).toBeLessThan(2048);
    const body = JSON.parse(text);
    expect(body.v).toBe(1);
    expect(body.slug).toBe("boca-raton");
    expect(body.lines.length).toBeGreaterThan(0);
    expect(body.budgetAborted).toBeUndefined();
  });

  it("answers a budget-aborted (incomplete) build with 503 and no-store, never a view", async () => {
    vi.mocked(getConditions).mockResolvedValue({ ...(JSON.parse(JSON.stringify(fixture)) as ConditionsResponse), budgetAborted: true });
    const res = await GET(...req("boca-raton"));
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.error).toBe("incomplete");
    expect(body.v).toBeUndefined();
    expect(body.score).toBeUndefined();
  });
});
