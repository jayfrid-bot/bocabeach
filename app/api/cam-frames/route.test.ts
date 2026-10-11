// POST /api/cam-frames. D1 is a real SQLite database with migration 0016
// applied; R2 is an in-memory fake. Time is frozen so slots are exact.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Like, D1Stmt } from "@/lib/db/d1Store";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { fakeBucket, fakeJpeg, type FakeBucket } from "@/lib/camFrames/testFixtures";
import { parseFrameKey } from "@/lib/camFrames/keys";
import { MAX_FRAME_BYTES } from "@/lib/camFrames/ingest";

const ctl = vi.hoisted(() => ({
  db: null as unknown,
  bucket: null as unknown,
  disabled: new Set<string>(),
}));

vi.mock("@/lib/db/d1Store", () => ({ getD1: async () => ctl.db }));
vi.mock("@/lib/camFrames/r2", () => ({ getCamFramesBucket: async () => ctl.bucket }));
vi.mock("@/lib/camFrames/manifest", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/camFrames/manifest")>();
  return {
    ...real,
    lookupCam: (slug: string, cam: string) =>
      ctl.disabled.has(cam) ? { status: "disabled" as const } : real.lookupCam(slug, cam),
  };
});

import { POST } from "@/app/api/cam-frames/route";

const TOKEN = "test-ingest-token";
const NOW = Date.parse("2026-10-11T14:20:00.000Z");

let h: CamDb;
let bucket: FakeBucket;

function req(
  body: Uint8Array | null,
  query: Record<string, string> = { slug: "boca-raton", cam: "boca-south" },
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Request {
  const qs = new URLSearchParams(query).toString();
  return new Request(`http://localhost/api/cam-frames?${qs}`, {
    method: "POST",
    headers,
    body: body as BodyInit | null,
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function rows(): Record<string, unknown>[] {
  return h.all("SELECT * FROM cam_frames ORDER BY slot_utc, cam_id");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.INGEST_TOKEN = TOKEN;
  h = makeCamDb() as CamDb;
  bucket = fakeBucket();
  ctl.db = h?.db ?? null;
  ctl.bucket = bucket;
  ctl.disabled = new Set();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.INGEST_TOKEN;
  h?.close();
});

describe.skipIf(!HAS_SQLITE)("POST /api/cam-frames", () => {
  describe("auth", () => {
    it("503s when INGEST_TOKEN is not configured", async () => {
      delete process.env.INGEST_TOKEN;
      const res = await POST(req(fakeJpeg()));
      expect(res.status).toBe(503);
    });

    it("401s with no header, a wrong token, or a non-bearer scheme", async () => {
      const bad: Record<string, string>[] = [{}, { authorization: "Bearer nope" }, { authorization: `Basic ${TOKEN}` }, { authorization: TOKEN }];
      for (const headers of bad) {
        const res = await POST(req(fakeJpeg(), undefined, headers));
        expect(res.status).toBe(401);
      }
      expect(rows()).toHaveLength(0);
      expect(bucket.objects.size).toBe(0);
    });

    it("checks auth before looking at the cam or the body", async () => {
      const res = await POST(req(fakeJpeg(), { slug: "nowhere", cam: "x" }, {}));
      expect(res.status).toBe(401);
    });
  });

  describe("which cam", () => {
    it("404s on an unknown slug, an unknown cam, or a missing parameter", async () => {
      const bad: Record<string, string>[] = [{ slug: "nowhere", cam: "boca-south" }, { slug: "boca-raton", cam: "nope" }, { slug: "boca-raton" }, {}];
      for (const q of bad) {
        const res = await POST(req(fakeJpeg(), q));
        expect(res.status).toBe(404);
      }
    });

    it("403s on a cam set to archive: false, and stores nothing", async () => {
      ctl.disabled.add("boca-south");
      const res = await POST(req(fakeJpeg()));
      expect(res.status).toBe(403);
      expect(rows()).toHaveLength(0);
      expect(bucket.objects.size).toBe(0);
    });
  });

  describe("body checks", () => {
    it("413s on a Content-Length over 600 KB before reading the body", async () => {
      const r = req(fakeJpeg(), undefined, { authorization: `Bearer ${TOKEN}`, "content-length": String(MAX_FRAME_BYTES + 1) });
      const res = await POST(r);
      expect(res.status).toBe(413);
      expect(rows()).toHaveLength(0);
    });

    it("413s when the real body passes 600 KB with no Content-Length", async () => {
      const big = fakeJpeg(MAX_FRAME_BYTES + 5000);
      const res = await POST(req(big));
      expect(res.status).toBe(413);
      expect(rows()).toHaveLength(0);
      expect(bucket.objects.size).toBe(0);
    });

    it("accepts a body of exactly 600 KB", async () => {
      const res = await POST(req(fakeJpeg(MAX_FRAME_BYTES)));
      expect(res.status).toBe(200);
      expect((await json(res)).stored).toBe(true);
    });

    it("400s on an empty body, a non-JPEG, and a body under 10 KB", async () => {
      expect((await POST(req(null))).status).toBe(400);
      expect((await POST(req(new Uint8Array()))).status).toBe(400);
      const png = fakeJpeg(20_000);
      png.set([0x89, 0x50, 0x4e, 0x47]);
      expect((await POST(req(png))).status).toBe(400);
      expect((await POST(req(new TextEncoder().encode("<html>".repeat(5000))))).status).toBe(400);
      expect((await POST(req(fakeJpeg(10_239)))).status).toBe(400);
      expect(rows()).toHaveLength(0);
      expect(bucket.objects.size).toBe(0);
    });

    it("accepts a body of exactly 10 KB", async () => {
      expect((await POST(req(fakeJpeg(10_240)))).status).toBe(200);
    });
  });

  describe("fail closed", () => {
    it("503s when the R2 binding is missing", async () => {
      ctl.bucket = null;
      const res = await POST(req(fakeJpeg()));
      expect(res.status).toBe(503);
      expect(rows()).toHaveLength(0);
    });

    it("503s when the D1 binding is missing", async () => {
      ctl.db = null;
      const res = await POST(req(fakeJpeg()));
      expect(res.status).toBe(503);
      expect(bucket.objects.size).toBe(0);
    });
  });

  describe("storing a frame", () => {
    it("stores the object and a ready row, and answers with the key and slot", async () => {
      const bytes = fakeJpeg(30_000);
      const res = await POST(req(bytes));
      expect(res.status).toBe(200);
      const out = await json(res);
      expect(out.stored).toBe(true);
      expect(out.slotUtc).toBe("2026-10-11T14:00:00.000Z");
      expect(out.displayAtUtc).toBe("2026-10-11T14:20:00.000Z");
      const key = out.key as string;
      expect(parseFrameKey(key)).toMatchObject({ slug: "boca-raton", camId: "boca-south", localDate: "2026-10-11", utcHour: 14, utcMinute: 20 });

      const obj = bucket.objects.get(key);
      expect(obj).toBeDefined();
      expect(Buffer.compare(Buffer.from(obj!.bytes), Buffer.from(bytes))).toBe(0);
      expect(obj!.options?.httpMetadata?.contentType).toBe("image/jpeg");
      expect(obj!.options?.customMetadata).toEqual({ slug: "boca-raton", cam: "boca-south", displayAtUtc: "2026-10-11T14:20:00.000Z" });

      const [row] = rows();
      expect(row).toMatchObject({
        slug: "boca-raton",
        cam_id: "boca-south",
        slot_utc: "2026-10-11T14:00:00.000Z",
        received_at_utc: "2026-10-11T14:20:00.000Z",
        frame_at_utc: null,
        display_at_utc: "2026-10-11T14:20:00.000Z",
        local_date: "2026-10-11",
        local_hour: 10,
        local_minute: 20,
        utc_offset_minutes: -240,
        timezone: "America/New_York",
        r2_key: key,
        bytes: 30_000,
        source_kind: "feed",
        attribution: "Live still courtesy Palm Beach County ERM / video-monitoring.com",
        state: "ready",
      });
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(key).toContain((row.sha256 as string).slice(0, 8));
    });

    it("stores the cam's attribution and source kind from config, for a courier cam", async () => {
      const res = await POST(req(fakeJpeg(), { slug: "fort-lauderdale", cam: "ftl-elbo-beach-cam" }));
      expect(res.status).toBe(200);
      const [row] = rows();
      expect(row.source_kind).toBe("direct");
      expect(row.attribution).toBe("Live stream courtesy Elbo Room (ElboRoom.com)");
    });

    it("uses a believable frameAt as the display time and slot", async () => {
      const res = await POST(req(fakeJpeg(), { slug: "boca-raton", cam: "boca-south", frameAt: "2026-10-11T13:41:07Z" }));
      const out = await json(res);
      expect(out.slotUtc).toBe("2026-10-11T13:00:00.000Z");
      expect(out.displayAtUtc).toBe("2026-10-11T13:41:07.000Z");
      const [row] = rows();
      expect(row.frame_at_utc).toBe("2026-10-11T13:41:07.000Z");
      expect(row.received_at_utc).toBe("2026-10-11T14:20:00.000Z");
      expect(row.local_hour).toBe(9);
      expect(row.local_minute).toBe(41);
    });

    it.each([
      ["a time 4 hours old", "2026-10-11T10:20:00Z"],
      ["a time 10 minutes in the future", "2026-10-11T14:30:00Z"],
      ["garbage", "not-a-time"],
      ["a time with no zone", "2026-10-11T14:00:00"],
    ])("falls back to the server clock for %s", async (_n, frameAt) => {
      const res = await POST(req(fakeJpeg(), { slug: "boca-raton", cam: "boca-south", frameAt }));
      expect((await json(res)).displayAtUtc).toBe("2026-10-11T14:20:00.000Z");
      expect(rows()[0].frame_at_utc).toBeNull();
    });

    it("puts the local date on the beach's day: 11:59 PM Eastern is still the day before in UTC terms", async () => {
      vi.setSystemTime(Date.parse("2026-10-11T03:59:00Z"));
      const out = await json(await POST(req(fakeJpeg())));
      expect((out.key as string).startsWith("boca-raton/boca-south/2026-10-10/0359Z-")).toBe(true);
      expect(rows()[0]).toMatchObject({ local_date: "2026-10-10", local_hour: 23, local_minute: 59 });
    });
  });

  describe("one shot per slot", () => {
    it("says slot-taken for a second, different frame in the same hour, and keeps the first", async () => {
      const first = await json(await POST(req(fakeJpeg(20_000, 1))));
      expect(first.stored).toBe(true);
      vi.setSystemTime(NOW + 10 * 60_000);
      const second = await json(await POST(req(fakeJpeg(20_000, 2))));
      expect(second).toEqual({ stored: false, reason: "slot-taken" });
      expect(rows()).toHaveLength(1);
      expect(bucket.objects.size).toBe(1);
      expect([...bucket.objects.keys()]).toEqual([first.key]);
    });

    it("stores the next hour's frame", async () => {
      await POST(req(fakeJpeg(20_000, 1)));
      vi.setSystemTime(NOW + 45 * 60_000); // 15:05Z
      const out = await json(await POST(req(fakeJpeg(20_000, 2))));
      expect(out.stored).toBe(true);
      expect(out.slotUtc).toBe("2026-10-11T15:00:00.000Z");
      expect(rows()).toHaveLength(2);
    });

    it("keeps cams and beaches apart", async () => {
      await POST(req(fakeJpeg(20_000, 1)));
      const other = await json(await POST(req(fakeJpeg(20_000, 1), { slug: "boca-raton", cam: "boca-inlet" })));
      expect(other.stored).toBe(true);
    });

    it("answers unchanged for an identical image in a new slot, leaving no pending row and no new object", async () => {
      const same = fakeJpeg(20_000, 7);
      await POST(req(same));
      vi.setSystemTime(NOW + 45 * 60_000);
      const out = await json(await POST(req(same)));
      expect(out).toEqual({ stored: false, reason: "unchanged" });
      expect(rows()).toHaveLength(1);
      expect(bucket.objects.size).toBe(1);
      // The slot was released, so a genuinely new frame can still use it.
      const later = await json(await POST(req(fakeJpeg(20_000, 8))));
      expect(later.stored).toBe(true);
      expect(rows()).toHaveLength(2);
    });

    it("compares against the newest READY frame only, so a stuck pending row cannot cause 'unchanged'", async () => {
      // A crashed ingest left a pending row for 13:00 with the same bytes.
      const bytes = fakeJpeg(20_000, 9);
      const crashed = await json(await POST(req(bytes, { slug: "boca-raton", cam: "boca-south", frameAt: "2026-10-11T13:30:00Z" })));
      expect(crashed.stored).toBe(true);
      h.db.prepare("UPDATE cam_frames SET state = 'pending'").run();
      const out = await json(await POST(req(bytes)));
      expect(out.stored).toBe(true);
    });
  });

  describe("concurrency", () => {
    it("two simultaneous posts for one slot store exactly one frame", async () => {
      const [a, b] = await Promise.all([POST(req(fakeJpeg(20_000, 1))), POST(req(fakeJpeg(20_000, 2)))]);
      const outs = [await json(a), await json(b)];
      expect(outs.filter((o) => o.stored === true)).toHaveLength(1);
      expect(outs.filter((o) => o.reason === "slot-taken")).toHaveLength(1);
      expect(rows()).toHaveLength(1);
      expect(rows()[0].state).toBe("ready");
      expect(bucket.objects.size).toBe(1);
    });

    it("two simultaneous posts of the SAME image store exactly one frame", async () => {
      const same = fakeJpeg(20_000, 5);
      const [a, b] = await Promise.all([POST(req(same)), POST(req(same))]);
      const outs = [await json(a), await json(b)];
      expect(outs.filter((o) => o.stored === true)).toHaveLength(1);
      expect(outs.filter((o) => o.stored === false)).toHaveLength(1);
      expect(rows()).toHaveLength(1);
      expect(bucket.objects.size).toBe(1);
    });

    it("eight simultaneous posts store exactly one", async () => {
      const res = await Promise.all(Array.from({ length: 8 }, (_, i) => POST(req(fakeJpeg(20_000, i + 1)))));
      const outs = await Promise.all(res.map(json));
      expect(outs.filter((o) => o.stored === true)).toHaveLength(1);
      expect(rows()).toHaveLength(1);
      expect(bucket.objects.size).toBe(1);
    });
  });

  describe("failures settle the pending row", () => {
    it("R2 put failure: 502, no row left, no object, and the slot can be retried", async () => {
      bucket.failPut = true;
      const res = await POST(req(fakeJpeg()));
      expect(res.status).toBe(502);
      expect(rows()).toHaveLength(0);
      expect(bucket.objects.size).toBe(0);
      bucket.failPut = false;
      expect((await json(await POST(req(fakeJpeg())))).stored).toBe(true);
    });

    it("finalize failure: 500, the R2 object is deleted and no row is left", async () => {
      const real = h.db;
      const failing: D1Like = {
        prepare(sql: string): D1Stmt {
          const stmt = real.prepare(sql);
          if (!/SET state = 'ready'/.test(sql)) return stmt;
          return { ...stmt, bind: () => failing.prepare(sql), run: async () => { throw new Error("d1 down (test)"); } } as D1Stmt;
        },
      };
      ctl.db = failing;
      const res = await POST(req(fakeJpeg()));
      expect(res.status).toBe(500);
      expect(bucket.objects.size).toBe(0);
      expect(bucket.deleted).toHaveLength(1);
      expect(rows()).toHaveLength(0);
    });

    it("finalize failure with R2 delete also failing still answers 500 without throwing", async () => {
      const real = h.db;
      ctl.db = {
        prepare(sql: string): D1Stmt {
          const stmt = real.prepare(sql);
          if (!/SET state = 'ready'/.test(sql)) return stmt;
          return { ...stmt, bind: () => ctl.db && (ctl.db as D1Like).prepare(sql), run: async () => { throw new Error("d1 down (test)"); } } as D1Stmt;
        },
      } as D1Like;
      bucket.failDelete = true;
      const res = await POST(req(fakeJpeg()));
      expect(res.status).toBe(500);
    });

    it("a claim failure answers 503 and writes nothing to R2", async () => {
      const real = h.db;
      ctl.db = {
        prepare(sql: string): D1Stmt {
          if (/INSERT INTO cam_frames/.test(sql)) {
            const stmt = real.prepare(sql);
            return { ...stmt, bind: () => ({ ...stmt, run: async () => { throw new Error("d1 down (test)"); } }) } as D1Stmt;
          }
          return real.prepare(sql);
        },
      } as D1Like;
      const res = await POST(req(fakeJpeg()));
      expect(res.status).toBe(503);
      expect(bucket.objects.size).toBe(0);
    });
  });
});
