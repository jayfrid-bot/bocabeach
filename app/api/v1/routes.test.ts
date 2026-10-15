import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConditionsResponse } from "@/lib/types";

vi.mock("@/lib/watchViewCache", () => ({ peekWatchView: vi.fn(), storeWatchView: vi.fn(async () => true) }));

vi.mock("@/lib/conditions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/conditions")>();
  return { ...actual, getConditions: vi.fn() };
});

import * as listRoute from "@/app/api/v1/beaches/route";
import * as beachRoute from "@/app/api/v1/beaches/[slug]/route";
import * as nearestRoute from "@/app/api/v1/nearest/route";
import * as openapiRoute from "@/app/api/v1/openapi.json/route";
import { GET as listGET, OPTIONS as listOPTIONS } from "@/app/api/v1/beaches/route";
import { GET as beachGET } from "@/app/api/v1/beaches/[slug]/route";
import { GET as nearestGET } from "@/app/api/v1/nearest/route";
import { GET as openapiGET } from "@/app/api/v1/openapi.json/route";
import { getConditions } from "@/lib/conditions";
import { peekWatchView, storeWatchView } from "@/lib/watchViewCache";
import { resetAgentRateLimit } from "@/lib/agent/rateLimit";
import { BUILT_MS, conditionsFor, warmView, req } from "@/lib/agent/testkit";

const mocked = vi.mocked(getConditions);
const cached = vi.mocked(peekWatchView);
const beach = (slug: string, qs = "", headers?: HeadersInit) =>
  beachGET(req(`/api/v1/beaches/${slug}${qs}`, { headers }), { params: Promise.resolve({ slug }) });

let logs: string[];
beforeEach(() => {
  resetAgentRateLimit();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => void logs.push(String(s)));
  mocked.mockImplementation(async (slug: string) => conditionsFor(slug));
  // A warm shared cache by default; tests for a cold cache override this.
  cached.mockImplementation(async (slug: string) => warmView(slug));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BUILT_MS);
});
afterEach(() => {
  mocked.mockReset();
  cached.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const expectPublicHeaders = (res: Response) => {
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(res.headers.get("Set-Cookie")).toBeNull();
};

describe("GET /api/v1/beaches", () => {
  it("lists every beach with CORS, no cookies and an hour of edge cache", async () => {
    const res = await listGET(req("/api/v1/beaches"));
    expect(res.status).toBe(200);
    expectPublicHeaders(res);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=3600");
    const body = await res.json();
    expect(body.count).toBe(body.beaches.length);
    expect(body.count).toBeGreaterThanOrEqual(39);
    expect(Object.keys(body.beaches[0]).sort()).toEqual(["lat", "lon", "name", "region", "slug", "state", "url"]);
    expect(mocked).not.toHaveBeenCalled();
  });

  it("filters by state (code or name) and region", async () => {
    const fl = await (await listGET(req("/api/v1/beaches?state=Florida"))).json();
    expect(fl.beaches.every((b: { state: string }) => b.state === "FL")).toBe(true);
    const broward = await (await listGET(req("/api/v1/beaches?region=broward"))).json();
    expect(broward.beaches.map((b: { slug: string }) => b.slug)).toContain("deerfield-beach");
    const none = await (await listGET(req("/api/v1/beaches?state=FL&region=zzz"))).json();
    expect(none).toEqual({ count: 0, beaches: [] });
  });

  it("answers bad input with one error shape", async () => {
    const bad = await listGET(req("/api/v1/beaches?state=Atlantis"));
    expect(bad.status).toBe(400);
    expectPublicHeaders(bad);
    expect(bad.headers.get("Cache-Control")).toBe("no-store");
    const body = await bad.json();
    expect(body.error.code).toBe("bad_request");
    expect(typeof body.error.message).toBe("string");
    expect((await listGET(req("/api/v1/beaches?x=1"))).status).toBe(400);
  });

  it("refuses non-canonical filters instead of guessing or cutting them", async () => {
    const bad = [
      "?state=", "?state=%20FL", "?state=FL%20", "?region=", "?region=%20Broward",
      `?region=${"x".repeat(81)}`, `?state=${"F".repeat(41)}`, "?state=FL&state=GA",
    ];
    for (const qs of bad) {
      const res = await listGET(req(`/api/v1/beaches${qs}`));
      expect(res.status, qs).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    }
    // An 80-character region is the longest allowed.
    expect((await listGET(req(`/api/v1/beaches?region=${"x".repeat(80)}`))).status).toBe(200);
  });

  it("answers a CORS preflight", () => {
    const res = listOPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });
});

describe("GET /api/v1/beaches/{slug}", () => {
  it("returns the watch fields plus link, summary, attribution and safety note", async () => {
    const res = await beach("boca-raton");
    expect(res.status).toBe(200);
    expectPublicHeaders(res);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=60");
    const text = await res.text();
    expect(text.length).toBeLessThan(4096);
    const b = JSON.parse(text);
    expect(b.v).toBe(1);
    expect(b.slug).toBe("boca-raton");
    expect(b.url).toBe("https://isitbeachday.com/");
    expect(typeof b.score).toBe("number");
    expect(b.rating).toBeTruthy();
    expect(b.lines.length).toBeGreaterThan(0);
    expect(b.summary).toContain("Boca Raton");
    expect(b.summary).toContain(`${b.score}/100`);
    expect(b.safetyNote).toBe("Lifeguard flags and posted warnings always win.");
    expect(b.attribution.credit).toBe("Score by Is It Beach Day — isitbeachday.com");
    expect(b.attribution.dataSources.length).toBeGreaterThan(2);
    expect(b.updatedAt).toBe(b.generatedAt);
    expect(Date.parse(b.validUntil)).toBeGreaterThan(Date.parse(b.capturedAt));
  });

  it("matches the Apple Watch route for the same beach (one code path)", async () => {
    const { GET: watchGET } = await import("@/app/api/watch/[slug]/route");
    const watch = await (await watchGET(req("/api/watch/boca-raton"), { params: Promise.resolve({ slug: "boca-raton" }) })).json();
    const agent = await (await beach("boca-raton")).json();
    for (const key of ["score", "rating", "band", "limitedData", "lines", "waterTempF", "generatedAt", "validUntil"]) {
      expect(agent[key], key).toEqual(watch[key]);
    }
  });

  it("caches for min(60 s, time left)", async () => {
    vi.setSystemTime(BUILT_MS + (15 * 60 - 20) * 1000);
    expect((await beach("boca-raton")).headers.get("Cache-Control")).toBe("public, s-maxage=20");
  });

  it("counts the cache time from the clock when the response is made, after any slow step", async () => {
    // 60 s of validity left when the view is built; the recent-view write then takes 40 s.
    vi.setSystemTime(BUILT_MS + 14 * 60 * 1000);
    vi.mocked(storeWatchView).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 40_000);
      return true;
    });
    const res = await beach("boca-raton");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=20");
  });

  it("never serves a reading that is already past its validUntil: 503 with Retry-After, never cached", async () => {
    // e.g. a stale value from the conditions cache that is still refreshing.
    vi.setSystemTime(BUILT_MS + 15 * 60 * 1000);
    const res = await beach("boca-raton");
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("30");
    const body = await res.json();
    expect(body.error.code).toBe("unavailable");
    expect(body.score).toBeUndefined();
    // And one that expires during the recent-view write is refused too.
    vi.setSystemTime(BUILT_MS + 14 * 60 * 1000 + 30_000);
    vi.mocked(storeWatchView).mockImplementationOnce(async () => {
      vi.setSystemTime(BUILT_MS + 16 * 60 * 1000);
      return true;
    });
    // The view is built at 14:30, valid 30 s more; the clock jumps past that before it is served.
    expect((await beach("boca-raton")).status).toBe(503);
  });

  it("returns a cacheable 404 for an unknown or malformed slug, without touching the pipeline for junk", async () => {
    const unknown = await beach("nope");
    expect(unknown.status).toBe(404);
    expectPublicHeaders(unknown);
    expect(unknown.headers.get("Cache-Control")).toBe("public, s-maxage=300");
    expect((await unknown.json()).error.code).toBe("not_found");
    mocked.mockClear();
    for (const bad of ["Boca Raton", "../x", "a--b", "x".repeat(65)]) expect((await beach(bad)).status).toBe(404);
    expect(mocked).not.toHaveBeenCalled();
  });

  it("rejects any query string", async () => {
    const res = await beach("boca-raton", "?x=1");
    expect(res.status).toBe(400);
    expect(mocked).not.toHaveBeenCalled();
  });

  it("503s with no-store when the build was incomplete, and never leaks the internal flag", async () => {
    mocked.mockImplementation(async (slug: string) => ({ ...conditionsFor(slug)!, budgetAborted: true }) as ConditionsResponse);
    const res = await beach("boca-raton");
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("30");
    expect((await res.json()).error.code).toBe("unavailable");
  });

  it("turns an unexpected failure into the error shape", async () => {
    mocked.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await beach("boca-raton");
    expect(res.status).toBe(500);
    expectPublicHeaders(res);
    expect((await res.json()).error.code).toBe("internal_error");
  });

  it("carries no Plus, device or webcam fields", async () => {
    const text = await (await beach("boca-raton")).text();
    for (const word of ["deviceId", "installToken", "cam", "image", "snapshot", "entitled", "email"]) {
      expect(text.toLowerCase(), word).not.toContain(word.toLowerCase());
    }
  });
});

describe("GET /api/v1/nearest", () => {
  const near = (qs: string) => nearestGET(req(`/api/v1/nearest${qs}`));

  it("returns the nearest beaches without scores by default; never cached because the URL holds a location", async () => {
    const res = await near("?lat=26.36&lon=-80.06&limit=3");
    expect(res.status).toBe(200);
    expectPublicHeaders(res);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const b = await res.json();
    expect(b.count).toBe(3);
    expect(b.scored).toBe(0);
    expect(b.beaches[0].slug).toBe("boca-raton");
    expect(b.beaches[0].conditions).toBeUndefined();
    expect(b.beaches[0].distanceMiles).toBeLessThan(2);
    expect(mocked).not.toHaveBeenCalled();
    expect(cached).not.toHaveBeenCalled();
  });

  it("echoes the point rounded to 2 decimals, while distances use the exact point", async () => {
    const exact = await (await near("?lat=26.361234&lon=-80.064567&limit=1")).json();
    expect(exact.query).toEqual({ lat: 26.36, lon: -80.06, limit: 1 });
    expect(JSON.stringify(exact)).not.toContain("26.361234");
    expect(JSON.stringify(exact)).not.toContain("80.064567");
    const neg = await (await near("?lat=-0.001&lon=0.004&limit=1")).json();
    expect(Object.is(neg.query.lat, -0)).toBe(false);
    expect(neg.query).toEqual({ lat: 0, lon: 0, limit: 1 });
  });

  it("defaults to 5 beaches", async () => {
    expect((await (await near("?lat=26.36&lon=-80.06")).json()).count).toBe(5);
  });

  it("scores at most 3 beaches from the cache without building anything", async () => {
    const res = await near("?lat=26.36&lon=-80.06&limit=10&scores=true");
    const b = await res.json();
    expect(b.count).toBe(10);
    expect(b.scored).toBe(3);
    expect(cached).toHaveBeenCalledTimes(3);
    expect(mocked).not.toHaveBeenCalled();
    expect(b.beaches.slice(0, 3).every((x: { conditions: { score: number } }) => typeof x.conditions.score === "number")).toBe(true);
    expect(b.beaches[3].conditions).toBeUndefined();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("with a cold cache builds at most ONE beach (the nearest) and names the rest", async () => {
    cached.mockResolvedValue(null);
    const b = await (await near("?lat=26.36&lon=-80.06&limit=3&scores=true")).json();
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked).toHaveBeenCalledWith("boca-raton", { ovVersion: "0" });
    expect(b.scored).toBe(1);
    expect(b.beaches[0].conditions.score).toEqual(expect.any(Number));
    expect(b.beaches[1].conditions).toBeNull();
    expect(b.beaches[2].conditions).toBeNull();
    expect(b.note).toContain(b.beaches[1].slug);
    expect(b.note).toContain(b.beaches[2].slug);
    expect(b.note).toMatch(/Not scored right now/);
  });

  it("never ranks or shows a stored view that has expired by the time it is returned", async () => {
    cached.mockImplementation(async (slug: string) => warmView(slug));
    // The one cold build is slow: the clock passes every stored view's validUntil while it runs.
    cached.mockImplementationOnce(async () => null); // boca-raton is not stored, so it is the one built
    mocked.mockImplementation(async (slug: string) => {
      const c = conditionsFor(slug);
      vi.setSystemTime(BUILT_MS + 16 * 60 * 1000);
      return c;
    });
    const b = await (await near("?lat=26.36&lon=-80.06&limit=3&scores=true")).json();
    expect(b.scored).toBe(0);
    expect(b.beaches.every((x: { conditions: unknown }) => x.conditions === null)).toBe(true);
    expect(b.note).toMatch(/Not scored right now/);
  });

  it("a stored view that turns out expired is eligible for the one cold build, like a missing one", async () => {
    const past = new Date(BUILT_MS - 60_000).toISOString();
    cached.mockImplementation(async (slug: string) => ({ ...warmView(slug)!, validUntil: past }));
    const b = await (await near("?lat=26.36&lon=-80.06&limit=3&scores=true")).json();
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked).toHaveBeenCalledWith("boca-raton", { ovVersion: "0" }); // the nearest wins
    expect(b.scored).toBe(1);
    expect(b.beaches[0].conditions.score).toEqual(expect.any(Number));
    expect(b.beaches[1].conditions).toBeNull();
    expect(b.beaches[2].conditions).toBeNull();
  });

  it("a failed build is reported, not shown as an answer", async () => {
    cached.mockResolvedValue(null);
    mocked.mockResolvedValue(null);
    const b = await (await near("?lat=26.36&lon=-80.06&limit=2&scores=true")).json();
    expect(b.scored).toBe(0);
    expect(b.beaches[0].conditions).toBeNull();
  });

  it("says so when nothing is close", async () => {
    const b = await (await near("?lat=0&lon=0&limit=1")).json();
    expect(b.note).toMatch(/Nothing is close/);
  });

  it("validates ranges and refuses non-canonical spellings with a 400", async () => {
    const bad = [
      "", "?lat=26", "?lon=-80", "?lat=91&lon=0", "?lat=0&lon=181", "?lat=abc&lon=0", "?lat=&lon=0",
      "?lat=1e1&lon=0", "?lat=0&lon=0&limit=0", "?lat=0&lon=0&limit=11", "?lat=0&lon=0&limit=2.5",
      "?lat=0&lon=0&scores=maybe", "?lat=0&lon=0&extra=1", "?lat=0&lat=1&lon=0",
      // non-canonical:
      "?lat=026.35&lon=0", "?lat=%2B1&lon=0", "?lat=%201&lon=0", "?lat=1%20&lon=0", "?lat=.5&lon=0", "?lat=5.&lon=0",
      "?lat=-0&lon=0", "?lat=0&lon=0&limit=03", "?lat=0&lon=0&limit=%203", "?lat=0&lon=0&scores=1", "?lat=0&lon=0&scores=0",
      "?lat=0&lon=0&scores=TRUE", "?lat=0&lon=0&scores=",
    ];
    for (const qs of bad) {
      const res = await near(qs);
      expect(res.status, qs).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    }
    expect(mocked).not.toHaveBeenCalled();
    expect(cached).not.toHaveBeenCalled();
    // And the canonical forms pass.
    for (const qs of ["?lat=0&lon=0", "?lat=-0.5&lon=10&limit=10&scores=false", "?lat=26.35&lon=-80.07&scores=true"]) {
      expect((await near(qs)).status, qs).toBe(200);
    }
  });

  it("never logs the coordinates", async () => {
    await near("?lat=26.36&lon=-80.06");
    const joined = logs.join("\n");
    expect(joined).not.toContain("26.36");
    expect(joined).not.toContain("80.06");
  });
});

describe("GET /api/v1/openapi.json", () => {
  it("serves the spec with CORS", async () => {
    const res = await openapiGET(req("/api/v1/openapi.json"));
    expect(res.status).toBe(200);
    expectPublicHeaders(res);
    expect((await res.json()).openapi).toBe("3.1.0");
  });
  it("takes no query string", async () => {
    const res = await openapiGET(req("/api/v1/openapi.json?x=1"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
  });
});

describe("methods other than GET", () => {
  const routes: Array<[string, Record<string, unknown>]> = [
    ["/api/v1/beaches", listRoute],
    ["/api/v1/beaches/boca-raton", beachRoute],
    ["/api/v1/nearest", nearestRoute],
    ["/api/v1/openapi.json", openapiRoute],
  ];
  it("answer 405 in the JSON error shape, with CORS and Allow", async () => {
    for (const [path, mod] of routes) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const handler = mod[method] as (r: Request, c?: unknown) => Promise<Response> | Response;
        expect(typeof handler, `${path} ${method}`).toBe("function");
        const res = await handler(req(path, { method }), { params: Promise.resolve({ slug: "boca-raton" }) });
        expect(res.status, `${path} ${method}`).toBe(405);
        expectPublicHeaders(res);
        expect(res.headers.get("Allow")).toBe("GET, OPTIONS");
        expect((await res.json()).error.code).toBe("method_not_allowed");
      }
    }
  });
});

describe("rate limiting and request counter", () => {
  it("answers 429 with Retry-After and CORS once an IP is over its burst, per IP", async () => {
    const from = (ip: string) => listGET(req("/api/v1/beaches", { headers: { "cf-connecting-ip": ip, "user-agent": "ChatGPT-User/1.0" } }));
    let last: Response | undefined;
    for (let i = 0; i < 41; i++) last = await from("203.0.113.9");
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expectPublicHeaders(last!);
    expect(last!.headers.get("Cache-Control")).toBe("no-store");
    expect((await last!.json()).error.code).toBe("rate_limited");
    // Another address is untouched.
    expect((await from("203.0.113.10")).status).toBe(200);
  });

  it("logs one counter line per request with the user-agent family and no address", async () => {
    await listGET(req("/api/v1/beaches", { headers: { "cf-connecting-ip": "198.51.100.7", "user-agent": "Claude-User/1.0 (+https://anthropic.com)" } }));
    expect(logs).toHaveLength(1);
    const line = JSON.parse(logs[0]);
    expect(line).toMatchObject({ evt: "agent_api", route: "/api/v1/beaches", status: 200, ua: "claude", method: "GET" });
    expect(logs[0]).not.toContain("198.51.100.7");
    expect(logs[0]).not.toContain("anthropic.com");
  });
});
