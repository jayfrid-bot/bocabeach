// One counter line per agent request. Records the route, the status, the caller's
// user-agent FAMILY and, for MCP, the method and tool name. Never an IP, never a
// query string, never tool arguments (a latitude and longitude is a location).

export type UaFamily =
  | "claude"
  | "chatgpt"
  | "gemini"
  | "perplexity"
  | "cursor"
  | "mcp-client"
  | "browser"
  | "script"
  | "other"
  | "none";

const RULES: Array<[RegExp, UaFamily]> = [
  [/claude|anthropic/i, "claude"],
  [/chatgpt|openai|oai-|gptbot/i, "chatgpt"],
  [/gemini|google-extended|googlebot|google/i, "gemini"],
  [/perplexity/i, "perplexity"],
  [/cursor|vscode|copilot/i, "cursor"],
  [/modelcontextprotocol|mcp/i, "mcp-client"],
  [/curl|wget|python|node|undici|axios|go-http|okhttp|java|ruby|php|httpie|postman/i, "script"],
  [/mozilla|safari|chrome|firefox|edge/i, "browser"],
];

export function uaFamily(userAgent: string | null | undefined): UaFamily {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "none";
  for (const [re, fam] of RULES) if (re.test(ua)) return fam;
  return "other";
}

export interface AgentLogFields {
  route: string;
  status: number;
  method?: string;
  /** MCP only: JSON-RPC method and, for tools/call, the tool name. */
  rpc?: string;
  tool?: string;
  limited?: boolean;
}

export function logAgentRequest(req: Request, fields: AgentLogFields): void {
  const line = {
    evt: "agent_api",
    ua: uaFamily(req.headers.get("user-agent")),
    method: req.method,
    ...fields,
  };
  console.log(JSON.stringify(line));
}
