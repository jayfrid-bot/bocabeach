import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConditionsResponse } from "@/lib/types";

vi.mock("@/lib/watchViewCache", () => ({ peekWatchView: vi.fn(), storeWatchView: vi.fn(async () => true) }));

vi.mock("@/lib/conditions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/conditions")>();
  return { ...actual, getConditions: vi.fn() };
});

import { DELETE, GET, OPTIONS, PATCH, POST, PUT } from "@/app/mcp/route";
import { getConditions } from "@/lib/conditions";
import { peekWatchView } from "@/lib/watchViewCache";
import { resetAgentRateLimit } from "@/lib/agent/rateLimit";
import { MCP_MAX_BODY_BYTES } from "@/lib/agent/constants";
import { ALLOWED_ORIGINS, LATEST_PROTOCOL_VERSION } from "@/lib/agent/mcp/server";
import { BUILT_MS, conditionsFor, warmView, post, req, rpc } from "@/lib/agent/testkit";

const mocked = vi.mocked(getConditions);
const cached = vi.mocked(peekWatchView);
let logs: string[];

beforeEach(() => {
  resetAgentRateLimit();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => void logs.push(String(s)));
  mocked.mockImplementation(async (slug: string) => conditionsFor(slug));
  cached.mockImplementation(async (slug: string) => warmView(slug)); // warm shared cache
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BUILT_MS);
});
afterEach(() => {
  mocked.mockReset();
  cached.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const call = async (body: string, headers?: Record<string, string>) => {
  const res = await POST(post(body, headers));
  const text = await res.text();
  return { res, json: text ? JSON.parse(text) : null };
};
const tool = async (name: string, args?: unknown, id = 7) => {
  const { json } = await call(rpc("tools/call", { name, arguments: args }, id));
  return json;
};

const INIT = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "t", version: "1" },
};

describe("initialize", () => {
  it("answers with the one revision it implements, tools only, no session", async () => {
    const { res, json } = await call(rpc("initialize", INIT, "abc"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Mcp-Session-Id")).toBeNull();
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(json).toMatchObject({ jsonrpc: "2.0", id: "abc" });
    expect(json.result.protocolVersion).toBe("2025-06-18");
    expect(json.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(json.result.serverInfo.name).toBe("isitbeachday");
    expect(json.result.instructions).toContain("Lifeguard flags and posted warnings always win.");
  });

  it("answers 2025-06-18 whatever version the client asks for", async () => {
    for (const asked of ["2025-03-26", "2024-11-05", "1999-01-01", "2099-01-01", ""]) {
      const { json } = await call(rpc("initialize", { ...INIT, protocolVersion: asked }));
      expect(json.result.protocolVersion, asked).toBe(LATEST_PROTOCOL_VERSION);
    }
  });

  it("requires protocolVersion, capabilities and clientInfo (name, version)", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [undefined, /protocolVersion/],
      [{}, /protocolVersion/],
      [{ protocolVersion: 5, capabilities: {}, clientInfo: { name: "t", version: "1" } }, /protocolVersion/],
      [{ protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "1" } }, /capabilities/],
      [{ protocolVersion: "2025-06-18", capabilities: {} }, /clientInfo/],
      [{ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } }, /clientInfo\.version/],
      [{ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { version: "1" } }, /clientInfo\.name/],
    ];
    for (const [params, re] of cases) {
      const { json } = await call(rpc("initialize", params));
      expect(json.error.code).toBe(-32602);
      expect(json.error.message).toMatch(re);
    }
  });

  it("accepts the initialized notification with 202 and no body", async () => {
    const res = await POST(post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("answers ping", async () => {
    expect((await call(rpc("ping"))).json.result).toEqual({});
  });
});

describe("tools/list", () => {
  it("lists four read-only tools with descriptions and JSON schemas", async () => {
    const { json } = await call(rpc("tools/list"));
    const tools = json.result.tools as Array<Record<string, any>>;
    expect(tools.map((t) => t.name)).toEqual(["list_beaches", "get_beach_score", "find_nearest_beach", "best_beach_today"]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(60);
      expect(t.title).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.annotations.destructiveHint).toBe(false);
    }
    expect(tools[1].inputSchema.required).toEqual(["slug"]);
    expect(tools[2].inputSchema.properties.limit.maximum).toBe(5);
  });
});

describe("tools/call happy paths", () => {
  it("list_beaches returns text and structuredContent with attribution and the safety note", async () => {
    const json = await tool("list_beaches", { state: "FL" });
    const r = json.result;
    expect(r.isError).toBeUndefined();
    expect(r.content[0].type).toBe("text");
    expect(r.content[0].text).toContain("boca-raton");
    expect(r.content[0].text).toContain("Lifeguard flags and posted warnings always win.");
    expect(r.structuredContent.beaches.every((b: { state: string }) => b.state === "FL")).toBe(true);
    expect(r.structuredContent.safetyNote).toBe("Lifeguard flags and posted warnings always win.");
    expect(r.structuredContent.attribution.credit).toContain("Is It Beach Day");
    expect(mocked).not.toHaveBeenCalled();
  });

  it("get_beach_score returns the beach's view", async () => {
    const r = (await tool("get_beach_score", { slug: "boca-raton" })).result;
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Boca Raton");
    expect(r.content[0].text).toContain("Score by Is It Beach Day — isitbeachday.com");
    expect(r.structuredContent.slug).toBe("boca-raton");
    expect(typeof r.structuredContent.score).toBe("number");
    expect(r.structuredContent.safetyNote).toBeTruthy();
    expect(r.structuredContent.attribution.dataSources.length).toBeGreaterThan(0);
  });

  it("find_nearest_beach returns beaches, with scores only on request and never more than 3", async () => {
    const plain = (await tool("find_nearest_beach", { lat: 26.361234, lon: -80.064567 })).result;
    expect(JSON.stringify(plain)).not.toContain("26.361234");
    expect(plain.structuredContent.count).toBe(3);
    expect(plain.structuredContent.beaches[0].slug).toBe("boca-raton");
    expect(plain.content[0].text).toContain("slug: boca-raton");
    expect(mocked).not.toHaveBeenCalled();
    expect(cached).not.toHaveBeenCalled();
    const scored = (await tool("find_nearest_beach", { lat: 26.36, lon: -80.06, limit: 5, include_scores: true })).result;
    expect(scored.structuredContent.scored).toBe(3);
    expect(cached).toHaveBeenCalledTimes(3);
    expect(mocked).not.toHaveBeenCalled();
    expect(scored.structuredContent.safetyNote).toBeTruthy();
    expect(scored.structuredContent.query).toEqual({ lat: 26.36, lon: -80.06, limit: 5 });
  });

  it("find_nearest_beach says when nothing is close", async () => {
    const r = (await tool("find_nearest_beach", { lat: 0, lon: 0, limit: 1 })).result;
    expect(r.content[0].text).toMatch(/Nothing is close/);
  });

  it("best_beach_today ranks by score and says what it left out", async () => {
    // Give each beach a different cap so the order is decided by the score, not by distance.
    cached.mockImplementation(async (slug: string) => {
      const v = warmView(slug)!;
      if (slug === "deerfield-beach") Object.assign(v, { score: 90, rating: "Excellent", band: "excellent" });
      return v;
    });
    const r = (await tool("best_beach_today", { lat: 26.36, lon: -80.06, radius_miles: 100, compare: 3 })).result;
    const d = r.structuredContent;
    expect(d.comparedCount).toBe(3);
    expect(d.ranking).toHaveLength(3);
    expect(d.ranking.map((x: { rank: number }) => x.rank)).toEqual([1, 2, 3]);
    expect(d.ranking[0].score).toBeGreaterThanOrEqual(d.ranking[1].score);
    expect(d.ranking[0].slug).toBe("deerfield-beach");
    expect(d.ranking[0].score).toBe(90);
    expect(d.best.slug).toBe(d.ranking[0].slug);
    expect(d.ranking[0].distanceMiles).toBeDefined();
    expect(d.notCompared.length).toBeGreaterThan(0);
    expect(r.content[0].text).toContain("Best of 3 compared");
    expect(d.attribution.credit).toBeTruthy();
    expect(d.safetyNote).toBeTruthy();
  });

  it("best_beach_today by state compares the first few and caps at 5", async () => {
    const r = (await tool("best_beach_today", { state: "FL", compare: 5 })).result;
    expect(r.structuredContent.comparedCount).toBe(5);
    expect(cached).toHaveBeenCalledTimes(5);
    expect(mocked).not.toHaveBeenCalled();
    expect(r.structuredContent.notCompared.length).toBeGreaterThan(0);
    expect(r.content[0].text).toMatch(/Give lat and lon/);
  });

  it("best_beach_today reports beaches it could not build instead of failing", async () => {
    cached.mockImplementation(async (slug: string) => (slug === "boca-raton" ? null : warmView(slug)));
    mocked.mockImplementation(async (slug: string) => (slug === "boca-raton" ? null : conditionsFor(slug)));
    const d = (await tool("best_beach_today", { state: "FL", compare: 3 })).result.structuredContent;
    expect(d.skipped).toEqual([{ slug: "boca-raton", name: "Boca Raton", reason: "not_found" }]);
    expect(d.ranking).toHaveLength(2);
    expect(d.best).not.toBeNull();
  });

  it("best_beach_today builds at most ONE beach when the cache is cold, and names the rest", async () => {
    cached.mockResolvedValue(null);
    const r = (await tool("best_beach_today", { lat: 26.36, lon: -80.06, radius_miles: 250, compare: 5 })).result;
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked).toHaveBeenCalledWith("boca-raton"); // the nearest one
    const d = r.structuredContent;
    expect(d.comparedCount).toBe(5);
    expect(d.ranking).toHaveLength(1);
    expect(d.best.slug).toBe("boca-raton");
    expect(d.notComparedNow).toHaveLength(4);
    for (const n of d.notComparedNow) {
      expect(n).toEqual({ slug: expect.any(String), name: expect.any(String), reason: "no_recent_snapshot" });
      expect(r.content[0].text).toContain(n.slug);
    }
    expect(r.content[0].text).toMatch(/Not compared right now/);
    expect(d.skipped).toEqual([]);
  });

  it("best_beach_today with a warm cache builds nothing at all", async () => {
    const r = (await tool("best_beach_today", { state: "FL", compare: 5 })).result;
    expect(r.structuredContent.ranking).toHaveLength(5);
    expect(r.structuredContent.notComparedNow).toEqual([]);
    expect(mocked).not.toHaveBeenCalled();
  });

  it("best_beach_today with an empty area says so", async () => {
    const r = (await tool("best_beach_today", { lat: 0, lon: 0, radius_miles: 5 })).result;
    expect(r.structuredContent.best).toBeNull();
    expect(r.content[0].text).toMatch(/No covered beaches/);
  });
});

describe("tools/call errors", () => {
  it("an unknown tool is a JSON-RPC error", async () => {
    const json = await tool("drop_tables", {});
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toContain("Unknown tool");
  });

  it("invalid arguments come back as a tool error the model can read", async () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["get_beach_score", {}, /slug: is required/],
      ["get_beach_score", { slug: 5 }, /expected string/],
      ["get_beach_score", { slug: "Bad Slug" }, /wrong format/],
      ["get_beach_score", { slug: "boca-raton", extra: 1 }, /not a known field/],
      ["find_nearest_beach", { lat: 91, lon: 0 }, /at most 90/],
      ["find_nearest_beach", { lat: "26", lon: 0 }, /expected number/],
      ["find_nearest_beach", { lat: 1, lon: 1, limit: 6 }, /at most 5/],
      ["best_beach_today", { compare: 9, state: "FL" }, /at most 5/],
      ["list_beaches", { state: 3 }, /expected string/],
      ["list_beaches", { region: "x".repeat(81) }, /too long/],
    ];
    for (const [name, args, re] of cases) {
      const json = await tool(name, args);
      expect(json.result.isError, name).toBe(true);
      expect(json.result.content[0].text, name).toMatch(re);
    }
    expect(mocked).not.toHaveBeenCalled();
  });

  it("an unknown beach, an unknown state and a missing place are tool errors", async () => {
    expect((await tool("get_beach_score", { slug: "nope" })).result).toMatchObject({ isError: true });
    expect((await tool("get_beach_score", { slug: "nope" })).result.content[0].text).toContain("list_beaches");
    expect((await tool("list_beaches", { state: "Atlantis" })).result.isError).toBe(true);
    expect((await tool("list_beaches", { state: " FL" })).result.isError).toBe(true);
    expect((await tool("list_beaches", { region: "" })).result.isError).toBe(true);
    expect((await tool("best_beach_today", {})).result.isError).toBe(true);
    expect((await tool("best_beach_today", { lat: 26 })).result.isError).toBe(true);
  });

  it("a partial build is a tool error, not an answer", async () => {
    mocked.mockImplementation(async (slug: string) => ({ ...conditionsFor(slug)!, budgetAborted: true }) as ConditionsResponse);
    const r = (await tool("get_beach_score", { slug: "boca-raton" })).result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/temporarily incomplete/);
  });

  it("an unexpected throw is a tool error and leaks nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocked.mockRejectedValue(new Error("secret internal detail"));
    const r = (await tool("get_beach_score", { slug: "boca-raton" })).result;
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain("secret internal detail");
  });

  it("params must be well-formed", async () => {
    expect((await call(rpc("tools/call", { arguments: {} }))).json.error.code).toBe(-32602);
    expect((await call(rpc("tools/call", { name: "list_beaches", arguments: [] }))).json.error.code).toBe(-32602);
    expect((await call(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: "x" }))).json.error.code).toBe(-32602);
  });
});

describe("protocol errors", () => {
  it("bad JSON is a parse error with HTTP 400", async () => {
    const { res, json } = await call("{not json");
    expect(res.status).toBe(400);
    expect(json).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
  });

  it("a non-JSON-RPC body, a batch, and a bad method are invalid requests", async () => {
    expect((await call(JSON.stringify({ hello: "world" }))).res.status).toBe(400);
    expect((await call(JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" }))).json.error.code).toBe(-32600);
    const batch = await call(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]));
    expect(batch.res.status).toBe(400);
    expect(batch.json.error.message).toMatch(/Batch/);
    expect((await call(JSON.stringify({ jsonrpc: "2.0", id: 1, method: 5 }))).res.status).toBe(400);
    expect((await call("null")).res.status).toBe(400);
  });

  it("an unknown method is method-not-found", async () => {
    const { json } = await call(rpc("resources/list"));
    expect(json.error.code).toBe(-32601);
    expect(json.id).toBe(1);
  });

  it("a response from the client is accepted and ignored", async () => {
    const res = await POST(post(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })));
    expect(res.status).toBe(202);
  });

  it("refuses a body over the cap, by header and by streamed size", async () => {
    const big = rpc("tools/call", { name: "list_beaches", arguments: { region: "x".repeat(MCP_MAX_BODY_BYTES) } });
    const byHeader = await call(big, { "content-length": String(big.length) });
    expect(byHeader.res.status).toBe(413);
    expect(byHeader.json.error.code).toBe(-32031);
    // No Content-Length (chunked): the reader still stops at the cap.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const chunk = new TextEncoder().encode("x".repeat(4096));
        for (let i = 0; i < 10; i++) c.enqueue(chunk);
        c.close();
      },
    });
    const chunked = new Request("https://isitbeachday.com/mcp", {
      method: "POST",
      body: stream,
      headers: { "content-type": "application/json" },
      // @ts-expect-error Node's fetch needs duplex for a streamed body
      duplex: "half",
    });
    const res = await POST(chunked);
    expect(res.status).toBe(413);
  });

  it("accepts a body just under the cap", async () => {
    const pad = "x".repeat(MCP_MAX_BODY_BYTES - 200);
    const json = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad });
    expect(json.length).toBeLessThan(MCP_MAX_BODY_BYTES);
    expect((await call(json)).res.status).toBe(200);
  });

  it("requires Content-Type application/json (parameters allowed), and an Accept that allows JSON", async () => {
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "application/jsonx", ""]) {
      const res = await POST(post(rpc("ping"), { "content-type": ct }));
      expect(res.status, ct).toBe(415);
    }
    const noType = new Request("https://isitbeachday.com/mcp", { method: "POST", body: rpc("ping") });
    // A string body makes fetch add text/plain, which is also refused.
    expect((await POST(noType)).status).toBe(415);
    expect((await POST(post(rpc("ping"), { "content-type": "Application/JSON; charset=utf-8" }))).status).toBe(200);
    expect((await POST(post(rpc("ping"), { accept: "text/event-stream" }))).status).toBe(406);
    expect((await POST(post(rpc("ping"), { accept: "*/*" }))).status).toBe(200);
    // q=0 means "not acceptable"; any other q is fine.
    expect((await POST(post(rpc("ping"), { accept: "application/json;q=0" }))).status).toBe(406);
    expect((await POST(post(rpc("ping"), { accept: "application/json; q=0.0, text/event-stream" }))).status).toBe(406);
    expect((await POST(post(rpc("ping"), { accept: "*/*;q=0" }))).status).toBe(406);
    expect((await POST(post(rpc("ping"), { accept: "text/event-stream, application/json;q=0.5" }))).status).toBe(200);
    expect((await POST(post(rpc("ping"), { accept: "application/json, text/event-stream" }))).status).toBe(200);
  });

  it("accepts only the 2025-06-18 protocol version header", async () => {
    for (const v of ["2020-01-01", "2025-03-26", "2024-11-05", "2099-01-01", ""]) {
      expect((await POST(post(rpc("ping"), { "mcp-protocol-version": v }))).status, JSON.stringify(v)).toBe(400);
      // A wrong value is refused on initialize too.
      expect((await POST(post(rpc("initialize", INIT), { "mcp-protocol-version": v }))).status, `init ${JSON.stringify(v)}`).toBe(400);
    }
    expect((await POST(post(rpc("ping"), { "mcp-protocol-version": "2025-06-18" }))).status).toBe(200);
  });

  it("allows a missing MCP-Protocol-Version on initialize only", async () => {
    const none = { "mcp-protocol-version": "none" };
    expect((await POST(post(rpc("initialize", INIT), none))).status).toBe(200);
    const requests = [
      rpc("ping"),
      rpc("tools/list"),
      rpc("tools/call", { name: "list_beaches", arguments: {} }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
    ];
    for (const body of requests) {
      const res = await POST(post(body, none));
      expect(res.status, body).toBe(400);
      expect((await res.json()).error.message).toMatch(/MCP-Protocol-Version: 2025-06-18 is required/);
    }
    expect(mocked).not.toHaveBeenCalled();
  });

  it("allows no Origin and the site's own origins, and refuses any other with 403", async () => {
    expect((await POST(post(rpc("ping")))).status).toBe(200);
    for (const origin of ALLOWED_ORIGINS) {
      const res = await POST(post(rpc("ping"), { origin }));
      expect(res.status, origin).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(res.headers.get("Vary")).toBe("Origin");
    }
    for (const origin of [
      "https://evil.example", "http://isitbeachday.com", "https://isitbeachday.com.evil.example",
      "https://www.isitbeachday.com", "null", "http://localhost:3000", "https://isitbeachday.com/",
    ]) {
      const res = await POST(post(rpc("ping"), { origin }));
      expect(res.status, origin).toBe(403);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect((await res.json()).error.message).toMatch(/Origin/);
    }
    expect(mocked).not.toHaveBeenCalled();
  });

  it("sends no CORS headers when there is no Origin (a connector's server)", async () => {
    const res = await POST(post(rpc("ping")));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("GET, DELETE, PUT and PATCH are 405 with a short description", async () => {
    for (const handler of [GET, DELETE, PUT, PATCH]) {
      const res = handler(req("/mcp"));
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toContain("POST");
      const body = await res.json();
      expect(body.tools).toContain("get_beach_score");
      expect(body.protocolVersion).toBe("2025-06-18");
    }
    expect(GET(req("/mcp", { headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  it("answers a preflight only for an allowed origin", () => {
    const ok = OPTIONS(req("/mcp", { method: "OPTIONS", headers: { origin: "https://isitbeachday.com" } }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://isitbeachday.com");
    expect(ok.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(ok.headers.get("Access-Control-Allow-Headers")).toContain("MCP-Protocol-Version");
    expect(OPTIONS(req("/mcp", { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status).toBe(403);
    const bare = OPTIONS(req("/mcp", { method: "OPTIONS" }));
    expect(bare.status).toBe(204);
    expect(bare.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("guardrails", () => {
  it("rate limits per IP on its own, larger budget, with a JSON-RPC error and Retry-After", async () => {
    const hit = () => POST(post(rpc("ping"), { "cf-connecting-ip": "203.0.113.50", origin: "https://app.isitbeachday.com" }));
    let last: Response | undefined;
    // More than the REST burst (40) is fine on MCP.
    for (let i = 0; i < 120; i++) expect((last = await hit()).status).toBe(200);
    last = await hit();
    expect(last.status).toBe(429);
    expect(Number(last!.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(last!.headers.get("Access-Control-Allow-Origin")).toBe("https://app.isitbeachday.com");
    expect((await last!.json()).error.code).toBe(-32029);
    expect((await POST(post(rpc("ping"), { "cf-connecting-ip": "203.0.113.51" }))).status).toBe(200);
  });

  it("checks Origin before the limiter: refused origins do not spend the address's allowance", async () => {
    const ip = { "cf-connecting-ip": "203.0.113.99" };
    for (let i = 0; i < 300; i++) {
      expect((await POST(post(rpc("ping"), { ...ip, origin: "https://evil.example" }))).status).toBe(403);
    }
    // The victim's real traffic from the same address still has its whole budget.
    expect((await POST(post(rpc("ping"), ip))).status).toBe(200);
  });

  it("logs the method and tool name but never arguments or addresses", async () => {
    await POST(post(rpc("tools/call", { name: "find_nearest_beach", arguments: { lat: 26.123456, lon: -80.654321 } }), {
      "cf-connecting-ip": "198.51.100.77",
      "user-agent": "openai-mcp/1.0",
    }));
    expect(logs).toHaveLength(1);
    const line = JSON.parse(logs[0]);
    expect(line).toMatchObject({ evt: "agent_api", route: "/mcp", rpc: "tools/call", tool: "find_nearest_beach", status: 200, ua: "chatgpt" });
    expect(logs[0]).not.toContain("26.123456");
    expect(logs[0]).not.toContain("80.654321");
    expect(logs[0]).not.toContain("198.51.100.77");
  });
});
