import { describe, expect, it } from "vitest";
import { GET } from "@/app/llms.txt/route";

describe("GET /llms.txt", () => {
  it("serves plain text with the endpoints, MCP URL, attribution and usage rules", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const text = await res.text();
    expect(text.startsWith("# Is It Beach Day")).toBe(true);
    for (const needle of [
      "https://isitbeachday.com/mcp",
      "/api/v1/beaches/{slug}",
      "/api/v1/nearest",
      "/api/v1/openapi.json",
      "Score by Is It Beach Day — isitbeachday.com",
      "Lifeguard flags and posted warnings always win.",
      "429",
      "validUntil",
      "get_beach_score",
      "best_beach_today",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });
  it("never uses the word AI in its copy", async () => {
    expect(await GET().text()).not.toMatch(/\bAI\b/);
  });
});
