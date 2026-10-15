// /mcp — Is It Beach Day as a remote MCP server (Streamable HTTP, stateless).
// POST carries JSON-RPC; GET and DELETE answer 405. The protocol code is in
// lib/agent/mcp/server.ts, the tools in lib/agent/mcp/tools.ts.

import { handleMcpPost, mcpMethodNotAllowed, mcpPreflight } from "@/lib/agent/mcp/server";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handleMcpPost(req);
}

export function GET(req: Request) {
  return mcpMethodNotAllowed(req);
}

export function DELETE(req: Request) {
  return mcpMethodNotAllowed(req);
}

export function OPTIONS() {
  return mcpPreflight();
}
