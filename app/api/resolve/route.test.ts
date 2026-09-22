// Rate limiting + input validation for the public /api/resolve endpoint.
// resolveBeach itself (geocoding etc.) is mocked out — this only exercises
// the guard added around it: junk-query 400s and the per-IP fixed window.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetMemoryRateLimit } from "@/lib/plus/rateLimit";

vi.mock("@/lib/resolve/resolveLocation", () => ({
  resolveBeach: vi.fn(async () => ({
    status: "resolved",
    candidates: [],
    warnings: [],
    location: undefined,
  })),
}));
vi.mock("@/lib/resolve/emit", () => ({
  emitLocationSnippet: vi.fn(() => undefined),
  emitReport: vi.fn(() => "report"),
}));

import { GET } from "@/app/api/resolve/route";

function req(q: string, ip = "1.2.3.4"): Request {
  const url = q === "" ? "http://x/api/resolve" : `http://x/api/resolve?q=${encodeURIComponent(q)}`;
  return new Request(url, { headers: { "cf-connecting-ip": ip } });
}

beforeEach(() => {
  resetMemoryRateLimit();
});

describe("GET /api/resolve", () => {
  it("400s on an empty query", async () => {
    const res = await GET(req(""));
    expect(res.status).toBe(400);
  });

  it("400s on an overlong query (>200 chars)", async () => {
    const res = await GET(req("a".repeat(201)));
    expect(res.status).toBe(400);
  });

  it("allows up to 10 calls/hour/IP, then 429s with Retry-After", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await GET(req("miami beach"));
      expect(res.status).toBe(200);
    }
    const eleventh = await GET(req("miami beach"));
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("Retry-After")).toBeTruthy();
  });

  it("tracks limits per IP independently", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await GET(req("miami beach", "9.9.9.9"))).status).toBe(200);
    }
    expect((await GET(req("miami beach", "9.9.9.9"))).status).toBe(429);
    // A different IP still has its own budget.
    expect((await GET(req("miami beach", "8.8.8.8"))).status).toBe(200);
  });
});
