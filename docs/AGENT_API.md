# Agent API and MCP server

Is It Beach Day answers questions from assistants and apps. Everything here is
public, read-only and free. There is no key and no account.

- JSON API: `https://isitbeachday.com/api/v1`
- OpenAPI 3.1: `https://isitbeachday.com/api/v1/openapi.json`
- Remote MCP server: `https://isitbeachday.com/mcp`
- Plain-text guide: `https://isitbeachday.com/llms.txt`

## Connect from Claude

1. Open Settings, then Connectors.
2. Choose "Add custom connector".
3. Enter the name "Is It Beach Day" and the URL `https://isitbeachday.com/mcp`.
4. Leave the sign-in fields empty. Save.
5. Ask: "Is it a good beach day in Boca Raton?"

## Connect from ChatGPT

1. Open Settings, then Connectors (turn on developer mode if your plan needs it).
2. Create a connector. Enter the URL `https://isitbeachday.com/mcp`.
3. Set authentication to "No authentication".
4. Start a chat with the connector on. Ask: "Which beach near Miami is best today?"

## Test from a terminal

```bash
# Initialize
curl -s https://isitbeachday.com/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# After initialize, every request must send MCP-Protocol-Version: 2025-06-18 (400 without it).
# initialize itself may leave it out.

# List the tools
curl -s https://isitbeachday.com/mcp -H 'content-type: application/json' \
  -H 'mcp-protocol-version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Get one beach
curl -s https://isitbeachday.com/mcp -H 'content-type: application/json' \
  -H 'mcp-protocol-version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_beach_score","arguments":{"slug":"boca-raton"}}}'

# Or the MCP Inspector
npx @modelcontextprotocol/inspector   # transport: Streamable HTTP, URL: https://isitbeachday.com/mcp
```

## Tools

| Tool | Arguments | Use it to |
|---|---|---|
| `list_beaches` | `state?`, `region?` | See the covered beaches and their slugs. |
| `get_beach_score` | `slug` | Get the score, rating, safety lines, water temperature and best time. |
| `find_nearest_beach` | `lat`, `lon`, `limit?` (max 5), `include_scores?` | Find the nearest beaches. Scores cover the nearest 3 only, from recent snapshots. |
| `best_beach_today` | `state?`, `region?`, `lat?`, `lon?`, `radius_miles?`, `compare?` (max 5, default 3) | Compare a few beaches and pick the highest score. Beaches without a recent snapshot are listed as not compared right now. |

Every result has a text block and `structuredContent`. Both carry the
attribution and the safety note. A tool that cannot answer (unknown beach, bad
arguments, incomplete data) returns `isError: true` with a plain message. An
unknown tool name is a JSON-RPC error `-32602`.

## REST examples

```bash
curl -s 'https://isitbeachday.com/api/v1/beaches?state=FL'
curl -s 'https://isitbeachday.com/api/v1/beaches/boca-raton'
curl -s 'https://isitbeachday.com/api/v1/nearest?lat=26.36&lon=-80.06&limit=3&scores=true'
```

```js
const r = await fetch("https://isitbeachday.com/api/v1/beaches/boca-raton");
const beach = await r.json();
console.log(beach.summary); // "Boca Raton: 78/100 (Good). Yellow flag. Water 82°F. Best 4–6 PM."
```

Errors share one shape: `{"error":{"code":"bad_request","message":"..."}}`.
Codes: `bad_request` (400), `not_found` (404), `rate_limited` (429),
`unavailable` (503), `internal_error` (500).

## Rules for callers

- Show the credit: "Score by Is It Beach Day — isitbeachday.com".
- Say "Lifeguard flags and posted warnings always win." when you give advice.
- Do not call an answer current after `validUntil`.
- Stay under the limits: 60 requests a minute per IP on the JSON API, 300 a minute per IP on MCP. Over that you get HTTP 429 and `Retry-After`.
- Write query values in canonical form: `lat=26.35`, `limit=3`, `scores=true`. No spaces, plus signs, exponents or leading zeros. Anything else is a 400.
- Coordinates are not stored or logged by the app. The answer echoes them rounded to 2 decimals and is `no-store`. The URL can still appear in your own or your network's records.

## How it works

- `lib/watchLoad.ts` is the one loader behind the watch, `/api/v1/*` and the MCP
  tools. Same score, same safety lines.
- `lib/agent/mcp/server.ts` is a small hand-written MCP handler. It implements
  ONLY spec revision 2025-06-18 and answers `initialize` with that revision
  whatever the client asks. Why not `@modelcontextprotocol/sdk`: it is not a
  dependency of this app, it needs `zod` and a Node-stream transport built for
  sessions, and four read-only tools need only four JSON-RPC methods. No
  session id, no Durable Object, no KV. Batches are refused (2025-06-18 removed
  them). No SSE stream: GET answers 405. Older clients that need batching or the
  legacy SSE transport are not served.
- MCP request checks: `Content-Type: application/json` (415 otherwise), a present
  `Accept` must allow JSON (406; the most specific media range wins, so
  `application/json;q=0, */*` is refused), `initialize` needs `protocolVersion`,
  `capabilities` and `clientInfo` (name, version). A present
  `MCP-Protocol-Version` must be exactly `2025-06-18` on every request after
  `initialize` (400 otherwise); `initialize` itself may omit it. A wrong value is
  400 on any request.
- MCP `Origin` check: no `Origin` header is allowed (a connector's server sends
  none). A present `Origin` must be `https://isitbeachday.com` or
  `https://app.isitbeachday.com`, else 403. CORS headers are sent only to those
  origins. A browser-only client on another origin (for example the MCP Inspector
  UI in a page) will not work; use its proxy or the terminal.
- Caching: the app does NOT run an automatic response cache (Workers Cache is not enabled).
  Live answers send `Cache-Control: public, s-maxage=min(60, seconds to
  validUntil)` (`no-store` once expired or partial) as an honest hint for any
  downstream cache. `/nearest` is always `no-store` because the URL holds a
  location. The protection for the data sources is the shared 120-second
  conditions cache (KV) behind `unstable_cache` for single builds, plus the
  recent-view store and the one-cold-build rule below for comparisons.
- Strict input: query values must be canonical, so equal questions look equal if
  a cache is ever put in front. Unknown or repeated parameters, whitespace,
  leading zeros, exponents, plus signs, `scores` other than `true`/`false`,
  and over-long `state`/`region` are all 400, never guessed or cut.
- Errors and methods: every v1 route answers other methods (POST, PUT, PATCH,
  DELETE) with the JSON error shape, `Allow: GET, OPTIONS` and CORS.
- Logs: one JSON line per request (`evt: "agent_api"`) with route, status and
  user-agent family (claude, chatgpt, gemini, script, browser, ...). For MCP it
  adds the JSON-RPC method and tool name. Never an IP, a query string or tool
  arguments. Find them with `wrangler tail` or Workers Logs.

## Rate limiting: the bindings to deploy

`wrangler.jsonc` declares two Workers Rate Limiting bindings, one budget each:

```jsonc
"ratelimits": [
  { "name": "AGENT_RATE_LIMITER",     "namespace_id": "4721", "simple": { "limit": 60,  "period": 60 } },
  { "name": "AGENT_MCP_RATE_LIMITER", "namespace_id": "4722", "simple": { "limit": 300, "period": 60 } }
]
```

REST gets 60 a minute per IP. MCP gets 300 a minute per IP because hosted
connectors share egress IPs, and one connector setup spends several calls.
`namespace_id` must be unique across the whole Cloudflare account. Check that
4721 and 4722 are free before you deploy. `period` can only be 10 or 60.
Cloudflare's counters are per location and eventually consistent: they are a
brake, not a hard ceiling. If a binding is missing or errors, the code uses an
in-isolate token bucket for that budget (REST: burst 40, 1 a second; MCP: burst
120, 5 a second). That is weaker: each Worker isolate counts alone. If the
deploy rejects the bindings, delete the `ratelimits` block. The code still runs
with the buckets.

## Limits that protect the data sources

| Limit | Value |
|---|---|
| Cold (fresh) builds per request, REST or MCP | 1 |
| Scores per `/api/v1/nearest` call | 3 (from the cache, plus at most one fresh build) |
| `limit` on `/api/v1/nearest` | 10 |
| `find_nearest_beach` results | 5 (scores for 3) |
| `best_beach_today` compared beaches | 5 (default 3) |
| `/mcp` request body | 32 KB |

A cold build of one beach is about 25 subrequests. Workers Free allows 50
external subrequests per request; Workers Paid allows 10,000. So a request may
build at most ONE beach fresh. Every other beach in a comparison or a scored
nearest list is read with a cache-only peek (`peekWatchView`,
`lib/watchViewCache.ts`).

The recent-view store: whenever `loadWatchView` builds a view successfully (the
agent API, MCP, or `/api/watch`), it saves that compact view in the Workers
Cache API (`caches.default`) under an internal key made of the beach slug and
the owner-override fingerprint:
`https://cache.isitbeachday.internal/watchview/<slug>/<fingerprint>`. The
fingerprint is the same one the conditions cache key uses
(`conditionsOverridesVersion`, `lib/conditions.ts`). When the owner corrects a
reading, it changes, and every view stored before the correction is never found
again. The entry's `max-age` is the seconds left until the view's `validUntil`,
so a recent view lasts up to 15 minutes. It never saves a partial or expired
view, and it makes no KV writes.

A peek is only `caches.default.match`. It builds nothing and writes nothing.
It accepts an entry only if the whole stored view passes a strict check (exact
fields, types and ranges, matching slug and fingerprint) and its `validUntil`
is still in the future. The store is per datacenter, so a peek may miss a beach
that another datacenter has. The Cache API stores only on a custom domain (not
`*.workers.dev`), and where `caches` does not exist (Node, tests, `next dev`) a
peek always misses.

How a comparison treats each beach:

- A beach with a current recent view is read from the store, with no build.
- The FIRST beach that has no current view (the nearest one, with lat/lon) is
  built, and its view is saved. This is the one cold build per request.
- Every other beach without a current view is not built. It is listed as not
  compared right now, with its slug (`notComparedNow` in `best_beach_today`;
  `conditions: null` and a `note` in nearest). Ask for it with `get_beach_score`
  or `/beaches/{slug}`, which builds it and saves its view.
- Expiry is checked again with the live clock after all waiting, just before a
  score is served or ranked. A view that ran out in the meantime (for example
  while the one build ran, or a stale value the conditions cache served while it
  refreshes) is treated like a missing one: not compared right now. For a single
  beach (`/beaches/{slug}`, `get_beach_score`) it is a 503 with `Retry-After: 30`
  (MCP: a tool error), the same as a partial build. A partial or expired view is
  never shown as an answer.
- `Cache-Control` on a live answer counts down from the clock at the moment the
  response is made, so a downstream cache never keeps it past `validUntil`.
