import { afterEach, describe, expect, it, vi } from "vitest";
import { applySeaweedOverrides, liveOverrides, type SeaweedOverride } from "@/lib/quality/seaweedOverrides";
import { fetchSargassum, summarizeSeaweed, type CamSeaweedFeed } from "@/lib/sources/sargassum";
import { camFeedUrl } from "@/lib/sources/camFeed";
import type { Location } from "@/lib/types";

const NOW = Date.parse("2026-10-13T18:00:00.000Z");
const T = (iso: string) => iso;

const OVERRIDE: SeaweedOverride = {
  camId: "boca-inlet-surf",
  createdAtUtc: "2026-10-13T17:40:00.000Z",
  untilUtc: "2026-10-14T04:00:00.000Z",
};

const cam = (id: string, level: string | null, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  level,
  coveragePct: level === "moderate" ? 35 : 0,
  note: "n",
  crowd: "quiet",
  scoredAt: "2026-10-13T17:30:00Z",
  ...over,
});

function feed(): CamSeaweedFeed {
  const group = (capturedAtLocal: string) => ({
    capturedAtLocal,
    cams: [cam("boca-inlet-surf", "moderate"), cam("boca-south", "none")],
  });
  return {
    generatedAt: "2026-10-13T17:31:00Z",
    morning: group("2026-10-13T09:00-04:00"),
    latest: group("2026-10-13T13:30-04:00"),
    lastSeaweed: group("2026-10-13T13:30-04:00"),
    pendingClaims: {
      "boca-inlet-surf": { level: "moderate", claimedAt: "2026-10-13T17:30:00Z" },
      "boca-south": { level: "moderate", claimedAt: "2026-10-13T17:30:00Z" },
    },
  } as unknown as CamSeaweedFeed;
}

describe("liveOverrides", () => {
  it("keeps the ones that have not ended and drops the malformed", () => {
    const ended = { ...OVERRIDE, untilUtc: "2026-10-13T17:59:59.000Z" };
    const bad = { ...OVERRIDE, untilUtc: "never" };
    expect(liveOverrides([OVERRIDE, ended, bad], NOW)).toEqual([OVERRIDE]);
  });
});

describe("applySeaweedOverrides", () => {
  it("returns the same feed when there is nothing to apply", () => {
    const f = feed();
    expect(applySeaweedOverrides(f, [], NOW)).toBe(f);
    expect(applySeaweedOverrides(f, [{ ...OVERRIDE, untilUtc: "2026-10-13T17:00:00.000Z" }], NOW)).toBe(f);
  });

  it("drops that cam's seaweed from every group and leaves the other cams, water and crowd alone", () => {
    const out = applySeaweedOverrides(feed(), [OVERRIDE], NOW);
    for (const g of [out.morning, out.latest, out.lastSeaweed]) {
      const inlet = g!.cams!.find((c) => (c as { id?: string }).id === "boca-inlet-surf")!;
      expect(inlet.level).toBe("unknown");
      expect(inlet.coveragePct).toBeUndefined();
      expect(inlet.note).toBeUndefined();
      expect(inlet.crowd).toBe("quiet");
      expect(g!.cams!.find((c) => (c as { id?: string }).id === "boca-south")).toMatchObject({ level: "none", note: "n" });
    }
  });

  it("does not change the feed it was given", () => {
    const f = feed();
    const before = JSON.stringify(f);
    applySeaweedOverrides(f, [OVERRIDE], NOW);
    expect(JSON.stringify(f)).toBe(before);
  });

  it("a NEWER fresh reading from that cam is left alone", () => {
    const f = feed();
    f.latest!.cams![0] = cam("boca-inlet-surf", "moderate", { scoredAt: "2026-10-13T17:50:00Z" }) as never;
    const out = applySeaweedOverrides(f, [OVERRIDE], NOW);
    expect(out.latest!.cams![0].level).toBe("moderate");
    expect(out.morning!.cams![0].level).toBe("unknown"); // the older morning read is still dropped
  });

  it("a reading scored exactly when the override began is dropped; a carried older copy too", () => {
    const f = feed();
    f.latest!.cams![0] = cam("boca-inlet-surf", "high", { scoredAt: OVERRIDE.createdAtUtc, carried: true }) as never;
    expect(applySeaweedOverrides(f, [OVERRIDE], NOW).latest!.cams![0].level).toBe("unknown");
  });

  it("a reading with no scoring time counts as older", () => {
    const f = feed();
    delete (f.latest!.cams![0] as { scoredAt?: string }).scoredAt;
    expect(applySeaweedOverrides(f, [OVERRIDE], NOW).latest!.cams![0].level).toBe("unknown");
  });

  it("clears a held jump's marks on that cam", () => {
    const f = feed();
    f.latest!.cams![0] = cam("boca-inlet-surf", null, { unconfirmed: true, claim: { level: "moderate" } }) as never;
    const inlet = applySeaweedOverrides(f, [OVERRIDE], NOW).latest!.cams![0];
    expect(inlet.unconfirmed).toBeUndefined();
  });

  it("drops that cam's pending claim only if it is not newer than the override", () => {
    const out = applySeaweedOverrides(feed(), [OVERRIDE], NOW);
    expect(Object.keys(out.pendingClaims!)).toEqual(["boca-south"]);
    const f = feed();
    f.pendingClaims!["boca-inlet-surf"].claimedAt = T("2026-10-13T17:55:00Z");
    expect(Object.keys(applySeaweedOverrides(f, [OVERRIDE], NOW).pendingClaims!).sort()).toEqual(["boca-inlet-surf", "boca-south"]);
  });

  it("copes with a feed that has no groups or no claims", () => {
    expect(applySeaweedOverrides({} as CamSeaweedFeed, [OVERRIDE], NOW)).toMatchObject({ morning: undefined, latest: undefined });
    expect(applySeaweedOverrides({ latest: { cams: [] } } as CamSeaweedFeed, [OVERRIDE], NOW).latest).toEqual({ cams: [] });
  });
});

describe("applySeaweedOverrides: a Right verdict", () => {
  const RIGHT: SeaweedOverride = { ...OVERRIDE, verdict: "right", claim: { level: "moderate", coveragePct: 35, note: "weed line" } };

  function heldFeed(): CamSeaweedFeed {
    const held = cam("boca-inlet-surf", null, { unconfirmed: true, claim: { level: "moderate", coveragePct: 35, note: "rock?" } });
    const group = (at: string) => ({ capturedAtLocal: at, cams: [{ ...held }, cam("boca-south", "none")] });
    return {
      generatedAt: "2026-10-13T17:31:00Z",
      latest: group("2026-10-13T13:30-04:00"),
      lastSeaweed: group("2026-10-13T13:30-04:00"),
      pendingClaims: { "boca-inlet-surf": { level: "moderate", claimedAt: "2026-10-13T17:30:00Z" } },
    } as unknown as CamSeaweedFeed;
  }

  it("publishes the judged claim for the held reading, marked as the owner's", () => {
    const out = applySeaweedOverrides(heldFeed(), [RIGHT], NOW);
    for (const g of [out.latest, out.lastSeaweed]) {
      const inlet = g!.cams![0] as unknown as Record<string, unknown>;
      expect(inlet).toMatchObject({ level: "moderate", coveragePct: 35, note: "weed line", confirmedBy: "owner" });
      expect(inlet.unconfirmed).toBeUndefined();
      expect(inlet.claim).toBeUndefined();
      expect(g!.cams![1]).toMatchObject({ level: "none" });
    }
  });

  it("turns the held claim into a confirmed one, so nothing is waiting any more", () => {
    const out = applySeaweedOverrides(heldFeed(), [RIGHT], NOW);
    expect(out.pendingClaims!["boca-inlet-surf"]).toMatchObject({ confirmed: true, confirmedBy: "owner" });
    const now = new Date(NOW);
    const before = summarizeSeaweed(heldFeed(), "2026-10-13", { now, timezone: "America/New_York" });
    expect(before?.pendingConfirmation).toBe(true);
    const after = summarizeSeaweed(out, "2026-10-13", { now, timezone: "America/New_York" });
    expect(after?.level).toBe("moderate");
    expect(after?.pendingConfirmation).toBeUndefined();
  });

  it("falls back to the reading's own claim when the override carries none", () => {
    const out = applySeaweedOverrides(heldFeed(), [{ ...RIGHT, claim: null }], NOW);
    expect(out.latest!.cams![0]).toMatchObject({ level: "moderate", coveragePct: 35, note: "rock?" });
  });

  it("leaves alone a reading that is not held, a newer held reading, and other cams", () => {
    const f = heldFeed();
    f.latest!.cams![0] = cam("boca-inlet-surf", "none") as never;
    expect(applySeaweedOverrides(f, [RIGHT], NOW).latest!.cams![0].level).toBe("none");
    const newer = heldFeed();
    (newer.latest!.cams![0] as { scoredAt?: string }).scoredAt = "2026-10-13T17:50:00Z";
    newer.pendingClaims!["boca-inlet-surf"].claimedAt = "2026-10-13T17:50:00Z";
    const out = applySeaweedOverrides(newer, [RIGHT], NOW);
    expect(out.latest!.cams![0].unconfirmed).toBe(true);
    expect(out.pendingClaims!["boca-inlet-surf"].confirmed).toBeUndefined();
    expect(applySeaweedOverrides(heldFeed(), [{ ...RIGHT, camId: "boca-south" }], NOW).latest!.cams![0].unconfirmed).toBe(true);
  });

  it("an ended Right does nothing, and does not change the feed it was given", () => {
    const f = heldFeed();
    expect(applySeaweedOverrides(f, [{ ...RIGHT, untilUtc: "2026-10-13T17:00:00.000Z" }], NOW)).toBe(f);
    const before = JSON.stringify(f);
    applySeaweedOverrides(f, [RIGHT], NOW);
    expect(JSON.stringify(f)).toBe(before);
  });

  it("a later verdict on the same cam wins", () => {
    const wrongLater: SeaweedOverride = { ...OVERRIDE, createdAtUtc: "2026-10-13T17:45:00.000Z" };
    const out = applySeaweedOverrides(heldFeed(), [wrongLater, RIGHT], NOW);
    // Right is applied first (older), publishing; the later Wrong then drops that cam's reading.
    expect(out.latest!.cams![0].level).toBe("unknown");
  });
});

describe("the summary honors an override", () => {
  const today = "2026-10-13";

  it("without it the confirmed cam sets the beach to moderate; with it the other cams stand", () => {
    expect(summarizeSeaweed(feed(), today)?.level).toBe("moderate");
    const out = summarizeSeaweed(applySeaweedOverrides(feed(), [OVERRIDE], NOW), today);
    expect(out?.level).toBe("none");
    expect(out?.cams.map((c) => c.name)).toEqual(["boca-south"]);
  });

  it("an open (held) claim stops counting as an open question", () => {
    const held = feed();
    held.latest!.cams![0] = cam("boca-inlet-surf", null, { unconfirmed: true, claim: { level: "moderate" } }) as never;
    held.pendingClaims = { "boca-inlet-surf": { level: "moderate", claimedAt: "2026-10-13T17:30:00Z" } };
    const now = new Date(NOW);
    expect(summarizeSeaweed(held, today, { now, timezone: "America/New_York" })?.pendingConfirmation).toBe(true);
    const cleared = summarizeSeaweed(applySeaweedOverrides(held, [OVERRIDE], NOW), today, { now, timezone: "America/New_York" });
    expect(cleared?.pendingConfirmation).toBeUndefined();
  });

  it("when every cam is overridden there is no reading, not a stale one", () => {
    const both = [OVERRIDE, { ...OVERRIDE, camId: "boca-south" }];
    const out = summarizeSeaweed(applySeaweedOverrides(feed(), both, NOW), today);
    expect(out === null || out.level === "unknown").toBe(true);
  });
});

describe("fetchSargassum with an override loader", () => {
  afterEach(() => vi.restoreAllMocks());

  const BOCA: Location = {
    slug: "boca-raton",
    name: "Boca Raton",
    region: "FL",
    tier: "curated",
    lat: 26.35,
    lon: -80.07,
    timezone: "America/New_York",
    noaaTideStationId: "x",
    ndbcBuoyId: "x",
    cams: [{ id: "c", name: "c", provider: "p", embedType: "image" as const, url: "https://example.com" }],
  } as Location;

  function stubFeed(): void {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: BOCA.timezone }).format(new Date());
    const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const group = {
      capturedAtLocal: `${today}T12:00-04:00`,
      cams: [cam("boca-inlet-surf", "moderate", { scoredAt: nowIso }), cam("boca-south", "none", { scoredAt: nowIso })],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ generatedAt: nowIso, latest: group }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  }

  it("applies the loaded overrides to the feed it just fetched", async () => {
    stubFeed();
    const loader = vi.fn(async () => [{ camId: "boca-inlet-surf", createdAtUtc: new Date(Date.now() + 60_000).toISOString(), untilUtc: new Date(Date.now() + 3_600_000).toISOString() }]);
    const w = await fetchSargassum(BOCA, loader);
    expect(loader).toHaveBeenCalledWith("boca-raton");
    expect(w.data?.level).toBe("none");
  });

  it("without a loader the feed is used as published", async () => {
    stubFeed();
    expect((await fetchSargassum(BOCA)).data?.level).toBe("moderate");
    expect(camFeedUrl("boca-raton")).toContain("boca-raton");
  });
});
