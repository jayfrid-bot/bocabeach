import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  toFeedEntry,
  normalizeNetPrecision,
  ORBIT_ALLOWLIST,
  ACTIVE_STATUS_ABBREVS,
  WINDOW_DAYS,
  MAX_PAGES,
  PACING_MIN_GAP_MS,
  computePacingWaitMs,
  buildFeedPayload,
  buildFirstPageUrl,
  fetchAllUpcomingPages,
  parseRangeLocationIds,
  runOnce,
} from "@/scripts/launch_library.mjs";

// A real LL2 "upcoming launches" result, shaped exactly like the live API
// (SKY_EVENTS_PLAN.md §7's own citation + this crew's own live verification
// 2026-09-28) — Starbase location id 143, pad id 235.
function ll2Result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "7d1afb26-6f9c-429b-9ccf-29012fd1e519",
    name: "Starship | Starlink Group 31-1 (Starship Flight 14)",
    net: "2026-10-08T12:15:00Z",
    window_start: "2026-10-08T12:15:00Z",
    window_end: "2026-10-08T13:30:00Z",
    net_precision: { name: "Minute" },
    status: { abbrev: "Go", name: "Go for Launch" },
    pad: { id: 235, location: { id: 143 } },
    mission: { orbit: { abbrev: "LEO", name: "Low Earth Orbit" } },
    last_updated: "2026-09-28T03:40:54Z",
    ...overrides,
  };
}

const RANGE_IDS = new Set([12, 27, 11, 21, 143]);
const NOW = new Date("2026-09-28T06:00:00Z");
const WINDOW_END_MS = NOW.getTime() + WINDOW_DAYS * 86_400_000;

describe("normalizeNetPrecision", () => {
  it("maps LL2's real precision names onto the closed enum (verified live 2026-09-28)", () => {
    expect(normalizeNetPrecision("Second")).toBe("Minute");
    expect(normalizeNetPrecision("Minute")).toBe("Minute");
    expect(normalizeNetPrecision("Hour")).toBe("Hour");
    expect(normalizeNetPrecision("Day")).toBe("Day");
    expect(normalizeNetPrecision("Month")).toBe("Month");
    expect(normalizeNetPrecision("Quarter 4")).toBe("Quarter");
    expect(normalizeNetPrecision("Year Half 2")).toBe("Year");
    expect(normalizeNetPrecision("Year")).toBe("Year");
  });

  it("falls back to Unknown for anything unrecognized or missing", () => {
    expect(normalizeNetPrecision("Fortnight")).toBe("Unknown");
    expect(normalizeNetPrecision(undefined)).toBe("Unknown");
    expect(normalizeNetPrecision(null)).toBe("Unknown");
    expect(normalizeNetPrecision(42)).toBe("Unknown");
  });
});

describe("computePacingWaitMs — the workflow's pre-loop pacing gate (Codex round 2 + round 3)", () => {
  const NOW_MS = Date.parse("2026-10-08T14:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();

  it("no usable candidates at all (unreadable/missing) — waits the full, capped 30-min gap", () => {
    expect(computePacingWaitMs([], NOW_MS)).toBe(PACING_MIN_GAP_MS);
    expect(computePacingWaitMs([null], NOW_MS)).toBe(PACING_MIN_GAP_MS);
    expect(computePacingWaitMs([undefined, "not-a-date", ""], NOW_MS)).toBe(PACING_MIN_GAP_MS);
  });

  it("a single candidate exactly 30 min ago — no wait needed", () => {
    expect(computePacingWaitMs([iso(NOW_MS - PACING_MIN_GAP_MS)], NOW_MS)).toBe(0);
  });

  it("a single candidate over 30 min ago — no wait needed (never a negative wait)", () => {
    expect(computePacingWaitMs([iso(NOW_MS - PACING_MIN_GAP_MS - 60_000)], NOW_MS)).toBe(0);
  });

  it("a single candidate 10 min ago — waits out the remaining 20 min", () => {
    expect(computePacingWaitMs([iso(NOW_MS - 10 * 60_000)], NOW_MS)).toBe(20 * 60_000);
  });

  it("a single candidate 0 min ago (a cycle just landed) — waits the full 30 min", () => {
    expect(computePacingWaitMs([iso(NOW_MS)], NOW_MS)).toBe(PACING_MIN_GAP_MS);
  });

  it("ANY implausibly FUTURE candidate (clock skew/corruption) forces the full conservative wait, even alongside a perfectly good candidate", () => {
    const future = iso(NOW_MS + 5 * 60_000);
    const goodAndOld = iso(NOW_MS - 60 * 60_000); // 1h ago — would otherwise need no wait at all
    expect(computePacingWaitMs([future], NOW_MS)).toBe(PACING_MIN_GAP_MS);
    expect(computePacingWaitMs([future, goodAndOld], NOW_MS)).toBe(PACING_MIN_GAP_MS);
  });

  it("an unreadable candidate alongside a good one is simply ignored — the good candidate alone decides", () => {
    const tenMinAgo = iso(NOW_MS - 10 * 60_000);
    expect(computePacingWaitMs([null, tenMinAgo, "garbage"], NOW_MS)).toBe(20 * 60_000);
  });

  it("uses the MORE RECENT of two valid candidates, regardless of array order", () => {
    const old = iso(NOW_MS - 25 * 60_000); // would need a 5-min wait alone
    const recent = iso(NOW_MS - 5 * 60_000); // needs a 25-min wait alone
    expect(computePacingWaitMs([old, recent], NOW_MS)).toBe(25 * 60_000);
    expect(computePacingWaitMs([recent, old], NOW_MS)).toBe(25 * 60_000); // order-independent
  });

  it("round 2: a cycle at :00, another at :30, then a dispatch at :35 — the dispatch's first cycle now waits instead of firing immediately", () => {
    const t0 = Date.parse("2026-10-08T14:00:00Z");
    const t30 = t0 + 30 * 60_000;
    const t35 = t0 + 35 * 60_000;
    expect(computePacingWaitMs([iso(t30)], t35)).toBe(25 * 60_000);
  });

  it("round 3 (HIGH): a cycle that spends requests and then FAILS leaves the feed's generatedAt stale — but its durable last_attempt.attemptedAt still forces the wait", () => {
    const twoHoursAgo = Date.parse("2026-10-08T12:00:00Z"); // the feed's stale generatedAt, from the last SUCCESSFUL cycle
    const attemptedNow = Date.parse("2026-10-08T14:00:00Z"); // a cycle just attempted (and failed) right now
    const restartFiveMinLater = attemptedNow + 5 * 60_000; // a workflow_dispatch cancels + restarts 5 min later
    // Round-2-only behavior (single candidate = feed generatedAt alone)
    // would have seen a 2h-stale feed and computed wait=0 — letting the
    // restart spend MORE requests immediately on top of the failed
    // cycle's already-spent ones. Reading BOTH candidates closes that gap:
    const wait = computePacingWaitMs([iso(twoHoursAgo), iso(attemptedNow)], restartFiveMinLater);
    expect(wait).toBe(25 * 60_000); // paced from the RECENT attempt, not the stale feed
    expect(wait).toBeGreaterThan(0); // the bug this fixes: this used to be 0
  });
});

describe("MAX_PAGES — the workflow's documented rate-limit math actually holds (review item e)", () => {
  it("worst-case requests/hour (MAX_PAGES * 2 retries * 2 cycles/hour) stays under LL2's ~15/hour limit", () => {
    const requestsPerPage = 2; // fetch + 1 retry
    const cyclesPerHour = 2; // 30-min workflow cadence
    const worstCasePerHour = MAX_PAGES * requestsPerPage * cyclesPerHour;
    expect(worstCasePerHour).toBeLessThanOrEqual(12);
    expect(worstCasePerHour).toBeLessThan(15);
  });
});

describe("ORBIT_ALLOWLIST / ACTIVE_STATUS_ABBREVS", () => {
  it("contains the plan's explicit examples plus what was verified live 2026-09-28", () => {
    for (const abbrev of ["LEO", "MEO", "GTO", "SSO", "HEO"]) {
      expect(ORBIT_ALLOWLIST.has(abbrev)).toBe(true);
    }
    expect(ORBIT_ALLOWLIST.has("Sub")).toBe(false);
    expect(ORBIT_ALLOWLIST.has("N/A")).toBe(false);
  });

  it("only Go/TBD/TBC/Hold/In Flight count as active", () => {
    for (const abbrev of ["Go", "TBD", "TBC", "Hold", "In Flight"]) {
      expect(ACTIVE_STATUS_ABBREVS.has(abbrev)).toBe(true);
    }
    for (const abbrev of ["Success", "Failure", "Partial Failure", "Cancelled"]) {
      expect(ACTIVE_STATUS_ABBREVS.has(abbrev)).toBe(false);
    }
  });
});

describe("toFeedEntry — validation (§7)", () => {
  it("accepts a well-formed, in-range, in-window, Go/LEO launch", () => {
    const entry = toFeedEntry(ll2Result(), RANGE_IDS, NOW, WINDOW_END_MS);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe("7d1afb26-6f9c-429b-9ccf-29012fd1e519");
    expect(entry!.netPrecision).toBe("Minute");
    expect(entry!.status).toBe("Go");
    expect(entry!.padId).toBe(235);
    expect(entry!.padLocationId).toBe(143);
    expect(entry!.orbitAbbrev).toBe("LEO");
  });

  it.each(["Cancelled", "Success", "Failure", "Partial Failure"])("rejects an ended/terminal status (%s)", (abbrev) => {
    const entry = toFeedEntry(ll2Result({ status: { abbrev, name: abbrev } }), RANGE_IDS, NOW, WINDOW_END_MS);
    expect(entry).toBeNull();
  });

  it("rejects a status abbrev it doesn't recognize at all, never assuming it's active", () => {
    const entry = toFeedEntry(ll2Result({ status: { abbrev: "SomeNewStatus", name: "x" } }), RANGE_IDS, NOW, WINDOW_END_MS);
    expect(entry).toBeNull();
  });

  it("folds TBC into TBD (no TBC variant in the frozen LaunchSkyEvent type)", () => {
    const entry = toFeedEntry(ll2Result({ status: { abbrev: "TBC", name: "To Be Confirmed" } }), RANGE_IDS, NOW, WINDOW_END_MS);
    expect(entry?.status).toBe("TBD");
  });

  it("rejects a launch whose pad.location.id isn't one of the 4 ranges", () => {
    const entry = toFeedEntry(ll2Result({ pad: { id: 999, location: { id: 6 } } }), RANGE_IDS, NOW, WINDOW_END_MS);
    expect(entry).toBeNull();
  });

  it.each(["id", "net", "window_start", "window_end", "last_updated"])("rejects a launch missing required field %s", (field) => {
    const raw = ll2Result();
    delete raw[field];
    expect(toFeedEntry(raw, RANGE_IDS, NOW, WINDOW_END_MS)).toBeNull();
  });

  it("rejects a launch with a malformed net (unparseable date)", () => {
    expect(toFeedEntry(ll2Result({ net: "not-a-date" }), RANGE_IDS, NOW, WINDOW_END_MS)).toBeNull();
  });

  it("rejects a launch outside the 14-day window (too far in the future)", () => {
    const farNet = new Date(NOW.getTime() + (WINDOW_DAYS + 1) * 86_400_000).toISOString();
    const entry = toFeedEntry(ll2Result({ net: farNet, window_start: farNet, window_end: farNet }), RANGE_IDS, NOW, WINDOW_END_MS);
    expect(entry).toBeNull();
  });

  it("rejects a launch whose net is already in the past relative to now", () => {
    const pastNet = new Date(NOW.getTime() - 3_600_000).toISOString();
    const entry = toFeedEntry(ll2Result({ net: pastNet, window_start: pastNet, window_end: pastNet }), RANGE_IDS, NOW, WINDOW_END_MS);
    expect(entry).toBeNull();
  });

  it("accepts a launch right at the 14-day boundary and rejects one just past it", () => {
    const atBoundary = new Date(WINDOW_END_MS).toISOString();
    const pastBoundary = new Date(WINDOW_END_MS + 60_000).toISOString();
    expect(toFeedEntry(ll2Result({ net: atBoundary, window_start: atBoundary, window_end: atBoundary }), RANGE_IDS, NOW, WINDOW_END_MS)).not.toBeNull();
    expect(
      toFeedEntry(ll2Result({ net: pastBoundary, window_start: pastBoundary, window_end: pastBoundary }), RANGE_IDS, NOW, WINDOW_END_MS),
    ).toBeNull();
  });

  it("an unrecognized/missing mission.orbit.abbrev publishes orbitAbbrev: null, never assumed orbital", () => {
    expect(toFeedEntry(ll2Result({ mission: null }), RANGE_IDS, NOW, WINDOW_END_MS)?.orbitAbbrev).toBeNull();
    expect(toFeedEntry(ll2Result({ mission: { orbit: { abbrev: "Sub" } } }), RANGE_IDS, NOW, WINDOW_END_MS)?.orbitAbbrev).toBeNull();
    expect(toFeedEntry(ll2Result({ mission: { orbit: null } }), RANGE_IDS, NOW, WINDOW_END_MS)?.orbitAbbrev).toBeNull();
  });

  it("orbitalLauncher (§7 amendment): an undisclosed orbit on an orbital-class launcher counts; suborbital or no capacity never does", () => {
    const fh = { configuration: { id: 161, name: "Falcon Heavy", leo_capacity: 63800 } };
    const classified = toFeedEntry(ll2Result({ rocket: fh, mission: { orbit: { abbrev: "N/A", name: "Unknown" } } }), RANGE_IDS, NOW, WINDOW_END_MS)!;
    expect(classified.orbitAbbrev).toBeNull(); // the orbit itself stays honest
    expect(classified.orbitalLauncher).toBe(true);
    expect(toFeedEntry(ll2Result({ rocket: fh, mission: null }), RANGE_IDS, NOW, WINDOW_END_MS)!.orbitalLauncher).toBe(true);
    // LL2 says suborbital — never orbital, whatever the vehicle can lift.
    expect(toFeedEntry(ll2Result({ rocket: fh, mission: { orbit: { abbrev: "Sub" } } }), RANGE_IDS, NOW, WINDOW_END_MS)!.orbitalLauncher).toBe(false);
    // No capacity data, zero, a string, or no rocket at all — false.
    for (const rocket of [undefined, null, { configuration: null }, { configuration: { leo_capacity: null } }, { configuration: { leo_capacity: 0 } }, { configuration: { leo_capacity: "63800" } }]) {
      expect(toFeedEntry(ll2Result({ rocket, mission: { orbit: { abbrev: "N/A" } } }), RANGE_IDS, NOW, WINDOW_END_MS)!.orbitalLauncher).toBe(false);
    }
  });

  it("a scrub/reschedule (same id, new net/window/status on the next poll) is represented as the SAME id with the new fields — no duplicate identity", () => {
    const before = toFeedEntry(ll2Result(), RANGE_IDS, NOW, WINDOW_END_MS)!;
    const rescheduled = toFeedEntry(
      ll2Result({ net: "2026-10-09T14:00:00Z", window_start: "2026-10-09T14:00:00Z", window_end: "2026-10-09T15:00:00Z", status: { abbrev: "TBD" } }),
      RANGE_IDS,
      NOW,
      WINDOW_END_MS,
    )!;
    expect(rescheduled.id).toBe(before.id); // same LL2 UUID -> same card row identity downstream (§7)
    expect(rescheduled.net).not.toBe(before.net);
    expect(rescheduled.status).toBe("TBD");
  });
});

describe("buildFeedPayload", () => {
  it("an empty result set is a valid, publishable empty payload (§8) — not an error", () => {
    const out = buildFeedPayload([], RANGE_IDS, NOW);
    expect(out.schemaVersion).toBe(1);
    expect(out.generatedAt).toBe(NOW.toISOString());
    expect(out.launches).toEqual([]);
  });

  it("keeps only the valid entries, sorted soonest-net-first", () => {
    const soon = ll2Result({ id: "soon", net: "2026-10-01T00:00:00Z", window_start: "2026-10-01T00:00:00Z", window_end: "2026-10-01T01:00:00Z" });
    const later = ll2Result({ id: "later", net: "2026-10-05T00:00:00Z", window_start: "2026-10-05T00:00:00Z", window_end: "2026-10-05T01:00:00Z" });
    const cancelled = ll2Result({ id: "dead", status: { abbrev: "Cancelled" } });
    const out = buildFeedPayload([later, cancelled, soon], RANGE_IDS, NOW);
    expect(out.launches.map((l) => l.id)).toEqual(["soon", "later"]);
  });
});

describe("parseRangeLocationIds — parses the real committed config/launchPads.ts", () => {
  it("finds all 5 LL2 location ids across the 4 ranges", () => {
    const tsPath = path.resolve(process.cwd(), "config/launchPads.ts");
    expect(fs.existsSync(tsPath)).toBe(true);
    const ids = parseRangeLocationIds(tsPath);
    expect(ids).toEqual(new Set([12, 27, 11, 21, 143]));
  });
});

describe("buildFirstPageUrl — date/location-bounded query (review item e)", () => {
  it("carries mode, ordering, the net__gte/net__lte window, and a sorted location__ids list", () => {
    const now = new Date("2026-09-28T06:00:00Z");
    const windowEndMs = now.getTime() + WINDOW_DAYS * 86_400_000;
    const url = new URL(buildFirstPageUrl("https://ll.thespacedevs.com/2.3.0/launches/upcoming/", new Set([27, 12, 143]), now, windowEndMs));
    expect(url.searchParams.get("mode")).toBe("detailed");
    expect(url.searchParams.get("ordering")).toBe("net");
    expect(url.searchParams.get("net__gte")).toBe(now.toISOString());
    expect(url.searchParams.get("net__lte")).toBe(new Date(windowEndMs).toISOString());
    expect(url.searchParams.get("location__ids")).toBe("12,27,143"); // sorted, regardless of Set insertion order
  });
});

describe("fetchAllUpcomingPages — bounded pagination (review item e)", () => {
  const NOW = new Date("2026-09-28T06:00:00Z");
  const WINDOW_END_MS = NOW.getTime() + WINDOW_DAYS * 86_400_000;

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
  function resultWithNet(net: string) {
    return ll2Result({ net, window_start: net, window_end: net });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a single page with no `next` is a complete, ok result", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ results: [resultWithNet("2026-10-01T00:00:00Z")], next: null }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchAllUpcomingPages("http://fixture.invalid/page1", WINDOW_END_MS, MAX_PAGES);
    expect(r.ok).toBe(true);
    expect(r.pages).toBe(1);
    expect(r.results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops as soon as a page's results run past the 14-day window, even though `next` exists (net-ascending assumption)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        results: [resultWithNet("2026-10-01T00:00:00Z"), resultWithNet(new Date(WINDOW_END_MS + 86_400_000).toISOString())],
        next: "http://fixture.invalid/page2", // must NOT be followed — the data itself says we're done
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchAllUpcomingPages("http://fixture.invalid/page1", WINDOW_END_MS, MAX_PAGES);
    expect(r.ok).toBe(true);
    expect(r.pages).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // page2 never fetched
  });

  it("follows `next` across multiple pages when every page stays within the window, until next is null", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [resultWithNet("2026-10-01T00:00:00Z")], next: "http://fixture.invalid/page2" }))
      .mockResolvedValueOnce(jsonResponse({ results: [resultWithNet("2026-10-02T00:00:00Z")], next: null }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchAllUpcomingPages("http://fixture.invalid/page1", WINDOW_END_MS, MAX_PAGES);
    expect(r.ok).toBe(true);
    expect(r.pages).toBe(2);
    expect(r.results).toHaveLength(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://fixture.invalid/page1", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://fixture.invalid/page2", expect.anything());
  });

  it("a page fetch failing (after its own retry) fails the whole pull — never a partial result", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchAllUpcomingPages("http://fixture.invalid/page1", WINDOW_END_MS, MAX_PAGES);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("fetch-failed");
  });

  it("hitting maxPages without ever reaching the window end or running out of `next` is a FAILURE, never a silently-truncated success", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        jsonResponse({
          results: [resultWithNet("2026-10-01T00:00:00Z")], // always well within the window
          next: `${url}+1`, // always claims there's more
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchAllUpcomingPages("http://fixture.invalid/page1", WINDOW_END_MS, 2);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("max-pages-exceeded");
    expect(r.pages).toBe(2);
  });
});

// --- End-to-end script behavior: runOnce() with a stubbed global.fetch ----
//
// scripts/rip_nwps.mjs's own test file only unit-tests exported helpers;
// launch_library.mjs's "exit non-zero, write nothing on failure" and "write
// a valid empty file on a genuinely-empty success" behaviors live in
// `runOnce`'s fetch/file-write plumbing. These call `runOnce` directly,
// in-process, with `global.fetch` stubbed (the same convention
// lib/sources/ripNwps.test.ts uses for its adapter) rather than spawning a
// real subprocess against a local fixture server — a spawned child process
// can't reach a same-process test server through this environment's
// per-process network sandboxing, so this is both faster and more reliable
// than a subprocess-based end-to-end test, while still exercising the real
// fetch-then-write code path (never the real, rate-limited LL2 API).
describe("runOnce — end-to-end (real fetch-then-write code path, exit-worthy outcomes)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function tmpOutPath(): string {
    return path.join(os.tmpdir(), `launch-library-test-${Math.random().toString(36).slice(2)}.json`);
  }
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  it("failed fetch (LL2 unreachable) — ok:false, writes NOTHING (§8)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const out = tmpOutPath();
    const result = await runOnce({ outPath: out, now: NOW, rangeLocationIds: RANGE_IDS, baseUrl: "http://fixture.invalid/" });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(out)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 + 1 retry, per the rip_nwps.mjs convention
  });

  it("a 5xx response — ok:false, writes NOTHING (§8)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    vi.stubGlobal("fetch", fetchMock);
    const out = tmpOutPath();
    const result = await runOnce({ outPath: out, now: NOW, rangeLocationIds: RANGE_IDS, baseUrl: "http://fixture.invalid/" });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("a successful fetch with zero qualifying launches writes a valid EMPTY payload (§8) — not a failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const out = tmpOutPath();
    try {
      const result = await runOnce({ outPath: out, now: NOW, rangeLocationIds: RANGE_IDS, baseUrl: "http://fixture.invalid/" });
      expect(result.ok).toBe(true);
      expect(fs.existsSync(out)).toBe(true);
      const payload = JSON.parse(fs.readFileSync(out, "utf8"));
      expect(payload.schemaVersion).toBe(1);
      expect(payload.launches).toEqual([]);
    } finally {
      fs.rmSync(out, { force: true });
    }
  });

  it("a successful fetch with one qualifying launch writes it to the file", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ results: [ll2Result()] }));
    vi.stubGlobal("fetch", fetchMock);
    const out = tmpOutPath();
    try {
      const result = await runOnce({ outPath: out, now: NOW, rangeLocationIds: RANGE_IDS, baseUrl: "http://fixture.invalid/" });
      expect(result.ok).toBe(true);
      const payload = JSON.parse(fs.readFileSync(out, "utf8"));
      expect(payload.launches).toHaveLength(1);
      expect(payload.launches[0].id).toBe("7d1afb26-6f9c-429b-9ccf-29012fd1e519");
    } finally {
      fs.rmSync(out, { force: true });
    }
  });
});
