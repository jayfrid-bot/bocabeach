import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listLocations } from "@/config/locations";
import { KNOWN_BEACH_SLUGS } from "@/lib/push/beachSlugs";
import { planTap } from "@/lib/push/tapTarget";

describe("config/beach-slugs.json (the compact set the push tap handler opens without loading anything)", () => {
  const onDisk = JSON.parse(readFileSync(path.join(process.cwd(), "config", "beach-slugs.json"), "utf8")) as string[];
  const expected = listLocations().map((l) => l.slug).sort();

  it("equals the configured locations, curated and admin-added", () => {
    expect(onDisk, "regenerate: npx vite-node -c vitest.config.ts scripts/gen_beach_slugs.ts").toEqual(expected);
    expect([...KNOWN_BEACH_SLUGS].sort()).toEqual(expected);
  });

  it("is tiny (it ships with the push handler)", () => {
    expect(readFileSync(path.join(process.cwd(), "config", "beach-slugs.json")).length).toBeLessThan(2500);
  });

  it("every configured beach opens at once from the set; an unknown slug asks for a lookup; a reserved route never does", () => {
    const origins = ["https://app.isitbeachday.com"];
    for (const slug of expected) expect(planTap(`/${slug}`, origins, KNOWN_BEACH_SLUGS), slug).toEqual({ kind: "open", path: `/${slug}` });
    expect(planTap("/newly-added-beach", origins, KNOWN_BEACH_SLUGS)).toEqual({ kind: "lookup", slug: "newly-added-beach", path: "/newly-added-beach" });
    for (const reserved of ["/get-app", "/support", "/find", "/privacy", "/sticker", "/api", "/admin", "/admin/other"]) {
      expect(planTap(reserved, origins, KNOWN_BEACH_SLUGS), reserved).toEqual({ kind: "none" });
    }
    expect(planTap("https://evil.example/boca-raton", origins, KNOWN_BEACH_SLUGS)).toEqual({ kind: "none" });
  });
});
