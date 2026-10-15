// The owner area must never be framed by another site (docs/QUALITY_PLAN.md): the admin pages and the
// owner API carry Content-Security-Policy: frame-ancestors 'none' and X-Frame-Options: DENY.
import { describe, expect, it } from "vitest";

describe("next.config headers", () => {
  it("forbids framing of /admin/* and /api/quality/owner/*, and nothing else is touched", async () => {
    const cfg = (await import("./next.config.mjs")).default as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> };
    const rules = await cfg.headers();
    expect(rules.map((r) => r.source).sort()).toEqual(["/admin/:path*", "/api/quality/owner/:path*"]);
    for (const r of rules) {
      expect(r.headers).toEqual([
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
      ]);
    }
  });
});
