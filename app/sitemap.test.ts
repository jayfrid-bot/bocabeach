import { describe, expect, it } from "vitest";
import sitemap from "@/app/sitemap";
import { listLocations } from "@/config/locations";

const BASE = "https://isitbeachday.com";

describe("sitemap", () => {
  const entries = sitemap();
  const urls = entries.map((e) => e.url);
  const all = listLocations();
  const flagship = all.find((l) => l.tier !== "auto") ?? all[0];

  it("includes the apex home and /find, both on the canonical domain", () => {
    expect(urls).toContain(`${BASE}/`);
    expect(urls).toContain(`${BASE}/find`);
  });

  it("includes every beach slug EXCEPT the flagship (whose /slug 308s to /)", () => {
    for (const loc of all) {
      if (loc.slug === flagship?.slug) continue;
      expect(urls).toContain(`${BASE}/${loc.slug}`);
    }
    // A sitemap must not list a redirecting URL — the homepage entry IS the flagship.
    expect(urls).not.toContain(`${BASE}/${flagship?.slug}`);
  });

  it("includes the support and privacy pages", () => {
    expect(urls).toContain(`${BASE}/support`);
    expect(urls).toContain(`${BASE}/privacy`);
  });

  it("emits home + find + support + privacy + one URL per non-flagship beach", () => {
    expect(entries).toHaveLength(4 + all.length - 1);
  });

  it("keeps every URL on the apex (canonical) domain", () => {
    for (const url of urls) {
      expect(url.startsWith(`${BASE}/`)).toBe(true);
    }
  });

  it("gives every entry a real Date, not a fresh 'now' timestamp", () => {
    // A per-request `new Date()` would put every entry within a second or two
    // of test run time; a stable build/content date sits well in the past.
    const cutoff = new Date(Date.now() - 60_000);
    for (const entry of entries) {
      expect(entry.lastModified).toBeInstanceOf(Date);
      expect((entry.lastModified as Date).getTime()).toBeLessThan(cutoff.getTime());
    }
  });

  it("produces the exact same lastModified values across two calls (stable, not per-request)", () => {
    const again = sitemap();
    entries.forEach((entry, i) => {
      expect((again[i].lastModified as Date).getTime()).toBe((entry.lastModified as Date).getTime());
    });
  });
});
