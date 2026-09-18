// /sticker is what a QR code on a lifeguard tower points at. It must always
// land the person on the beach score, and on the way it leaves the two traces
// the funnel needs: the counted scan, and the cookie that lets a later tap on
// "Get the app" be tagged with this sticker instead of counting as plain web
// traffic. A crawler building a link preview leaves neither.

import { describe, it, expect, beforeEach, vi } from "vitest";

const prepared: { sql: string; binds: unknown[] }[] = [];
let db: unknown = null;

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

const { GET } = await import("@/app/sticker/route");

const BROWSER_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";

function scan(url: string, ua = BROWSER_UA): Request {
  return new Request(url, { headers: { "User-Agent": ua, "cf-connecting-ip": "203.0.113.9" } });
}
const wrote = (needle: string) => prepared.filter((p) => p.sql.includes(needle));

beforeEach(() => {
  prepared.length = 0;
  db = recordingD1();
});

describe("GET /sticker", () => {
  it("counts the scan and sends the person to the dashboard", async () => {
    const res = await GET(scan("https://isitbeachday.com/sticker"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://isitbeachday.com/?ref=sticker");
    expect(wrote("INSERT INTO scan_log")).toHaveLength(1);
  });

  it("remembers the sticker's tag in a cookie, so a later store tap is credited", async () => {
    const res = await GET(scan("https://isitbeachday.com/sticker?s=tower-3"));
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("bd_ref=tower-3");
    expect(cookie).toContain("HttpOnly");
    expect(res.headers.get("location")).toBe("https://isitbeachday.com/?ref=tower-3");
  });

  it("leaves a network note the install match can use later", async () => {
    await GET(scan("https://isitbeachday.com/sticker"));
    const note = wrote("INSERT INTO scan_claim");
    expect(note).toHaveLength(1);
    // The note keeps a hashed token, never the address itself.
    expect(note[0].binds[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(note[0].binds)).not.toContain("203.0.113.9");
  });

  it("a link-preview crawler is redirected but counts for nothing", async () => {
    const res = await GET(scan("https://isitbeachday.com/sticker", "facebookexternalhit/1.1"));
    expect(res.status).toBe(307);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(prepared).toHaveLength(0);
  });

  it("still redirects when there is no database", async () => {
    db = null;
    const res = await GET(scan("https://isitbeachday.com/sticker"));
    expect(res.status).toBe(307);
  });
});
