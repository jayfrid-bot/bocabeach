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
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# List the tools
curl -s https://isitbeachday.com/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Get one beach
curl -s https://isitbeachday.com/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_beach_score","arguments":{"slug":"boca-raton"}}}'

# Or the MCP Inspector
npx @modelcontextprotocol/inspector   # transport: Streamable HTTP, URL: https://isitbeachday.com/mcp
```

## Tools

| Tool | Arguments | Use it to |
|---|---|---|
| `list_beaches` | `state?`, `region?` | See the covered beaches and their slugs. |
| `get_beach_score` | `slug` | Get the score, rating, safety lines, water temperature and best time. |
| `find_nearest_beach` | `lat`, `lon`, `limit?` (max 5), `include_scores?` | Find the nearest beaches. Scores cover the nearest 3 only. |
| `best_beach_today` | `state?`, `region?`, `lat?`, `lon?`, `radius_miles?`, `compare?` (max 5, default 3) | Compare a few beaches and pick the highest score. |

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
- Stay near 60 requests a minute per IP address. Over that you get HTTP 429.
- Coordinates are used for the answer only. They are not stored or logged.

## How it works

- `lib/watchLoad.ts` is the one loader behind the watch, `/api/v1/*` and the MCP
  tools. Same score, same safety lines.
- `lib/agent/mcp/server.ts` is a small hand-written MCP handler for spec
  revision 2025-06-18. Why not `@modelcontextprotocol/sdk`: it is not a
  dependency of this app, it needs `zod` and a Node-stream transport built for
  sessions, and four read-only tools need only four JSON-RPC methods. No
  session id, no Durable Object, no KV. Batches are refused (the 2025-06-18
  spec removed them). No SSE stream: `GET /mcp` answers 405.
- Cache: `Cache-Control: public, s-maxage=min(60, seconds to validUntil)` on
  live answers, never stale-while-revalidate, `no-store` once expired or
  partial. The beach list and nearest-without-scores keep 1 hour.
- Rate limit: `lib/agent/rateLimit.ts`. See below.
- Logs: one JSON line per request (`evt: "agent_api"`) with route, status and
  user-agent family (claude, chatgpt, gemini, script, browser, ...). For MCP it
  adds the JSON-RPC method and tool name. Never an IP, a query string or tool
  arguments. Find them with `wrangler tail` or Workers Logs.

## Rate limiting: the binding to deploy

`wrangler.jsonc` declares the Workers Rate Limiting binding:

```jsonc
"ratelimits": [
  { "name": "AGENT_RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 60, "period": 60 } }
]
```

It counts per IP (the code passes the `cf-connecting-ip` as the key). `period`
can only be 10 or 60 seconds. If the binding is missing or errors, the code uses
an in-isolate token bucket (burst 40, 1 request a second sustained). That is
weaker: each Worker isolate counts alone. If the deploy rejects the binding,
delete the `ratelimits` block. The code still runs with the bucket.

## Limits that protect upstream

| Limit | Value |
|---|---|
| Live scores per `/api/v1/nearest` call | 3 |
| `limit` on `/api/v1/nearest` | 10 |
| `find_nearest_beach` results | 5 (scores for 3) |
| `best_beach_today` compared beaches | 5 (default 3) |
| `/mcp` request body | 32 KB |

A cold build of one beach is about 25 subrequests. On the Workers Free plan one
request may make 50, so several cold builds in one call can fail there. The
failed beach is reported as skipped or `conditions: null`, never as a made-up
answer. On a paid plan the limit is 1000.
