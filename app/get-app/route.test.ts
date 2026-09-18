// /get-app counts the tap and gets out of the way. The redirect is the promise
// this route keeps, so the tests below care about two things: the visitor
// always lands on the App Store, and the tap is tagged with where the visit
// came from (a sticker cookie beats a `?s=` tag, and plain web traffic is
// tagged "web" rather than being folded into the sticker numbers).

import { describe, it, expect, beforeEach, vi } from "vitest";

const prepared: { sql: string; binds: unknown[] }[] = [];
let db: unknown = null;

/** A D1 stand-in that records what it was asked to write. */
function recordingD1() {
  return {
    prepare(sql: string) {
      const entry = { sql, binds: [] as unknown[] };
      const stmt = {
        bind(...binds: unknown[]) {
          entry.binds = binds;
          prepared.push(entry);
          return stmt;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
      return stmt;
    },
  };
}

vi.mock("@/lib/db/d1Store", () => ({ getD1: async () => db }));

const { GET } = await import("@/app/get-app/route");

const BROWSER_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";

function tap(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers: { "User-Agent": BROWSER_UA, ...headers } });
}

/** The source tag on the scan_tap write, or null when nothing was counted. */
function taggedSource(): string | null {
  const row = prepared.find((p) => p.sql.includes("INSERT INTO scan_tap"));
  return row ? (row.binds[1] as string) : null;
}

beforeEach(() => {
  prepared.length = 0;
  db = recordingD1();
});

describe("GET /get-app", () => {
  it("sends the visitor to the App Store", async () => {
    const res = await GET(tap("https://isitbeachday.com/get-app"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://apps.apple.com/us/app/id6779072992");
  });

  it("tags a tap from a scanned session with the sticker's own tag", async () => {
    await GET(tap("https://isitbeachday.com/get-app", { cookie: "bd_ref=tower-3" }));
    expect(taggedSource()).toBe("tower-3");
  });

  it("tags ordinary web traffic as web, so it never inflates the sticker numbers", async () => {
    await GET(tap("https://isitbeachday.com/get-app"));
    expect(taggedSource()).toBe("web");
  });

  it("lets the sticker cookie win over a ?s= tag", async () => {
    await GET(tap("https://isitbeachday.com/get-app?s=flyer", { cookie: "bd_ref=sticker" }));
    expect(taggedSource()).toBe("sticker");
  });

  it("takes ?s= when there is no cookie (a flyer or an email link)", async () => {
    await GET(tap("https://isitbeachday.com/get-app?s=flyer"));
    expect(taggedSource()).toBe("flyer");
  });

  it("reads the cookie among others, and keeps only a known-shaped tag", async () => {
    await GET(
      tap("https://isitbeachday.com/get-app", {
        cookie: "theme=dark; bd_ref=Tower 3!!; other=1",
      }),
    );
    expect(taggedSource()).toBe("tower3");
  });

  it("does not count a crawler's prefetch, but still redirects it", async () => {
    const res = await GET(
      tap("https://isitbeachday.com/get-app", { "User-Agent": "Slackbot-LinkExpanding 1.0" }),
    );
    expect(res.status).toBe(307);
    expect(taggedSource()).toBeNull();
  });

  it("still redirects when there is no database to count into", async () => {
    db = null;
    const res = await GET(tap("https://isitbeachday.com/get-app"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("apps.apple.com");
  });

  it("adds Apple's campaign tokens only when the provider token is configured", async () => {
    process.env.ASC_PROVIDER_TOKEN = "123456";
    try {
      const res = await GET(tap("https://isitbeachday.com/get-app", { cookie: "bd_ref=sticker" }));
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.searchParams.get("pt")).toBe("123456");
      expect(loc.searchParams.get("ct")).toBe("sticker");
      expect(loc.searchParams.get("mt")).toBe("8");
    } finally {
      delete process.env.ASC_PROVIDER_TOKEN;
    }
  });
});
