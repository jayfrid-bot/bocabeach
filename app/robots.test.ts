import { describe, expect, it } from "vitest";
import robots from "@/app/robots";

describe("robots", () => {
  const result = robots();
  const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;

  it("allows crawling the site root", () => {
    expect(rules?.allow).toBe("/");
  });

  it("disallows the admin console and internal API", () => {
    const disallow = rules?.disallow;
    const list = Array.isArray(disallow) ? disallow : disallow ? [disallow] : [];
    expect(list).toContain("/admin");
    expect(list).toContain("/api");
  });

  it("points at the canonical sitemap", () => {
    expect(result.sitemap).toBe("https://isitbeachday.com/sitemap.xml");
  });
});
