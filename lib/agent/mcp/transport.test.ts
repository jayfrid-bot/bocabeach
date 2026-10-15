// The /mcp transport: batches, buffered replies with a correct Content-Length on every path,
// 202 for notifications, and one SSE event for a client that accepts only text/event-stream.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/watchViewCache", () => ({ peekWatchView: vi.fn(), storeWatchView: vi.fn(async () => true) }));
vi.mock("@/lib/conditions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/conditions")>();
  return { ...actual, getConditions: vi.fn() };
});

import { DELETE, GET, OPTIONS, POST } from "@/app/mcp/route";
import { getConditions } from "@/lib/conditions";
import { peekWatchView } from "@/lib/watchViewCache";
import { resetAgentRateLimit } from "@/lib/agent/rateLimit";
import { MCP_MAX_BATCH, MCP_MAX_BATCH_TOOL_CALLS, MCP_MAX_BODY_BYTES } from "@/lib/agent/constants";
import { BUILT_MS, conditionsFor, warmView, post, req, rpc } from "@/lib/agent/testkit";

const mocked = vi.mocked(getConditions);
const INIT = { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } };
const msg = (method: string, id?: number, params?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) });

beforeEach(() => {
  resetAgentRateLimit();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  mocked.mockImplementation(async (slug: string) => conditionsFor(slug));
  vi.mocked(peekWatchView).mockImplementation(async (slug: string) => warmView(slug));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BUILT_MS);
});
afterEach(() => {
  mocked.mockReset();
  vi.mocked(peekWatchView).mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The answer is whole: Content-Length matches the bytes, and nothing is chunked. */
async function expectBuffered(res: Response, label: string) {
  const bytes = (await res.clone().arrayBuffer()).byteLength;
  expect(res.headers.get("Content-Length"), `${label} content-length`).toBe(String(bytes));
  expect(res.headers.get("Transfer-Encoding"), `${label} transfer-encoding`).toBeNull();
  return bytes;
}

describe("batches (2025-03-26 clients)", () => {
  it("answers a batch with an array, in order, skipping notifications", async () => {
    const body = `[${msg("initialize", 1, INIT)},${msg("notifications/initialized")},${msg("ping", 2)},${msg("tools/list", 3)}]`;
    const res = await POST(post(body));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    await expectBuffered(res, "batch");
    const out = await res.json();
    expect(Array.isArray(out)).toBe(true);
    expect(out.map((m: { id: number }) => m.id)).toEqual([1, 2, 3]);
    expect(out[0].result.protocolVersion).toBe("2025-03-26");
    expect(out[2].result.tools).toHaveLength(5);
  });

  it("a batch of only notifications and client responses is 202 with no body", async () => {
    const body = `[${msg("notifications/initialized")},{"jsonrpc":"2.0","id":9,"result":{}}]`;
    const res = await POST(post(body));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Content-Length")).toBe("0");
  });

  it("gives a bad element its own error and still answers the rest", async () => {
    const out = await (await POST(post(`[${msg("ping", 1)},5,{"hello":"world"},${msg("nope/method", 2)}]`))).json();
    expect(out).toHaveLength(4);
    expect(out[0]).toMatchObject({ id: 1, result: {} });
    expect(out[1].error.code).toBe(-32600);
    expect(out[2].error.code).toBe(-32600);
    expect(out[3]).toMatchObject({ id: 2, error: { code: -32601 } });
  });

  it("checks MCP-Protocol-Version once for the whole batch, unless it holds initialize", async () => {
    const batch = `[${msg("ping", 1)}]`;
    expect((await POST(post(batch, { "mcp-protocol-version": "2020-01-01" }))).status).toBe(400);
    expect((await POST(post(batch, { "mcp-protocol-version": "2025-03-26" }))).status).toBe(200);
    expect((await POST(post(`[${msg("initialize", 1, INIT)}]`, { "mcp-protocol-version": "2020-01-01" }))).status).toBe(200);
  });

  it("caps the batch size, and allows ONE tools/call per batch (each can start a build, a batch is one rate-limit token)", async () => {
    const many = `[${Array.from({ length: MCP_MAX_BATCH + 1 }, (_, i) => msg("ping", i + 1)).join(",")}]`;
    const tooMany = await POST(post(many));
    expect(tooMany.status).toBe(400);
    await expectBuffered(tooMany, "too many");
    expect(MCP_MAX_BATCH_TOOL_CALLS).toBe(1);
    const call = (i: number) => msg("tools/call", i, { name: "get_beach_score", arguments: { slug: "boca-raton" } });
    const out = await (await POST(post(`[${msg("ping", 9)},${call(1)},${call(2)},${call(3)},${msg("tools/list", 8)}]`))).json();
    expect(out).toHaveLength(5);
    expect(out[0].result).toEqual({});
    expect(out[1].result.content[0].text).toContain("Boca Raton");
    for (const i of [2, 3]) {
      expect(out[i].error.message).toMatch(/at most 1 tools\/call/);
      expect(out[i].error.message).toMatch(/own POST/);
    }
    expect(out[4].result.tools).toHaveLength(5); // cheap methods are not capped
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("an empty batch is an invalid request", async () => {
    const res = await POST(post("[]"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
  });
});

describe("202 for notifications and client responses", () => {
  it("is 202, empty, Content-Length 0, never a 200 with no body", async () => {
    for (const body of [msg("notifications/initialized"), msg("notifications/cancelled"), '{"jsonrpc":"2.0","id":3,"result":{}}', '{"jsonrpc":"2.0","id":3,"error":{"code":-1,"message":"x"}}']) {
      const res = await POST(post(body));
      expect(res.status, body).toBe(202);
      expect(res.headers.get("Content-Length"), body).toBe("0");
      expect(res.headers.get("Content-Type"), body).toBeNull();
      expect((await res.arrayBuffer()).byteLength, body).toBe(0);
    }
  });
});

describe("every response is buffered with a correct Content-Length", () => {
  const big = rpc("tools/call", { name: "list_beaches", arguments: { region: "x".repeat(MCP_MAX_BODY_BYTES) } });
  const cases: Array<[string, () => Response | Promise<Response>]> = [
    ["initialize", () => POST(post(rpc("initialize", { ...INIT, protocolVersion: "2025-11-25" })))],
    ["tools/list", () => POST(post(rpc("tools/list")))],
    ["tools/call ok", () => POST(post(rpc("tools/call", { name: "get_beach_score", arguments: { slug: "boca-raton" } })))],
    ["tools/call outlook", () => POST(post(rpc("tools/call", { name: "get_beach_outlook", arguments: { slug: "boca-raton" } })))],
    ["tool error", () => POST(post(rpc("tools/call", { name: "get_beach_score", arguments: {} })))],
    ["unknown method", () => POST(post(rpc("resources/list")))],
    ["non-ASCII text", () => POST(post(rpc("tools/call", { name: "list_beaches", arguments: { region: "Boca" } })))],
    ["bad json", () => POST(post("{nope"))],
    ["not json-rpc", () => POST(post('{"a":1}'))],
    ["too large (header)", () => POST(post(big, { "content-length": String(big.length) }))],
    ["bad content-type", () => POST(post(rpc("ping"), { "content-type": "text/plain" }))],
    ["bad accept", () => POST(post(rpc("ping"), { accept: "text/html" }))],
    ["bad version header", () => POST(post(rpc("ping"), { "mcp-protocol-version": "1999-01-01" }))],
    ["forbidden origin", () => POST(post(rpc("ping"), { origin: "https://evil.example" }))],
    ["allowed origin", () => POST(post(rpc("ping"), { origin: "https://isitbeachday.com" }))],
    ["sse", () => POST(post(rpc("ping"), { accept: "text/event-stream" }))],
    ["GET 405", () => GET(req("/mcp"))],
    ["DELETE 405", () => DELETE(req("/mcp", { method: "DELETE" }))],
    ["GET 403", () => GET(req("/mcp", { headers: { origin: "https://evil.example" } }))],
    ["preflight 403", () => OPTIONS(req("/mcp", { method: "OPTIONS", headers: { origin: "https://evil.example" } }))],
  ];
  for (const [label, run] of cases) {
    it(label, async () => {
      const res = await run();
      const bytes = await expectBuffered(res, label);
      expect(bytes).toBeGreaterThan(0);
      if (res.headers.get("Content-Type")?.includes("json")) JSON.parse(await res.text()); // a complete JSON body
    });
  }

  it("counts bytes, not characters, for text with non-ASCII characters", async () => {
    const res = await POST(post(rpc("tools/call", { name: "get_beach_score", arguments: { slug: "boca-raton" } })));
    const text = await res.text();
    expect(text).toMatch(/[^\x00-\x7f]/); // the credit line has an em dash
    expect(Number(res.headers.get("Content-Length"))).toBe(new TextEncoder().encode(text).byteLength);
    expect(Number(res.headers.get("Content-Length"))).toBeGreaterThan(text.length);
  });

  it("a rate-limited answer is complete JSON with Content-Length and Retry-After", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 125; i++) last = await POST(post(rpc("ping"), { "cf-connecting-ip": "203.0.113.77" }));
    expect(last!.status).toBe(429);
    await expectBuffered(last!, "429");
    expect(last!.headers.get("Retry-After")).toBeTruthy();
    expect((await last!.json()).error.code).toBe(-32029);
  });

  it("sets Vary: Origin when it echoes an origin, and never a wildcard", async () => {
    const res = await POST(post(rpc("ping"), { origin: "https://app.isitbeachday.com" }));
    expect(res.headers.get("Vary")).toBe("Origin");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.isitbeachday.com");
    expect(res.headers.get("Vary")).not.toMatch(/rsc|next-router/i);
  });
});

describe("a client that accepts only text/event-stream", () => {
  const sse = { accept: "text/event-stream" };

  it("gets one SSE event with the JSON-RPC message, buffered", async () => {
    const res = await POST(post(rpc("tools/list", undefined, 5), sse));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expectBuffered(res, "sse");
    const text = await res.text();
    expect(text.startsWith("event: message\ndata: ")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(true);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(2); // the JSON is on one line
    const json = JSON.parse(lines[1].slice("data: ".length));
    expect(json).toMatchObject({ jsonrpc: "2.0", id: 5 });
    expect(json.result.tools).toHaveLength(5);
  });

  it("also wraps errors and batches", async () => {
    const err = await POST(post("{bad", sse));
    expect(err.status).toBe(400);
    expect(err.headers.get("Content-Type")).toBe("text/event-stream");
    await expectBuffered(err, "sse error");
    expect(await err.text()).toMatch(/^event: message\ndata: \{.*-32700.*\}\n\n$/);
    const batch = await POST(post(`[${msg("ping", 1)},${msg("ping", 2)}]`, sse));
    const data = (await batch.text()).split("\n")[1].slice(6);
    expect(JSON.parse(data)).toHaveLength(2);
  });

  it("a notification is still 202 with no body", async () => {
    const res = await POST(post(msg("notifications/initialized"), sse));
    expect(res.status).toBe(202);
    expect(res.headers.get("Content-Length")).toBe("0");
  });

  it("prefers JSON when the client accepts both, or anything", async () => {
    for (const accept of ["application/json, text/event-stream", "*/*", "text/event-stream, application/json", "text/event-stream, */*;q=0.1"]) {
      const res = await POST(post(rpc("ping"), { accept }));
      expect(res.headers.get("Content-Type"), accept).toBe("application/json");
    }
  });

  it("a wildcard alone does not turn into SSE", async () => {
    expect((await POST(post(rpc("ping"), { accept: "application/json;q=0, */*" }))).status).toBe(406);
  });
});

describe("Accept is relaxed", () => {
  it("absent, empty, */*, application/json and application/* all get JSON", async () => {
    const noAccept = new Request("https://isitbeachday.com/mcp", { method: "POST", body: rpc("ping"), headers: { "content-type": "application/json" } });
    expect((await POST(noAccept)).status).toBe(200);
    for (const accept of ["", "*/*", "application/json", "application/*", "APPLICATION/JSON", "application/json; charset=utf-8"]) {
      const res = await POST(post(rpc("ping"), { accept }));
      expect(res.status, accept).toBe(200);
      expect(res.headers.get("Content-Type"), accept).toBe("application/json");
    }
  });
});

describe("a stateless server", () => {
  it("gives every initialize the same answer and keeps nothing between calls", async () => {
    const a = await (await POST(post(rpc("initialize", INIT)))).json();
    const b = await (await POST(post(rpc("initialize", INIT), { "mcp-session-id": "zzz" }))).json();
    expect(b).toEqual(a);
  });
});
