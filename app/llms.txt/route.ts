// GET /llms.txt — a plain-text guide for assistants (lib/agent/llmsTxt.ts).

import { buildLlmsTxt } from "@/lib/agent/llmsTxt";

export const dynamic = "force-static";

export function GET() {
  return new Response(buildLlmsTxt(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
