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

# MCP-Protocol-Version may be sent on every request, initialize included (ignored there).
# After initialize it may also be left out (2025-03-26 behavior is then assumed). A value that is not 2025-11-25, 2025-06-18 or
# 2025-03-26 is a 400 that lists the revisions we serve.

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
| `best_beach_today` | `state?`, `region?`, `lat?`, `lon?`, `radius_miles?`, `compare?` (max 5, default 3) | Compare a few beaches and pick the highest score for today. Beaches without a recent snapshot are listed as not compared right now. |
| `get_beach_outlook` | `slug`, `days?` (1-3, default 3) | Get a short forecast for one beach: per day the expected peak score and rating, best window, sky word and safety notes. Forecast, not a guarantee; check again the morning of. |

`best_beach_today` has no `day` argument on purpose: the recent-view store keeps only
the current reading, so ranking several beaches for tomorrow would need one cold
build per beach. Ask for the outlook of one or two beaches instead.

Every result has a text block and `structuredContent`. Both carry the
attribution and the safety note. A tool that cannot answer (unknown beach, bad
arguments, incomplete data) returns `isError: true` with a plain message. An
unknown tool name is a JSON-RPC error `-32602`.

## REST examples

```bash
curl -s 'https://isitbeachday.com/api/v1/beaches?state=FL'
curl -s 'https://isitbeachday.com/api/v1/beaches/boca-raton'
curl -s 'https://isitbeachday.com/api/v1/beaches/boca-raton/outlook?days=3'
curl -s 'https://isitbeachday.com/api/v1/nearest?lat=26.36&lon=-80.06&limit=3&scores=true'
```

The outlook counts calendar days from today (today is day 1), so `days=3` is today,
tomorrow and the day after. Per day it gives `peakScore`, `rating`, `bestWindow`
(`text` is local time such as "10 AM–1 PM"; `good` is true at Decent or better), `sky` and
`notes` (safety notes for the peak hour). Future days carry no live flags or alerts; use
`/beaches/{slug}` for right now. If forecast data for a day is missing, that day is left
out and `note` says so. Once today has no daylight time left (no window, or the window
has ended) today stays in the list as day 1 with `noTimeLeft: true`, a null `peakScore`,
`bestWindow` and `sky`, and no `notes`: a peak from hours that are gone is not an
expectation.

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
- `lib/agent/mcp/server.ts` is a small hand-written MCP handler. It serves spec
  revisions 2025-11-25, 2025-06-18 and 2025-03-26. `initialize` answers the
  client's `protocolVersion` when we serve it, else the latest (2025-11-25); it is
  never an error. Why not `@modelcontextprotocol/sdk`: it is not a dependency of
  this app, it needs `zod` and a Node-stream transport built for sessions, and five
  read-only tools need only a few JSON-RPC methods. No session id (an incoming
  `Mcp-Session-Id` is ignored), no Durable Object, no KV. No SSE stream: GET
  answers 405. 2025-11-25 changed nothing a tools-only server must do beyond
  optional fields (icons, `Implementation.description`, JSON Schema 2020-12 as the
  default dialect, input-validation errors as tool errors, 403 for a bad Origin).
  We already did the last two; `serverInfo.description` is sent for 2025-11-25 only;
  `title` and `structuredContent` only for 2025-06-18 and later (the 2025-03-26
  shapes lack them). Capabilities advertised: `tools` with `listChanged: false`.
- MCP transport: every reply is serialized to a string and sent with an explicit
  `Content-Length` (no streaming, no chunked). A notification, a client response or
  a batch of only those gets 202 with `Content-Length: 0`. A batch (JSON array, at
  most 10 messages and ONE `tools/call`) is answered with an array. A batch costs
  one rate-limit token and each `tools/call` can start a data build, so a second
  `tools/call` in the same batch gets a per-item error ("send each tools/call in its
  own POST"); pings, `tools/list` and notifications are not capped. A message with
  `"id": null` (or any id that is not a string or number) that is not a notification
  is HTTP 400 with a JSON-RPC error body. A client whose
  `Accept` names only `text/event-stream` gets the same JSON as one SSE event
  (`event: message`, `data: ...`, blank line), also with `Content-Length`.
  Next.js adds its own `Vary: rsc, next-router-state-tree, ...` to every App Router
  response before the route runs, and a route cannot remove it; strip it at the edge
  if a client objects (`/mcp` adds `Vary: Origin` when it echoes an origin).
- MCP request checks: `Content-Type: application/json` (415 otherwise). `Accept`
  may be absent, `*/*`, `application/json` or (alone) `text/event-stream`; one that
  allows neither is 406, and the most specific media range wins, so
  `application/json;q=0, */*` is refused. `initialize` needs `protocolVersion`,
  `capabilities` and `clientInfo` (name, version). `MCP-Protocol-Version` is ignored
  on `initialize` (any value) and may be left out on later requests (the 2025-03-26
  shape is assumed, per the spec's SHOULD: no tool `title`, no `structuredContent`; the
  text result carries every fact); a present value on a later request must be one of the three
  revisions, else 400 with the list.
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
(`conditionsOverrides`, `lib/conditions.ts`). When the owner corrects a
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
