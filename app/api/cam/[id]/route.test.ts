// Handler-level tests for the /api/cam/[id] proxy. The handler is called
// directly with a Request + params, so there is no server and no real network
// — `fetch` is stubbed per test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/cam/[id]/route";
import { resetAgentRateLimit, SCOPE_LIMITS } from "@/lib/agent/rateLimit";

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


describe("GET /api/cam/[id]?res=hr — the full-size original of a feed frame", () => {
  // boca-inlet is a `feed` cam on bocainlet view s4 (config/locations.ts).
  const ID = "boca-inlet";
  const SHOWN_AT = "2026-06-01T12:39:32.000Z"; // = unix 1780317572
  const FEED = {
    s4: {
      mr: "pics/s4/oct1226d/o181403_.jpg",
      hr: "pics/s4/oct1226d/o181403h.jpg",
      timestamp: Date.parse(SHOWN_AT) / 1000,
    },
  };
  const HR_URL = "https://video-monitoring.com/beachcams/bocainlet/pics/s4/oct1226d/o181403h.jpg";
  const MR_URL = "https://video-monitoring.com/beachcams/bocainlet/pics/s4/oct1226d/o181403_.jpg";

  // A JPEG header: SOI, then a start-of-frame marker for 4352x3264.
  const JPEG_4352 = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x0c, 0xc0, 0x11, 0x00, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);

  function stubFeed(feed: unknown = FEED) {
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        if (url.includes("latest.json")) {
          return new Response(JSON.stringify(feed), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JPEG_4352.slice(), { status: 200, headers: { "content-type": "image/jpeg" } });
      }),
    );
    return fetched;
  }

  function reqHr(id: string, at: string | null = SHOWN_AT, ip = "9.9.9.9"): [Request, { params: Promise<{ id: string }> }] {
    const q = at ? `res=hr&at=${encodeURIComponent(at)}` : "res=hr";
    return [new Request(`https://x/api/cam/${id}?${q}`, { headers: { "cf-connecting-ip": ip } }), { params: Promise.resolve({ id }) }];
  }

  /** A stand-in for caches.default: a Map keyed by URL. */
  function stubCache() {
    const store = new Map<string, Response>();
    const cache = {
      match: vi.fn(async (k: string) => store.get(k)?.clone()),
      put: vi.fn(async (k: string, r: Response) => void store.set(k, r)),
    };
    vi.stubGlobal("caches", { default: cache });
    return { store, cache };
  }

  beforeEach(() => resetAgentRateLimit());

  it("fetches the hr original when the frame shown is still the newest", async () => {
    const fetched = stubFeed();
    const res = await GET(...reqHr(ID));
    expect(res.status).toBe(200);
    expect(fetched.at(-1)).toBe(HR_URL);
    expect(res.headers.get("x-cam-original")).toBe("1");
    expect(res.headers.get("x-cam-original-size")).toBe("4352x3264");
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("serves the usual mr frame, with no original header, without the query", async () => {
    const fetched = stubFeed();
    const res = await GET(...req(ID));
    expect(fetched.at(-1)).toBe(MR_URL);
    expect(res.headers.get("x-cam-original")).toBeNull();
  });

  it("answers 409 and fetches nothing when the feed has a newer frame than the one shown", async () => {
    const fetched = stubFeed();
    const res = await GET(...reqHr(ID, "2026-06-01T12:30:00.000Z"));
    expect(res.status).toBe(409);
    expect(fetched.every((u) => u.includes("latest.json"))).toBe(true);
  });

  it("answers 409 when the viewer sends no capture time or a garbage one", async () => {
    stubFeed();
    expect((await GET(...reqHr(ID, null))).status).toBe(409);
    expect((await GET(...reqHr(ID, "not-a-date"))).status).toBe(409);
  });

  it("answers 404, not the normal frame, when the view has no original or only a video", async () => {
    for (const hr of [undefined, "pics/s4/oct1226d/o181403a.mp4"]) {
      const fetched = stubFeed({ s4: { ...FEED.s4, hr } });
      const res = await GET(...reqHr(ID));
      expect(res.status).toBe(404);
      expect(fetched.some((u) => u === MR_URL)).toBe(false);
    }
  });

  it("answers 404 for a courier cam: its frame is the one the courier grabbed", async () => {
    const fetched = stubFeed();
    const res = await GET(...reqHr("deerfield-beach-cam"));
    expect(res.status).toBe(404);
    expect(fetched).toHaveLength(0);
    expect((await GET(...reqHr("no-such-cam"))).status).toBe(404);
  });

  it("will not follow an original path that leaves the cam's folder", async () => {
    stubFeed({ s4: { mr: FEED.s4.mr, hr: "../../elsewhere/x.jpg", timestamp: FEED.s4.timestamp } });
    const res = await GET(...reqHr(ID));
    expect(res.status).toBe(502);
  });

  it("keeps the original in the Workers cache under its resolved URL and serves the next one from it", async () => {
    const { store, cache } = stubCache();
    const fetched = stubFeed();
    const first = await GET(...reqHr(ID));
    expect(first.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0)); // the store runs after the response
    const key = [...store.keys()][0];
    expect(decodeURIComponent(key)).toContain(HR_URL);
    expect(store.get(key)!.headers.get("cache-control")).toBe("public, max-age=600");
    expect(store.get(key)!.headers.get("x-cam-original-size")).toBe("4352x3264");

    const before = fetched.filter((u) => u === HR_URL).length;
    const second = await GET(...reqHr(ID));
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cam-original")).toBe("1");
    expect(second.headers.get("x-cam-original-size")).toBe("4352x3264");
    expect(second.headers.get("cache-control")).toBe("public, max-age=300");
    expect(fetched.filter((u) => u === HR_URL).length).toBe(before); // not fetched from the county again
    expect(cache.match).toHaveBeenCalledTimes(2);
  });

  it("a new capture is a new cache key, so a stale original is never served for it", async () => {
    const { store } = stubCache();
    stubFeed();
    await GET(...reqHr(ID));
    await new Promise((r) => setTimeout(r, 0));
    const newer = { s4: { ...FEED.s4, hr: "pics/s4/oct1226d/o181413h.jpg", timestamp: FEED.s4.timestamp + 600 } };
    const fetched = stubFeed(newer);
    const res = await GET(...reqHr(ID, new Date((FEED.s4.timestamp + 600) * 1000).toISOString()));
    expect(res.status).toBe(200);
    expect(fetched.at(-1)).toBe("https://video-monitoring.com/beachcams/bocainlet/pics/s4/oct1226d/o181413h.jpg");
    await new Promise((r) => setTimeout(r, 0));
    expect(store.size).toBe(2);
  });

  it("serves the normal still, without the original header, when the per-IP limit is tripped", async () => {
    const capacity = SCOPE_LIMITS.cam.capacity;
    const fetched = stubFeed();
    for (let i = 0; i < capacity; i++) {
      expect((await GET(...reqHr(ID))).headers.get("x-cam-original")).toBe("1");
    }
    const over = await GET(...reqHr(ID));
    expect(over.status).toBe(200);
    expect(over.headers.get("x-cam-original")).toBeNull();
    expect(fetched.at(-1)).toBe(MR_URL);
    // another visitor has their own budget
    expect((await GET(...reqHr(ID, SHOWN_AT, "8.8.8.8"))).headers.get("x-cam-original")).toBe("1");
  });

  it("does not spend the limit on a cache hit", async () => {
    stubCache();
    stubFeed();
    const capacity = SCOPE_LIMITS.cam.capacity;
    for (let i = 0; i < capacity + 5; i++) {
      const res = await GET(...reqHr(ID));
      await new Promise((r) => setTimeout(r, 0));
      expect(res.headers.get("x-cam-original")).toBe("1");
    }
  });
});
