// A small, stateless MCP server over Streamable HTTP.
//
// Hand-rolled instead of @modelcontextprotocol/sdk: the SDK is not a dependency
// here, it needs zod and a transport built around Node streams and sessions, and a
// read-only server with five tools needs only a few JSON-RPC methods. What this
// follows from the spec:
//   - POST /mcp. One JSON-RPC message per request, or a JSON array of them (a batch;
//     2025-03-26 clients send these, so they are accepted and answered with an array).
//   - Every answer is BUFFERED: the JSON is serialized to a string and sent with an explicit
//     Content-Length. Never a stream, never chunked. A notification, a response or a batch of
//     only those gets 202 with an empty body and Content-Length: 0 (never a 200 with no body).
//   - Revisions served: 2025-11-25, 2025-06-18, 2025-03-26. initialize answers the client's
//     protocolVersion when it is one of those, else the latest one (never an error).
//   - MCP-Protocol-Version: ignored on initialize (any value). On later requests it may be
//     missing (the latest behavior is assumed); a present value must be a served revision,
//     else 400 with the list. So a client may send it on every request, initialize included.
//   - No Mcp-Session-Id is ever issued; an incoming one is ignored. Nothing is stored.
//   - Origin is validated (spec MUST, DNS-rebinding protection): no Origin header is fine
//     (server-to-server connectors); a present Origin must be on ALLOWED_ORIGINS, else 403.
//   - POST needs Content-Type application/json (415). Accept: JSON when the client allows it
//     (absent, a star-slash-star range, application/json); a client that names only text/event-stream gets the same
//     message as ONE buffered SSE event (`event: message`, `data: <json>`, blank line); anything
//     else is 406. q=0 means not acceptable.
//   - GET, DELETE and every other method answer 405 (no SSE stream, no session).
//   - tools/call: an unknown tool is a JSON-RPC error (-32602); bad arguments and
//     lookups that fail (unknown beach) come back as a tool result with isError true,
//     so the model can read the message and fix its call (the 2025-11-25 rule for input
//     validation errors).
//   - Revision differences honored (2025-11-25 changed nothing for a tools-only server beyond
//     optional fields): serverInfo.title and tool `title` / `structuredContent` are sent only
//     when the request names a revision that has them (2025-06-18 and later); input schemas use
//     only keywords common to every JSON Schema dialect, so the 2020-12 default holds.
//     Capabilities advertised: tools only, listChanged false. No resources, prompts, logging,
//     completions, tasks, icons or sampling.
// No Durable Object, no KV, no cookies. Tool arguments are never logged.

import {
  MCP_MAX_BATCH,
  MCP_MAX_BATCH_TOOL_CALLS,
  MCP_MAX_BODY_BYTES,
  MCP_PATH,
  SAFETY_NOTE,
  SITE_URL,
  CREDIT,
} from "@/lib/agent/constants";
import { bufferedResponse } from "@/lib/agent/http";
import { logAgentRequest } from "@/lib/agent/log";
import { checkAgentRateLimit } from "@/lib/agent/rateLimit";
import { validateJson } from "@/lib/agent/schema";
import { TOOLS, TOOLS_BY_NAME } from "@/lib/agent/mcp/tools";

/** Newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];
export const LATEST_PROTOCOL_VERSION: ProtocolVersion = SUPPORTED_PROTOCOL_VERSIONS[0];

const isSupportedVersion = (v: string): v is ProtocolVersion => (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(v);
/** True when `v` is `min` or newer. */
const atLeast = (v: ProtocolVersion, min: ProtocolVersion): boolean =>
  SUPPORTED_PROTOCOL_VERSIONS.indexOf(v) <= SUPPORTED_PROTOCOL_VERSIONS.indexOf(min);

/** Browser origins allowed to call /mcp. A request with no Origin header (a connector's server) is allowed. */
export const ALLOWED_ORIGINS: readonly string[] = ["https://isitbeachday.com", "https://app.isitbeachday.com"];
export const SERVER_INFO = {
  name: "isitbeachday",
  title: "Is It Beach Day",
  version: "1.1.0",
} as const;
const SERVER_DESCRIPTION = "Live beach scores, swim-safety lines and a 3-day outlook for US beaches.";

export const SERVER_INSTRUCTIONS = [
  "Live beach conditions for dozens of US beaches: a 0-100 Beach Day score, swim-safety lines (lifeguard flags, rip currents, lightning, rain, weather alerts, water quality), water temperature and the best time today, plus a 1-3 day outlook.",
  "Start with find_nearest_beach (if you have a location) or list_beaches, then get_beach_score for now or get_beach_outlook for tomorrow and the next day. Use best_beach_today to choose among a few beaches today.",
  `${SAFETY_NOTE} The score is guidance only; the outlook is a forecast, not a guarantee. When you share a score, include the credit: ${CREDIT}.`,
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

/** One JSON-RPC response object. */
type RpcMessage = { jsonrpc: "2.0"; id: RpcId; result: unknown } | { jsonrpc: "2.0"; id: RpcId; error: { code: number; message: string } };

/** What to send back: a payload (an object, or an array for a batch) or null for 202. */
interface Reply {
  payload: RpcMessage | RpcMessage[] | null;
  status: number;
  headers?: Record<string, string>;
  rpc?: string;
  tool?: string;
}

const errMsg = (id: RpcId, code: number, message: string): RpcMessage => ({ jsonrpc: "2.0", id, error: { code, message } });
const okMsg = (id: RpcId, result: unknown): RpcMessage => ({ jsonrpc: "2.0", id, result });
const errReply = (id: RpcId, code: number, message: string, status = 200, headers?: Record<string, string>): Reply => ({
  payload: errMsg(id, code, message),
  status,
  headers,
});
const noContent = (rpc?: string): Reply => ({ payload: null, status: 202, rpc });

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
    res.headers.set("Access-Control-Allow-Headers", "Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id");
    res.headers.set("Access-Control-Expose-Headers", "Retry-After");
    res.headers.set("Access-Control-Max-Age", "86400");
  }
  return res;
}

type Mode = "json" | "sse";

/**
 * The one place a /mcp answer is turned into a Response: fully serialized, explicit
 * Content-Length, no streaming. An empty payload is 202 with Content-Length: 0.
 */
function toResponse(reply: Reply, mode: Mode): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store", ...reply.headers };
  if (reply.payload === null) return bufferedResponse(null, 202, headers);
  const json = JSON.stringify(reply.payload);
  if (mode === "sse") {
    // JSON.stringify never emits a raw newline, so the whole message is one `data:` line.
    return bufferedResponse(`event: message\ndata: ${json}\n\n`, reply.status, { ...headers, "Content-Type": "text/event-stream" });
  }
  return bufferedResponse(json, reply.status, { ...headers, "Content-Type": "application/json" });
}

const forbiddenOrigin = (): Reply => errReply(null, ERR.invalidRequest, "Origin not allowed.", 403);

export function mcpPreflight(req: Request): Response {
  if (checkOrigin(req).state === "bad") return withMcpCors(req, toResponse(forbiddenOrigin(), "json"));
  return withMcpCors(req, new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }));
}

/** GET, DELETE and any other method: no SSE stream, no sessions. A short description helps people who open the URL. */
export function mcpMethodNotAllowed(req: Request): Response {
  const res =
    checkOrigin(req).state === "bad"
      ? toResponse(forbiddenOrigin(), "json")
      : withMcpCors(
          req,
          bufferedResponse(
            JSON.stringify({
              error: {
                code: "method_not_allowed",
                message: `This is a stateless MCP endpoint. Send JSON-RPC with POST ${MCP_PATH}. It opens no event stream and keeps no session.`,
              },
              server: SERVER_INFO,
              protocolVersion: LATEST_PROTOCOL_VERSION,
              supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
              tools: TOOLS.map((t) => t.name),
              docs: `${SITE_URL}/llms.txt`,
            }),
            405,
            { "Cache-Control": "no-store", "Content-Type": "application/json", Allow: "POST, OPTIONS" },
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
  /** The JSON-RPC response for a request. */
  message: RpcMessage;
  rpc?: string;
  tool?: string;
}

/** `ver`: the revision the request names (header or negotiated); the latest when none. */
async function dispatch(msg: Record<string, unknown>, id: string | number, ver: ProtocolVersion): Promise<Dispatched> {
  const method = msg.method as string;
  const params = msg.params;
  if (params !== undefined && !isObject(params)) {
    return { message: errMsg(id, ERR.invalidParams, "params must be an object."), rpc: method };
  }

  switch (method) {
    case "initialize": {
      // The spec's required fields. Only the protocolVersion VALUE is lenient: a revision we
      // serve is echoed back; any other string gets the latest one (the client then decides).
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
        return { rpc: method, message: errMsg(id, ERR.invalidParams, `initialize needs: ${missing.join(", ")}.`) };
      }
      const asked = p.protocolVersion as string;
      const negotiated: ProtocolVersion = isSupportedVersion(asked) ? asked : LATEST_PROTOCOL_VERSION;
      const serverInfo: Record<string, string> = { name: SERVER_INFO.name, version: SERVER_INFO.version };
      if (atLeast(negotiated, "2025-06-18")) serverInfo.title = SERVER_INFO.title;
      if (atLeast(negotiated, "2025-11-25")) serverInfo.description = SERVER_DESCRIPTION;
      return {
        rpc: method,
        message: okMsg(id, {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions: SERVER_INSTRUCTIONS,
        }),
      };
    }
    case "ping":
      return { rpc: method, message: okMsg(id, {}) };
    case "tools/list":
      return {
        rpc: method,
        message: okMsg(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            ...(atLeast(ver, "2025-06-18") ? { title: t.title } : {}),
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
        return { rpc: method, message: errMsg(id, ERR.invalidParams, "tools/call needs params.name (a string).") };
      }
      const tool = TOOLS_BY_NAME.get(params.name);
      if (!tool) {
        return {
          rpc: method,
          message: errMsg(id, ERR.invalidParams, `Unknown tool "${params.name.slice(0, 64)}". Use tools/list to see the tools.`),
        };
      }
      const rawArgs = params.arguments;
      if (rawArgs !== undefined && !isObject(rawArgs)) {
        return { rpc: method, tool: tool.name, message: errMsg(id, ERR.invalidParams, "params.arguments must be an object.") };
      }
      const args = rawArgs ?? {};
      const problems = validateJson(args, tool.inputSchema);
      if (problems.length) {
        return {
          rpc: method,
          tool: tool.name,
          message: okMsg(id, {
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
          message: okMsg(id, {
            content: [{ type: "text", text: out.text }],
            ...(out.data && atLeast(ver, "2025-06-18") ? { structuredContent: out.data } : {}),
            ...(out.isError ? { isError: true } : {}),
          }),
        };
      } catch (e) {
        console.error("mcp tool error", tool.name, e instanceof Error ? e.message : "unknown");
        return {
          rpc: method,
          tool: tool.name,
          message: okMsg(id, {
            isError: true,
            content: [{ type: "text", text: `${tool.name} failed on our side. Try again shortly. ${SAFETY_NOTE}` }],
          }),
        };
      }
    }
    default:
      // Not advertised (resources, prompts, completion, logging): say so plainly.
      return { rpc: method, message: errMsg(id, ERR.methodNotFound, `Method not found: ${method.slice(0, 64)}`) };
  }
}

interface Processed {
  /** The response to send, or null when none is due (a notification or a client response). */
  message: RpcMessage | null;
  /** HTTP status if this were the only message in the POST. */
  status: number;
  rpc?: string;
  tool?: string;
}

/** One JSON-RPC message of any kind. Never throws. */
async function processMessage(msg: unknown, ver: ProtocolVersion): Promise<Processed> {
  if (!isObject(msg) || msg.jsonrpc !== "2.0") {
    return { message: errMsg(null, ERR.invalidRequest, 'Invalid request: expected a JSON-RPC 2.0 object ("jsonrpc": "2.0").'), status: 400 };
  }
  if (typeof msg.method !== "string") {
    // A response to a server request (we send none) is accepted and ignored.
    if ("result" in msg || "error" in msg) return { message: null, status: 202, rpc: "response" };
    return { message: errMsg(null, ERR.invalidRequest, "Invalid request: method must be a string."), status: 400 };
  }
  const method = msg.method;
  const id = msg.id;
  if (typeof id !== "string" && typeof id !== "number") {
    // A notification (such as notifications/initialized): accept it and say nothing.
    if ("id" in msg && id !== undefined) {
      return { message: errMsg(null, ERR.invalidRequest, "id must be a string or a number."), status: 200, rpc: method };
    }
    return { message: null, status: 202, rpc: method };
  }
  try {
    const d = await dispatch(msg, id, ver);
    return { message: d.message, status: 200, rpc: d.rpc, tool: d.tool };
  } catch (e) {
    console.error("mcp dispatch error", e instanceof Error ? e.message : "unknown");
    return { message: errMsg(id, ERR.internal, "Internal error."), status: 500, rpc: method };
  }
}

/** Split on `sep` outside double-quoted strings (RFC 9110 section 5.6.4: backslash escapes inside quotes). */
function splitOutsideQuotes(input: string, sep: string): string[] | null {
  const parts: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      cur += ch;
      if (ch === "\\" && i + 1 < input.length) cur += input[++i];
      else if (ch === '"') inQuotes = false;
    } else if (ch === '"') {
      inQuotes = true;
      cur += ch;
    } else if (ch === sep) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (inQuotes) return null; // unterminated quote: not a valid header value
  parts.push(cur);
  return parts;
}

/** A parameter value: a token as is, or a quoted-string with its quotes and escapes removed. */
function paramValue(raw: string): string {
  const v = raw.trim();
  return v.startsWith('"') && v.endsWith('"') && v.length >= 2 ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v;
}

/**
 * RFC 9110 sections 12.5.1 and 5.6.6. Does the client accept `type` (application/json, or
 * text/event-stream with `wildcards` false so that only an explicit mention counts)? The reply
 * has no media parameters, so:
 *  - the Accept list is split on commas and the parameters on semicolons only OUTSIDE quoted
 *    strings, and a quoted value equals the same token (charset="utf-8" is charset=utf-8);
 *  - `q` is the weight wherever it appears among the parameters; every other parameter is a
 *    media parameter, and a range with media parameters (other than charset=utf-8, which the
 *    body already is) does NOT match the bare type, so it is ignored;
 *  - of the ranges that do match, the most specific wins (application/json, then
 *    application/*, then * / *), and q=0 on that range means "not acceptable".
 * So "application/json;q=0, * / *" and "application/json;q=1;profile=x, application/json;q=0"
 * both refuse JSON. A malformed range (bad q, unterminated quote) is ignored. No Accept
 * header = anything goes.
 */
function acceptsMedia(accept: string | null, type: string, wildcards: boolean): boolean {
  if (accept === null) return true;
  const ranges = splitOutsideQuotes(accept, ",");
  if (!ranges) return false;
  let bestSpecificity = 0;
  let bestQ = 0;
  for (const range of ranges) {
    const pieces = splitOutsideQuotes(range, ";");
    if (!pieces) continue;
    const media = pieces[0].trim().toLowerCase();
    const family = `${type.split("/")[0]}/*`;
    const specificity = media === type ? 3 : wildcards && media === family ? 2 : wildcards && media === "*/*" ? 1 : 0;
    if (!specificity) continue;
    let q: number | null = 1;
    let hasMediaParams = false;
    let sawQ = false;
    for (const piece of pieces.slice(1)) {
      if (piece.trim() === "") continue;
      const eq = piece.indexOf("=");
      const name = (eq === -1 ? piece : piece.slice(0, eq)).trim().toLowerCase();
      const value = eq === -1 ? "" : paramValue(piece.slice(eq + 1));
      if (name === "q" && !sawQ) {
        sawQ = true;
        q = /^(0(\.[0-9]{0,3})?|1(\.0{0,3})?)$/.test(value) ? Number(value) : null;
      } else if (name === "charset" && value.toLowerCase() === "utf-8") {
        // Our body is UTF-8: this parameter describes what we send.
      } else {
        hasMediaParams = true;
      }
    }
    if (q === null || hasMediaParams) continue;
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestQ = q;
    } else if (specificity === bestSpecificity) {
      bestQ = Math.max(bestQ, q);
    }
  }
  return bestSpecificity > 0 && bestQ > 0;
}


/** True when this JSON-RPC message is an initialize request: the one place MCP-Protocol-Version is ignored. */
const isInitialize = (m: unknown): boolean => isObject(m) && m.method === "initialize";

export async function handleMcpPost(req: Request): Promise<Response> {
  let mode: Mode = "json";
  const finish = (r: Reply, extra: { limited?: boolean } = {}) => {
    const res = withMcpCors(req, toResponse(r, mode));
    logAgentRequest(req, { route: MCP_PATH, status: res.status, rpc: r.rpc, tool: r.tool, limited: extra.limited || undefined });
    return res;
  };

  // Origin first: a forbidden origin must not spend the address's rate-limit allowance.
  if (checkOrigin(req).state === "bad") return finish(forbiddenOrigin());

  const limit = await checkAgentRateLimit(req, "mcp");
  if (limit.limited) {
    return finish(
      errReply(null, ERR.rateLimited, "Too many requests. Retry after the Retry-After seconds.", 429, { "Retry-After": String(limit.retryAfterSec) }),
      { limited: true },
    );
  }

  const mediaType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return finish(errReply(null, ERR.invalidRequest, "Content-Type must be application/json.", 415));
  }
  // Accept: JSON for anyone who allows it; a client that names only text/event-stream gets one
  // buffered SSE event; everyone else (text/html only, or JSON refused) is told so.
  const acceptRaw = req.headers.get("accept");
  const accept = acceptRaw === null || acceptRaw.trim() === "" ? null : acceptRaw;
  if (acceptsMedia(accept, "application/json", true)) mode = "json";
  else if (acceptsMedia(accept, "text/event-stream", false)) mode = "sse";
  else return finish(errReply(null, ERR.invalidRequest, "Accept must allow application/json (or name text/event-stream).", 406));

  const body = await readBodyCapped(req, MCP_MAX_BODY_BYTES);
  if (!body.ok) {
    return body.reason === "too_large"
      ? finish(errReply(null, ERR.tooLarge, `Request body is over the ${MCP_MAX_BODY_BYTES / 1024} KB limit.`, 413))
      : finish(errReply(null, ERR.parse, "Could not read the request body.", 400));
  }

  let msg: unknown;
  try {
    msg = JSON.parse(body.text);
  } catch {
    return finish(errReply(null, ERR.parse, "Parse error: the body is not valid JSON.", 400));
  }

  // MCP-Protocol-Version: ignored on initialize, whatever it says. On any other request a missing
  // (or empty) header is fine and the latest behavior is assumed; a present one must be served.
  const headerRaw = req.headers.get("mcp-protocol-version")?.trim() || null;
  const isInit = Array.isArray(msg) ? msg.some(isInitialize) : isInitialize(msg);
  let ver: ProtocolVersion = LATEST_PROTOCOL_VERSION;
  if (headerRaw !== null && !isInit) {
    if (!isSupportedVersion(headerRaw)) {
      return finish({
        ...errReply(
          null,
          ERR.invalidRequest,
          `Unsupported MCP-Protocol-Version "${headerRaw.slice(0, 20)}". Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`,
          400,
        ),
        rpc: Array.isArray(msg) ? "batch" : isObject(msg) && typeof msg.method === "string" ? msg.method : undefined,
      });
    }
    ver = headerRaw;
  }

  if (Array.isArray(msg)) {
    if (msg.length === 0) return finish(errReply(null, ERR.invalidRequest, "Invalid request: an empty batch.", 400));
    if (msg.length > MCP_MAX_BATCH) {
      return finish(errReply(null, ERR.invalidRequest, `A batch may hold at most ${MCP_MAX_BATCH} messages. Send fewer per POST.`, 400));
    }
    // Answered one after another. tools/call is capped per batch: each can start a data build.
    const replies: RpcMessage[] = [];
    let calls = 0;
    for (const m of msg) {
      if (isObject(m) && m.method === "tools/call" && (typeof m.id === "string" || typeof m.id === "number") && ++calls > MCP_MAX_BATCH_TOOL_CALLS) {
        replies.push(errMsg(m.id, ERR.tooLarge, `A batch may hold at most ${MCP_MAX_BATCH_TOOL_CALLS} tools/call. Send the rest in another POST.`));
        continue;
      }
      const p = await processMessage(m, ver);
      if (p.message) replies.push(p.message);
    }
    return finish({ payload: replies.length ? replies : null, status: 200, rpc: "batch" });
  }

  const p = await processMessage(msg, ver);
  return finish({ payload: p.message, status: p.message ? p.status : 202, rpc: p.rpc, tool: p.tool });
}
