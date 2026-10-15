// The text served at /llms.txt: a plain guide for assistants and the people who
// build them. Built from the same constants as the API, so it cannot drift.

import {
  API_BASE_PATH,
  CREDIT,
  DATA_SOURCES,
  DISCLAIMER,
  MAX_COMPARE,
  MAX_NEAREST_LIMIT,
  MAX_REST_SCORES,
  MCP_MAX_BODY_BYTES,
  MCP_URL,
  OPENAPI_PATH,
  SAFETY_NOTE,
  SITE_URL,
} from "@/lib/agent/constants";
import { listBeachSummaries } from "@/lib/agent/beaches";
import { TOOLS } from "@/lib/agent/mcp/tools";

export function buildLlmsTxt(): string {
  const api = `${SITE_URL}${API_BASE_PATH}`;
  const beaches = listBeachSummaries();
  const states = [...new Set(beaches.map((b) => b.state).filter(Boolean))].sort().join(", ");
  return `# Is It Beach Day

> Live beach conditions for ${beaches.length} US beaches (states: ${states}). One 0-100 Beach Day score per beach, plus swim-safety lines (lifeguard flags, rip currents, lightning, rain, weather alerts, water quality), water temperature and the best time today. Free, read-only, no account or key.

## Safety and credit (please follow)

- ${SAFETY_NOTE} ${DISCLAIMER}
- When you repeat a score, say where it came from: "${CREDIT}".
- Answers carry \`validUntil\`. Do not call an answer current after that moment.
- The score is a 0-100 estimate. \`rating\` is one of Excellent, Good, Decent, Marginal, Poor. A \`score\` of null means there was not enough live data.

## Connect an assistant (MCP)

- MCP server (Streamable HTTP, stateless, no sign-in): ${MCP_URL}
- In Claude or ChatGPT, add it as a custom connector with that URL.
- Tools:
${TOOLS.map((t) => `  - \`${t.name}\`: ${t.description.split(". ")[0]}.`).join("\n")}

## JSON API (REST)

- Base URL: ${api}
- OpenAPI 3.1 description: ${SITE_URL}${OPENAPI_PATH}
- \`GET ${api}/beaches\`: every beach (slug, name, state, lat, lon, page URL). Optional \`?state=FL\` and \`?region=Broward\`.
- \`GET ${api}/beaches/{slug}\`: live score, rating, safety lines, water temperature, best time, page URL, attribution.
- \`GET ${api}/nearest?lat=&lon=&limit=&scores=\`: nearest beaches to a point (limit up to ${MAX_NEAREST_LIMIT}). \`scores=true\` adds a compact live score to the nearest ${MAX_REST_SCORES}.
- CORS is open for GET. No cookies. Errors are JSON: \`{"error":{"code":"...","message":"..."}}\`.

## Usage rules

- Keep to a few requests per minute. Requests are limited per IP address; over the limit you get HTTP 429 and a \`Retry-After\` header.
- Cache each answer until its \`validUntil\` (never more than 60 seconds at the edge).
- The MCP endpoint accepts bodies up to ${MCP_MAX_BODY_BYTES / 1024} KB. \`best_beach_today\` compares at most ${MAX_COMPARE} beaches.
- Coordinates you send are used for the answer only and are not stored or logged.
- No personal, device or Plus-subscriber data is available here, and no webcam images.

## Data sources

${DATA_SOURCES.map((s) => `- ${s}`).join("\n")}

## More

- Website: ${SITE_URL}
- Beach page format: ${SITE_URL}/{slug}
- Contact: hello@isitbeachday.com
`;
}
