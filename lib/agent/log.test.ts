import { describe, expect, it } from "vitest";
import { uaFamily } from "@/lib/agent/log";

describe("uaFamily", () => {
  it.each([
    ["Claude-User/1.0 (+https://www.anthropic.com)", "claude"],
    ["Mozilla/5.0 AppleWebKit/537.36 (compatible; ClaudeBot/1.0)", "claude"],
    ["ChatGPT-User/1.0; +https://openai.com/bot", "chatgpt"],
    ["OAI-SearchBot/1.0", "chatgpt"],
    ["openai-mcp/1.0.0", "chatgpt"],
    ["Mozilla/5.0 (compatible; Google-Extended)", "gemini"],
    ["PerplexityBot/1.0", "perplexity"],
    ["Cursor/0.42", "cursor"],
    ["modelcontextprotocol-inspector/0.1", "mcp-client"],
    ["curl/8.4.0", "script"],
    ["python-requests/2.31", "script"],
    ["node", "script"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15", "browser"],
    ["SomethingElse/1", "other"],
    ["", "none"],
    [null, "none"],
  ])("%s -> %s", (ua, family) => {
    expect(uaFamily(ua as string | null)).toBe(family);
  });
});
