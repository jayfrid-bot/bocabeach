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

  it("rejects any query string before touching the pipeline", async () => {
    const res = await GET(...req("boca-raton", "?x=1"));
    expect(res.status).toBe(400);
    expect(getConditions).not.toHaveBeenCalled();
  });

  it("returns a small view, edge-cached like the conditions route", async () => {
    vi.mocked(getConditions).mockResolvedValue(JSON.parse(JSON.stringify(fixture)) as ConditionsResponse);
    const res = await GET(...req("boca-raton"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, stale-while-revalidate=600");
    const text = await res.text();
    expect(text.length).toBeLessThan(2048);
    const body = JSON.parse(text);
    expect(body.v).toBe(1);
    expect(body.slug).toBe("boca-raton");
    expect(body.lines.length).toBeGreaterThan(0);
    expect(body.budgetAborted).toBeUndefined();
  });

  it("lets an incomplete (budget-aborted) build expire fast", async () => {
    vi.mocked(getConditions).mockResolvedValue({ ...(JSON.parse(JSON.stringify(fixture)) as ConditionsResponse), budgetAborted: true });
    const res = await GET(...req("boca-raton"));
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=20");
  });
});
