import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listLocations } from "@/config/locations";
import { reviewUrl } from "@/lib/quality/notify";
import { RESERVED_ROUTES, safeTapTarget } from "@/lib/push/tapTarget";

const ORIGINS = ["https://app.isitbeachday.com", "http://localhost:3000"];
const BEACHES = new Set(listLocations().map((l) => l.slug));
const isBeach = (s: string) => BEACHES.has(s);
const tap = (raw: unknown) => safeTapTarget(raw, ORIGINS, isBeach);

describe("safeTapTarget", () => {
  it("opens the owner review on the alert, from the absolute address the owner push carries", () => {
    expect(tap("https://app.isitbeachday.com/admin/review?alert=12")).toBe("/admin/review?alert=12");
    expect(tap("/admin/review?alert=12")).toBe("/admin/review?alert=12");
    expect(tap("http://localhost:3000/admin/review?alert=5")).toBe("/admin/review?alert=5");
  });

  it("drops anything but a plain alert number from the review link", () => {
    expect(tap("/admin/review?alert=12&x=//evil.example")).toBe("/admin/review?alert=12");
    for (const bad of ["abc", "0", "-1", "1.5", "12345678901", "1e3", ""]) {
      expect(tap(`/admin/review?alert=${bad}`), bad).toBe("/admin/review");
    }
    expect(tap("/admin/review")).toBe("/admin/review");
    expect(tap("/admin/report")).toBe("/admin/report");
  });

  it("opens the flagship page: the root is allowed explicitly", () => {
    expect(tap("/")).toBe("/");
    expect(tap("https://app.isitbeachday.com/")).toBe("/");
    expect(tap("https://app.isitbeachday.com")).toBe("/");
  });

  it("opens a REAL beach page, in either form", () => {
    expect(tap("/boca-raton")).toBe("/boca-raton");
    expect(tap("https://app.isitbeachday.com/deerfield-beach")).toBe("/deerfield-beach");
    expect(tap("/boca-raton?utm=x#top")).toBe("/boca-raton");
    for (const slug of BEACHES) expect(tap(`/${slug}`), slug).toBe(`/${slug}`);
  });

  it("refuses a path that looks like a beach but is not one, and every beach without a list", () => {
    for (const bad of ["/not-a-beach", "/atlantis", "/boca", "/boca-raton-2"]) expect(tap(bad), bad).toBeNull();
    expect(safeTapTarget("/boca-raton", ORIGINS)).toBeNull(); // no beach list given: nothing passes
  });

  it("refuses another host, another scheme, and a protocol-relative address", () => {
    for (const bad of [
      "https://evil.example/admin/review?alert=1",
      "https://app.isitbeachday.com.evil.example/admin/review",
      "http://app.isitbeachday.com/admin/review", // wrong scheme for the production origin
      "//evil.example/boca-raton",
      "///evil.example",
      "javascript:alert(1)",
      "data:text/html,hi",
      "https://user:pw@app.isitbeachday.com/boca-raton",
      "\\\\evil.example",
      "/\\evil.example",
    ]) {
      expect(tap(bad), bad).toBeNull();
    }
  });

  it("refuses other paths: other admin pages, deep paths, dots, and api routes", () => {
    for (const bad of ["/admin", "/admin/", "/admin/other", "/admin/review/x", "/api/quality/owner/list", "/a/b", "/../admin/review", "/.hidden", "/boca raton", "/Boca-Raton"]) {
      expect(tap(bad), bad).toBeNull();
    }
  });

  it("refuses what is not a string", () => {
    for (const bad of [undefined, null, 5, {}, ["/boca-raton"], "", "x".repeat(400)]) expect(tap(bad)).toBeNull();
  });
});

describe("every top-level route of app/ other than a beach is refused", () => {
  const APP = path.join(process.cwd(), "app");
  // Names the router serves at the top level, from the folders and special files of app/.
  const names = readdirSync(APP)
    .filter((n) => !n.startsWith("_") && !n.startsWith("(") && !n.startsWith("@"))
    .map((n) => (statSync(path.join(APP, n)).isDirectory() ? n : n.replace(/\.[^.]+$/, "")))
    // files that are not routes or special files
    .filter((n) => !["globals", "layout", "page"].includes(n) && !n.endsWith(".test"))
    .map((n) => n.replace(/\.test$/, ""));

  it("finds the routes it should", () => {
    expect(names).toEqual(expect.arrayContaining(["admin", "api", "find", "get-app", "privacy", "sticker", "support", "[slug]"]));
  });

  it("refuses each one, even when it is passed off as a beach", () => {
    for (const n of names) {
      if (n === "[slug]") continue;
      // `isBeach` says yes to everything here: the reserved list alone must hold the line.
      expect(safeTapTarget(`/${n}`, ORIGINS, () => true), n).toBeNull();
      expect(safeTapTarget(`https://app.isitbeachday.com/${n}`, ORIGINS, () => true), n).toBeNull();
    }
  });

  it("lists every route in RESERVED_ROUTES, so a new route cannot slip in", () => {
    const missing = names.filter((n) => n !== "[slug]" && !RESERVED_ROUTES.includes(n));
    expect(missing, `add these app/ routes to RESERVED_ROUTES in lib/push/tapTarget.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("no beach is named like a route", () => {
    for (const slug of BEACHES) expect(RESERVED_ROUTES, slug).not.toContain(slug);
  });
});

describe("every push producer sends an address the tap handler opens", () => {
  const ROOT = process.cwd();
  const PRODUCERS = ["app/api/push/test/route.ts", "app/api/push/run/route.ts", "lib/alerts/run.ts"];
  // `url: "..."` or url: `...` in the producers' own source. A template may only interpolate a slug.
  const URL_RE = /\burl:\s*(`[^`\n]+`|"[^"\n]+")/g;

  it("finds the producers' addresses, and each one passes", () => {
    let found = 0;
    for (const file of PRODUCERS) {
      const src = readFileSync(path.join(ROOT, file), "utf8");
      for (const m of src.matchAll(URL_RE)) {
        const lit = m[1].slice(1, -1);
        const interpolations = [...lit.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]);
        expect(interpolations.every((e) => /slug/.test(e)), `${file}: ${lit}`).toBe(true);
        for (const slug of interpolations.length ? BEACHES : ["x"]) {
          const url = lit.replace(/\$\{[^}]*\}/g, slug);
          expect(tap(url), `${file}: ${url}`).not.toBeNull();
        }
        found += 1;
      }
    }
    expect(found).toBeGreaterThanOrEqual(5); // the test push, three morning/safety pushes, the alerts run
  });

  it("the owner push passes", () => {
    expect(tap(reviewUrl(12))).toBe("/admin/review?alert=12");
  });
});
