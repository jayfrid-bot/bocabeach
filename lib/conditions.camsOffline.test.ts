// A cam that is down is left out of the conditions response (the page's cam grid,
// /api/conditions/<slug> and its lean copy all come from it), and hiding it changes
// no number on the page. Deerfield Beach's underwater cam is the real case: its
// uw-frame meta says ok:false since its stream went to a blank slate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache:
    (fn: (...a: unknown[]) => Promise<unknown>) =>
    (...args: unknown[]) =>
      fn(...args),
}));
vi.mock("@/lib/quality/overrides", () => ({
  loadSeaweedOverrides: async () => [],
  overridesFingerprint: async () => ({ version: "0", reliable: true }),
}));

import { SubrequestBudget, runWithBudget } from "@/lib/alerts/budget";
import { getConditionsForLocation } from "@/lib/conditions";
import { getLocation } from "@/config/locations";

const NOW = Date.parse("2026-11-06T17:00:00Z");
const originalFetch = globalThis.fetch;

/** Every uw-frame meta answers a fresh good frame, except the cams in `down`. */
function stubFetch(down: string[]) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("uw-frame") && url.includes("/meta?cam=")) {
      const id = new URL(url).searchParams.get("cam")!;
      const body = down.includes(id)
        ? { id, grabbedAtUtc: new Date(NOW - 600_000).toISOString(), ok: false, error: "blank frame" }
        : { id, grabbedAtUtc: new Date(NOW - 600_000).toISOString(), ok: true };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const build = (slug: string) =>
  runWithBudget(new SubrequestBudget(500), () => getConditionsForLocation(getLocation(slug)!));

describe("offline cams in the conditions response", () => {
  it("drops the offline cam, keeps the others with their credits, and leaves the score alone", async () => {
    stubFetch([]);
    const all = await build("deerfield-beach");
    stubFetch(["deerfield-spinner-uw"]);
    const some = await build("deerfield-beach");

    expect(all.cams.map((c) => c.id)).toContain("deerfield-spinner-uw");
    expect(some.cams.map((c) => c.id)).toEqual(all.cams.map((c) => c.id).filter((id) => id !== "deerfield-spinner-uw"));
    expect(some.cams.every((c) => typeof c.attribution === "string" && c.attribution.length > 0)).toBe(
      all.cams.every((c) => typeof c.attribution === "string" && c.attribution.length > 0),
    );
    expect(some.score).toEqual(all.score);
    expect(some.hourlyScores).toEqual(all.hourlyScores);
    expect(some.multiDayWindows).toEqual(all.multiDayWindows);

    // Nothing else in the response points at the hidden cam (the lean copy is built
    // from this same object and passes the cam list through as is).
    const wire = JSON.stringify(some);
    expect(wire).not.toContain("/api/cam/deerfield-spinner-uw");
    expect(wire).not.toContain("meta?cam=deerfield-spinner-uw");
  });

  it("a beach whose cams are all down sends no cams at all", async () => {
    const ids = getLocation("deerfield-beach")!.cams.map((c) => c.id!);
    stubFetch(ids);
    const res = await build("deerfield-beach");
    expect(res.cams).toEqual([]);
  });
});
