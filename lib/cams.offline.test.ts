import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCamViewsWithStatus, visibleCamViews } from "@/lib/cams";
import type { CamConfig, Location } from "@/lib/types";

// The offline rule wired into the cam list every surface is built from
// (lib/conditions.ts -> the page's cam grid and zoom viewer, /api/conditions/<slug>,
// its lean copy). Uses the lookups the cam card already makes: no extra fetches.

const NOW = Date.parse("2026-11-06T17:00:00Z"); // noon ET
const FEED_BASE = "https://video-monitoring.com/beachcams/test";

const meta = (id: string): CamConfig => ({
  id,
  name: id,
  provider: "Test",
  embedType: "image",
  url: `https://example.test/${id}`,
  snapshotUrl: `https://uw-frame.example.test/frame?cam=${id}`,
  snapshotMetaUrl: `https://uw-frame.example.test/meta?cam=${id}`,
  attribution: `Credit ${id}`,
});
const feed = (id: string, view: string): CamConfig => ({
  id,
  name: id,
  provider: "Test",
  embedType: "image",
  url: `https://example.test/${id}`,
  snapshotFeed: { base: FEED_BASE, view },
  attribution: `Credit ${id}`,
});

const loc = (cams: CamConfig[]): Location => ({
  slug: "test-beach",
  name: "Test Beach",
  region: "Test County, FL",
  lat: 26.35,
  lon: -80.07,
  timezone: "America/New_York",
  noaaTideStationId: "8722670",
  ndbcBuoyId: "41114",
  cams,
});

const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 3_600_000;

/** meta?cam=<id> answers from `metas`; latest.json from `views`; weather gets {}. */
function stub(metas: Record<string, unknown>, views: Record<string, unknown> | "fail") {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.includes("/meta?cam=")) {
        const id = new URL(url).searchParams.get("cam")!;
        return id in metas ? json(metas[id]) : new Response("no", { status: 404 });
      }
      if (url.includes("latest.json")) {
        if (views === "fail") throw new Error("ECONNRESET");
        return json(views);
      }
      return json({});
    }),
  );
  return calls;
}

async function run<T>(work: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(10_000);
  return work;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("cam list with the offline rule", () => {
  it("hides a dead courier cam and a silent feed cam, keeps the rest with their credits", async () => {
    vi.useFakeTimers();
    stub(
      {
        // The Deerfield underwater cam today: meta ok:false (no good frame stored).
        dead: { id: "dead", grabbedAtUtc: iso(0.2 * HOUR), ok: false, error: "blank frame" },
        live: { id: "live", grabbedAtUtc: iso(0.5 * HOUR), ok: true },
        late: { id: "late", grabbedAtUtc: iso(3 * HOUR), ok: true }, // stale: shown
      },
      {
        s1: { mr: "s1/a.jpg", timestamp: Math.floor((NOW - 10 * 60_000) / 1000) },
        s2: { mr: "s2/a.jpg", timestamp: Math.floor((NOW - 30 * HOUR) / 1000) }, // silent since yesterday
      },
    );
    const cams = await run(
      buildCamViewsWithStatus(
        loc([meta("dead"), meta("live"), meta("late"), feed("f-live", "s1"), feed("f-dead", "s2")]),
        NOW,
      ),
    );
    expect(cams.map((c) => [c.view.id, c.status])).toEqual([
      ["dead", "offline"],
      ["live", "online"],
      ["late", "stale"],
      ["f-live", "online"],
      ["f-dead", "offline"],
    ]);
    const shown = visibleCamViews(cams);
    expect(shown.map((c) => c.id)).toEqual(["live", "late", "f-live"]);
    // Every cam that is shown keeps its credit.
    expect(shown.map((c) => c.attribution)).toEqual(["Credit live", "Credit late", "Credit f-live"]);
  });

  it("makes no extra requests for the rule", async () => {
    vi.useFakeTimers();
    const calls = stub({ live: { id: "live", grabbedAtUtc: iso(HOUR / 2), ok: true } }, {});
    await run(buildCamViewsWithStatus(loc([meta("live")]), NOW));
    // One meta lookup + one spot-weather call, as before.
    expect(calls.filter((u) => u.includes("/meta?cam="))).toHaveLength(1);
  });

  it("a beach whose cams are all offline gets an empty list (no cam section)", async () => {
    vi.useFakeTimers();
    stub(
      { a: { id: "a", grabbedAtUtc: iso(HOUR), ok: false }, b: { id: "b", grabbedAtUtc: iso(9 * HOUR), ok: true } },
      { other: { mr: "other/a.jpg", timestamp: Math.floor(NOW / 1000) } }, // the feed dropped view "gone"
    );
    const cams = await run(buildCamViewsWithStatus(loc([meta("a"), meta("b"), feed("c", "gone")]), NOW));
    expect(cams.map((c) => c.status)).toEqual(["offline", "offline", "offline"]);
    expect(visibleCamViews(cams)).toEqual([]);
  });

  it("keeps cams it cannot judge: a failed lookup is not offline", async () => {
    vi.useFakeTimers();
    stub({}, "fail");
    const cams = await run(buildCamViewsWithStatus(loc([meta("unknown"), feed("f", "s1")]), NOW));
    expect(cams.map((c) => c.status)).toEqual(["online", "online"]);
    expect(visibleCamViews(cams)).toHaveLength(2);
  });

  it("a returning cam is shown again on its first good frame", async () => {
    vi.useFakeTimers();
    stub({ back: { id: "back", grabbedAtUtc: iso(60_000), ok: true } }, {});
    const cams = await run(buildCamViewsWithStatus(loc([meta("back")]), NOW));
    expect(visibleCamViews(cams).map((c) => c.id)).toEqual(["back"]);
  });

  it("reports when an aged-out cam went offline", async () => {
    vi.useFakeTimers();
    stub({ old: { id: "old", grabbedAtUtc: "2026-11-06T11:00:00.000Z", ok: true } }, {}); // 6:00 AM ET
    const [cam] = await run(buildCamViewsWithStatus(loc([meta("old")]), Date.parse("2026-11-06T18:00:00Z")));
    expect(cam.status).toBe("offline");
    expect(cam.offlineSince).toBe("2026-11-06T17:00:00.000Z");
  });
});

describe("odd answers are not evidence", () => {
  it("an empty meta or an empty latest.json leaves the cam shown", async () => {
    vi.useFakeTimers();
    stub({ odd: {} }, {});
    const cams = await run(buildCamViewsWithStatus(loc([meta("odd"), feed("f", "s1")]), NOW));
    expect(cams.map((c) => c.status)).toEqual(["online", "online"]);
  });
});
