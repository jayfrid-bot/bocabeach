// Handler-level tests for the /api/cam/[id] proxy. The handler is called
// directly with a Request + params, so there is no server and no real network
// — `fetch` is stubbed per test.

import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/cam/[id]/route";

function req(id: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`https://x/api/cam/${id}`),
    { params: Promise.resolve({ id }) },
  ];
}

function imageResponse(headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "image/jpeg", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/cam/[id] — direct source, X-Grabbed-At forwarding", () => {
  // deerfield-beach-cam is a `direct` source (config/locations.ts) pointed at
  // the uw-frame courier, which stamps its own true capture time on the frame.
  const ID = "deerfield-beach-cam";

  it("forwards a valid upstream X-Grabbed-At header to the client", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => imageResponse({ "X-Grabbed-At": "2026-09-14T15:40:00.000Z" })),
    );

    const res = await GET(...req(ID));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Grabbed-At")).toBe("2026-09-14T15:40:00.000Z");
  });

  it("omits X-Grabbed-At when the upstream doesn't send one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse()));

    const res = await GET(...req(ID));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Grabbed-At")).toBeNull();
  });

  it("drops a malformed (non-date) X-Grabbed-At rather than forwarding garbage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => imageResponse({ "X-Grabbed-At": "not-a-date" })),
    );

    const res = await GET(...req(ID));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Grabbed-At")).toBeNull();
  });
});

describe("GET /api/cam/[id] — feed source never gets a forwarded header", () => {
  // boca-inlet is a `feed` (video-monitoring.com latest.json) source, not a
  // `direct` courier — even a stray X-Grabbed-At on its image response must
  // not leak through, since it isn't this cam's honest capture time.
  const ID = "boca-inlet";

  it("never forwards X-Grabbed-At for a feed-kind source", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("latest.json")) {
          return new Response(
            JSON.stringify({ s4: { mr: "s4/frame.jpg", timestamp: 1780361972 } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // The resolved frame image — even if it carried the header, a feed
        // source must not forward it (only `direct` couriers are trusted for it).
        return imageResponse({ "X-Grabbed-At": "2026-09-14T15:40:00.000Z" });
      }),
    );

    const res = await GET(...req(ID));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Grabbed-At")).toBeNull();
  });
});

describe("GET /api/cam/[id] — unchanged behavior", () => {
  it("404s for an unknown cam id (SSRF allowlist)", async () => {
    const res = await GET(...req("not-a-real-cam"));
    expect(res.status).toBe(404);
  });

  it("502s when the upstream fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    const res = await GET(...req("deerfield-beach-cam"));

    expect(res.status).toBe(502);
  });
});
