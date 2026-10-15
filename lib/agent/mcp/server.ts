// A small, stateless MCP server over Streamable HTTP (spec revision 2025-06-18).
//
// Hand-rolled instead of @modelcontextprotocol/sdk: the SDK is not a dependency
// here, it needs zod and a transport built around Node streams and sessions, and a
// read-only server with four tools needs only four JSON-RPC methods. What this
// follows from the spec:
//   - POST /mcp, one JSON-RPC message per request (batches were removed in 2025-06-18).
//   - A request gets a JSON body (application/json, never an SSE stream).
//   - A notification or a response gets 202 Accepted with no body.
//   - ONLY revision 2025-06-18 is implemented, advertised and negotiated: initialize
//     answers 2025-06-18 whatever the client asks for. No Mcp-Session-Id is ever issued,
//     so there is nothing to store and nothing to expire.
//   - Origin is validated (spec MUST, DNS-rebinding protection): no Origin header is fine
//     (server-to-server connectors); a present Origin must be on ALLOWED_ORIGINS, else 403.
//   - POST needs Content-Type application/json (415). A present Accept must allow JSON (406).
//   - GET, DELETE and every other method answer 405 (no SSE stream, no session).
//   - tools/call: an unknown tool is a JSON-RPC error (-32602); bad arguments and
//     lookups that fail (unknown beach) come back as a tool result with isError true,
//     so the model can read the message and fix its call.
// No Durable Object, no KV, no cookies. Tool arguments are never logged.

import { MCP_MAX_BODY_BYTES, MCP_PATH, SAFETY_NOTE, SITE_URL, CREDIT } from "@/lib/agent/constants";
import { logAgentRequest } from "@/lib/agent/log";
import { checkAgentRateLimit } from "@/lib/agent/rateLimit";
import { validateJson } from "@/lib/agent/schema";
import { TOOLS, TOOLS_BY_NAME } from "@/lib/agent/mcp/tools";

export const LATEST_PROTOCOL_VERSION = "2025-06-18";
/** The only revision this server implements. Older clients (batching, legacy SSE) are not served. */
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION] as const;
/** Browser origins allowed to call /mcp. A request with no Origin header (a connector's server) is allowed. */
export const ALLOWED_ORIGINS: readonly string[] = ["https://isitbeachday.com", "https://app.isitbeachday.com"];
export const SERVER_INFO = {
  name: "isitbeachday",
  title: "Is It Beach Day",
  version: "1.0.0",
} as const;

export const SERVER_INSTRUCTIONS = [
  "Live beach conditions for dozens of US beaches: a 0-100 Beach Day score, swim-safety lines (lifeguard flags, rip currents, lightning, rain, weather alerts, water quality), water temperature and the best time today.",
  "Start with find_nearest_beach (if you have a location) or list_beaches, then get_beach_score. Use best_beach_today to choose among a few beaches.",
  `${SAFETY_NOTE} The score is guidance only. When you share a score, include the credit: ${CREDIT}.`,
].join(" ");

const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  // Implementation-defined server errors live in -32000..-32099.
  rateLimited: -32029,
  tooLarge: -32031,
} as const;

type RpcId = string | number | null;

function baseHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({ "Cache-Control": "no-store", "Content-Type": "application/json", ...extra });
}

type OriginCheck = { state: "none" } | { state: "ok"; origin: string } | { state: "bad" };

function checkOrigin(req: Request): OriginCheck {
  const origin = req.headers.get("origin");
  if (origin === null) return { state: "none" };
  return ALLOWED_ORIGINS.includes(origin) ? { state: "ok", origin } : { state: "bad" };
}

/** CORS only for an allowed browser origin, echoed back (never "*"). */
function withMcpCors(req: Request, res: Response): Response {
  const o = checkOrigin(req);
  if (o.state === "ok") {
    res.headers.set("Access-Control-Allow-Origin", o.origin);
    res.headers.set("Vary", "Origin");
    res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.headers.set("Access-Control-Allow-Headers", "Content-Type, Accept, MCP-Protocol-Version");
    res.headers.set("Access-Control-Expose-Headers", "Retry-After");
    res.headers.set("Access-Control-Max-Age", "86400");
  }
  return res;
}

function rpcError(id: RpcId, code: number, message: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status,
    headers: baseHeaders(extra),
  });
}

function rpcResult(id: RpcId, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: baseHeaders() });
}

function accepted(): Response {
  const h = baseHeaders();
  h.delete("Content-Type");
  return new Response(null, { status: 202, headers: h });
}

const forbiddenOrigin = (): Response =>
  rpcError(null, ERR.invalidRequest, "Origin not allowed.", 403);

export function mcpPreflight(req: Request): Response {
  if (checkOrigin(req).state === "bad") return forbiddenOrigin();
  const h = baseHeaders();
  h.delete("Content-Type");
  return withMcpCors(req, new Response(null, { status: 204, headers: h }));
}

/** GET, DELETE and any other method: no SSE stream, no sessions. A short description helps people who open the URL. */
export function mcpMethodNotAllowed(req: Request): Response {
  const res =
    checkOrigin(req).state === "bad"
      ? forbiddenOrigin()
      : withMcpCors(
          req,
          new Response(
            JSON.stringify({
              error: {
                code: "method_not_allowed",
                message: `This is a stateless MCP endpoint. Send JSON-RPC with POST ${MCP_PATH}. It opens no event stream and keeps no session.`,
              },
              server: SERVER_INFO,
              protocolVersion: LATEST_PROTOCOL_VERSION,
              tools: TOOLS.map((t) => t.name),
              docs: `${SITE_URL}/llms.txt`,
            }),
            { status: 405, headers: baseHeaders({ Allow: "POST, OPTIONS" }) },
          ),
        );
  logAgentRequest(req, { route: MCP_PATH, status: res.status });
  return res;
}

// ---- body reading -----------------------------------------------------------

type BodyRead = { ok: true; text: string } | { ok: false; reason: "too_large" | "unreadable" };

async function readBodyCapped(req: Request, maxBytes: number): Promise<BodyRead> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too_large" };
  if (!req.body) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(all) };
}

// ---- dispatch ---------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

interface Dispatched {
  response: Response;
  rpc?: string;
  tool?: string;
}

async function dispatch(msg: Record<string, unknown>): Promise<Dispatched> {
  const method = msg.method as string;
  const hasId = typeof msg.id === "string" || typeof msg.id === "number";

  if (!hasId) {
    // A notification (such as notifications/initialized): accept it and say nothing.
    if ("id" in msg && msg.id !== undefined) {
      return { response: rpcError(null, ERR.invalidRequest, "id must be a string or a number."), rpc: method };
    }
    return { response: accepted(), rpc: method };
  }
  const id = msg.id as RpcId;
  const params = msg.params;
  if (params !== undefined && !isObject(params)) {
    return { response: rpcError(id, ERR.invalidParams, "params must be an object."), rpc: method };
  }

  switch (method) {
    case "initialize": {
      // The spec's required fields. Only the protocolVersion VALUE is lenient: any string is
      // accepted and answered with the one revision this server implements.
      const p = isObject(params) ? params : {};
      const missing: string[] = [];
      if (typeof p.protocolVersion !== "string") missing.push("protocolVersion (string)");
      if (!isObject(p.capabilities)) missing.push("capabilities (object)");
      const ci = isObject(p.clientInfo) ? p.clientInfo : null;
      if (!ci) missing.push("clientInfo (object)");
      else {
        if (typeof ci.name !== "string") missing.push("clientInfo.name (string)");
        if (typeof ci.version !== "string") missing.push("clientInfo.version (string)");
      }
      if (missing.length) {
        return { rpc: method, response: rpcError(id, ERR.invalidParams, `initialize needs: ${missing.join(", ")}.`) };
      }
      return {
        rpc: method,
        response: rpcResult(id, {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        }),
      };
    }
    case "ping":
      return { rpc: method, response: rpcResult(id, {}) };
    case "tools/list":
      return {
        rpc: method,
        response: rpcResult(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: {
              title: t.title,
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true,
            },
          })),
        }),
      };
    case "tools/call": {
      if (!isObject(params) || typeof params.name !== "string") {
        return { rpc: method, response: rpcError(id, ERR.invalidParams, "tools/call needs params.name (a string).") };
      }
      const tool = TOOLS_BY_NAME.get(params.name);
      if (!tool) {
        return {
          rpc: method,
          response: rpcError(id, ERR.invalidParams, `Unknown tool "${params.name.slice(0, 64)}". Use tools/list to see the tools.`),
        };
      }
      const rawArgs = params.arguments;
      if (rawArgs !== undefined && !isObject(rawArgs)) {
        return { rpc: method, tool: tool.name, response: rpcError(id, ERR.invalidParams, "params.arguments must be an object.") };
      }
      const args = rawArgs ?? {};
      const problems = validateJson(args, tool.inputSchema);
      if (problems.length) {
        return {
          rpc: method,
          tool: tool.name,
          response: rpcResult(id, {
            isError: true,
            content: [{ type: "text", text: `Invalid arguments for ${tool.name}: ${problems.join("; ")}` }],
          }),
        };
      }
      try {
        const out = await tool.run(args);
        return {
          rpc: method,
          tool: tool.name,
          response: rpcResult(id, {
            content: [{ type: "text", text: out.text }],
            ...(out.data ? { structuredContent: out.data } : {}),
            ...(out.isError ? { isError: true } : {}),
          }),
        };
      } catch (e) {
        console.error("mcp tool error", tool.name, e instanceof Error ? e.message : "unknown");
        return {
          rpc: method,
          tool: tool.name,
          response: rpcResult(id, {
            isError: true,
            content: [{ type: "text", text: `${tool.name} failed on our side. Try again shortly. ${SAFETY_NOTE}` }],
          }),
        };
      }
    }
    default:
      // Not advertised (resources, prompts, completion, logging): say so plainly.
      return { rpc: method, response: rpcError(id, ERR.methodNotFound, `Method not found: ${method.slice(0, 64)}`) };
  }
}

function acceptsJson(accept: string | null): boolean {
  if (accept === null) return true; // lenient: a client that sends no Accept still gets JSON
  return accept
    .split(",")
    .map((t) => t.split(";")[0].trim().toLowerCase())
    .some((t) => t === "application/json" || t === "application/*" || t === "*/*");
}

export async function handleMcpPost(req: Request): Promise<Response> {
  const finish = (d: Dispatched, extra: { limited?: boolean } = {}) => {
    withMcpCors(req, d.response);
    logAgentRequest(req, { route: MCP_PATH, status: d.response.status, rpc: d.rpc, tool: d.tool, limited: extra.limited || undefined });
    return d.response;
  };

  const limit = await checkAgentRateLimit(req, "mcp");
  if (limit.limited) {
    return finish(
      { response: rpcError(null, ERR.rateLimited, "Too many requests. Retry after the Retry-After seconds.", 429, { "Retry-After": String(limit.retryAfterSec) }) },
      { limited: true },
    );
  }

  if (checkOrigin(req).state === "bad") return finish({ response: forbiddenOrigin() });

  const mediaType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return finish({ response: rpcError(null, ERR.invalidRequest, "Content-Type must be application/json.", 415) });
  }
  if (!acceptsJson(req.headers.get("accept"))) {
    return finish({ response: rpcError(null, ERR.invalidRequest, "Accept must allow application/json.", 406) });
  }

  // A missing MCP-Protocol-Version is allowed (this server keeps no session to tell it apart);
  // a present one must be the revision this server implements.
  const version = req.headers.get("mcp-protocol-version");
  if (version !== null && version !== LATEST_PROTOCOL_VERSION) {
    return finish({
      response: rpcError(null, ERR.invalidRequest, `Unsupported MCP-Protocol-Version "${version.slice(0, 20)}". Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`, 400),
    });
  }
  const body = await readBodyCapped(req, MCP_MAX_BODY_BYTES);
  if (!body.ok) {
    return body.reason === "too_large"
      ? finish({ response: rpcError(null, ERR.tooLarge, `Request body is over the ${MCP_MAX_BODY_BYTES / 1024} KB limit.`, 413) })
      : finish({ response: rpcError(null, ERR.parse, "Could not read the request body.", 400) });
  }

  let msg: unknown;
  try {
    msg = JSON.parse(body.text);
  } catch {
    return finish({ response: rpcError(null, ERR.parse, "Parse error: the body is not valid JSON.", 400) });
  }
  if (Array.isArray(msg)) {
    return finish({ response: rpcError(null, ERR.invalidRequest, "Batch requests are not supported. Send one JSON-RPC message per POST.", 400) });
  }
  if (!isObject(msg) || msg.jsonrpc !== "2.0") {
    return finish({ response: rpcError(null, ERR.invalidRequest, 'Invalid request: expected a JSON-RPC 2.0 object ("jsonrpc": "2.0").', 400) });
  }
  if (typeof msg.method !== "string") {
    // A response to a server request (we send none) is accepted and ignored.
    if ("result" in msg || "error" in msg) return finish({ response: accepted(), rpc: "response" });
    return finish({ response: rpcError(null, ERR.invalidRequest, "Invalid request: method must be a string.", 400) });
  }

  try {
    return finish(await dispatch(msg));
  } catch (e) {
    console.error("mcp dispatch error", e instanceof Error ? e.message : "unknown");
    return finish({ response: rpcError(typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null, ERR.internal, "Internal error.", 500), rpc: msg.method });
  }
}
