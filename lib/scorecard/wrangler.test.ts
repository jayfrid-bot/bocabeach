import { describe, expect, it } from "vitest";
import { errorLineOf, parseWranglerJson } from "@/lib/scorecard/wrangler";

const BODY = JSON.stringify([{ results: [{ n: 1 }], success: true }], null, 2);

describe("parseWranglerJson", () => {
  it("parses plain JSON", () => {
    expect(parseWranglerJson(BODY)).toEqual([{ results: [{ n: 1 }], success: true }]);
  });

  it("skips a banner line before the JSON", () => {
    const out = ` ⛅️ wrangler 4.12.0\n-------------------\n${BODY}\n`;
    expect(parseWranglerJson(out)).toEqual([{ results: [{ n: 1 }], success: true }]);
  });

  it("skips a banner that itself contains a bracket", () => {
    const out = `[wrangler:info] Executing on remote database\n${BODY}`;
    expect(parseWranglerJson(out)).toEqual([{ results: [{ n: 1 }], success: true }]);
  });

  it("skips colour codes", () => {
    expect(parseWranglerJson(`\u001b[32m ok \u001b[0m\n${BODY}`)).toEqual([{ results: [{ n: 1 }], success: true }]);
  });

  it("throws when there is no JSON at all", () => {
    expect(() => parseWranglerJson("nothing here")).toThrow("wrangler printed no JSON");
    expect(() => parseWranglerJson("")).toThrow();
  });
});

describe("errorLineOf", () => {
  it("picks the error line, without decoration", () => {
    const text = "\n ⛅️ wrangler 4.12.0\n\u001b[31m✘ [ERROR]\u001b[0m no such column: foo: SQLITE_ERROR\n\nIf you think this is a bug...";
    expect(errorLineOf(text)).toBe("no such column: foo: SQLITE_ERROR");
  });

  it("reads wrangler's --json error document", () => {
    const doc = JSON.stringify({
      error: {
        text: "A request to the Cloudflare API (/accounts/x/d1/database/y/query) failed.",
        notes: [{ text: "Authentication error [code: 10000]" }],
        kind: "error",
      },
    });
    expect(errorLineOf(`\n${doc}\n`)).toBe("Authentication error [code: 10000]");
    expect(errorLineOf(JSON.stringify({ error: { text: "D1 is down" } }))).toBe("D1 is down");
    expect(errorLineOf(JSON.stringify({ error: "plain string" }))).toBe("plain string");
  });

  it("falls back to the first line, and to a default", () => {
    expect(errorLineOf("just one thing\nand another")).toBe("just one thing");
    expect(errorLineOf("")).toBe("wrangler failed");
  });

  it("caps a very long line", () => {
    expect(errorLineOf(`ERROR ${"x".repeat(1000)}`).length).toBeLessThanOrEqual(300);
  });
});
