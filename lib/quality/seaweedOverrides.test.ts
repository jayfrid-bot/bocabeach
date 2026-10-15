import { afterEach, describe, expect, it, vi } from "vitest";
import vectors from "@/lib/quality/verdictVectors.json";
import {
  applySeaweedOverrides,
  effectiveOverrides,
  sameClaim,
  sameFrame,
  targetKey,
  type SeaweedOverride,
} from "@/lib/quality/seaweedOverrides";
import { fetchSargassum, summarizeSeaweed, type CamSeaweedFeed } from "@/lib/sources/sargassum";
import type { Location } from "@/lib/types";

const NOW = Date.parse("2026-10-13T18:00:00.000Z");
const SHA_A = "aaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbb";
const CREATED = "2026-10-13T17:40:00.000Z";
const UNTIL = "2026-10-14T04:00:00.000Z";
/** When the reader scored the held reading (the cam() helper's scoredAt): the claim time. */
const CLAIMED = "2026-10-13T17:30:00Z";

describe("the shared verdict vectors (scripts/quality_watch_test.py reads the same file)", () => {
  it("sameFrame", () => {
    for (const v of vectors.sameFrame) expect(sameFrame(v.a, v.b), v.name).toBe(v.same);
  });

  it("sameClaim", () => {
    for (const v of vectors.sameClaim) expect(sameClaim(v.a, v.b), v.name).toBe(v.same);
  });

  it("targetKey", () => {
    for (const v of vectors.targetKey) expect(targetKey(v.o), JSON.stringify(v.o)).toBe(v.key);
  });

  it("effectiveOverrides: the latest verdict per exact target wins, as one merged stream ordered by (created time, id)", () => {
    for (const v of vectors.effective) {
      const ids = effectiveOverrides(v.overrides as SeaweedOverride[], Date.parse(v.now)).map((o) => o.id);
      expect(ids, v.name).toEqual(v.ids);
    }
    const names = vectors.effective.map((v) => v.name).join(" | ");
    expect(names).toContain("Wrong, Right, Wrong");
    expect(names).toContain("Right, Wrong, Right");
  });
});

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

const heldInlet = (sha = SHA_A, frameAt = "2026-10-13T17:25:00Z") =>
  cam("boca-inlet-surf", null, { unconfirmed: true, claim: { level: "moderate", coveragePct: 35, note: "rock?" }, frameSha: sha, frameAt });

function heldFeed(sha = SHA_A): CamSeaweedFeed {
  const group = (at: string) => ({ capturedAtLocal: at, cams: [heldInlet(sha), cam("boca-south", "none")] });
  return {
    generatedAt: "2026-10-13T17:31:00Z",
    morning: group("2026-10-13T09:00-04:00"),
    latest: group("2026-10-13T13:30-04:00"),
    lastSeaweed: group("2026-10-13T13:30-04:00"),
    pendingClaims: {
      "boca-inlet-surf": { level: "moderate", claimedAt: "2026-10-13T17:30:00Z", frameSha: sha, frameAt: "2026-10-13T17:25:00Z" },
      "boca-south": { level: "moderate", claimedAt: "2026-10-13T17:30:00Z", frameSha: SHA_B, confirmed: true },
    },
  } as unknown as CamSeaweedFeed;
}

const publish = (over: Partial<SeaweedOverride> = {}): SeaweedOverride => ({
  id: 1, camId: "boca-inlet-surf", verdict: "right", action: "publish", level: "moderate", coveragePct: 35, note: "weed line",
  frameSha: SHA_A, frameAt: null, claimedAt: CLAIMED, createdAtUtc: CREATED, untilUtc: UNTIL, ...over,
});
const reject = (over: Partial<SeaweedOverride> = {}): SeaweedOverride => ({
  id: 2, camId: "boca-inlet-surf", verdict: "wrong", action: "reject", level: null, frameSha: SHA_A, frameAt: null,
  claimedAt: CLAIMED, createdAtUtc: CREATED, untilUtc: UNTIL, ...over,
});
const inlet = (g: { cams?: unknown[] } | null | undefined) => (g!.cams![0] as Record<string, unknown>);

describe("applySeaweedOverrides: publish", () => {
  it("publishes exactly that frame's held claim, at the verdict's level, marked the owner's", () => {
    const out = applySeaweedOverrides(heldFeed(), [publish()], NOW);
    for (const g of [out.latest, out.lastSeaweed, out.morning]) {
      expect(inlet(g)).toMatchObject({ level: "moderate", coveragePct: 35, note: "weed line", confirmedBy: "owner" });
      expect(inlet(g).unconfirmed).toBeUndefined();
      expect(inlet(g).claim).toBeUndefined();
      expect(g!.cams![1]).toMatchObject({ level: "none" });
    }
  });

  it("makes that frame's pending claim a confirmed one, so nothing is waiting any more", () => {
    const out = applySeaweedOverrides(heldFeed(), [publish()], NOW);
    expect(out.pendingClaims!["boca-inlet-surf"]).toMatchObject({ confirmed: true, confirmedBy: "owner" });
    expect((out.pendingClaims!["boca-south"] as { confirmedBy?: string }).confirmedBy).toBeUndefined(); // untouched
    const opts = { now: new Date(NOW), timezone: "America/New_York" };
    expect(summarizeSeaweed(heldFeed(), "2026-10-13", opts)?.pendingConfirmation).toBe(true);
    const after = summarizeSeaweed(out, "2026-10-13", opts);
    expect(after?.level).toBe("moderate");
    expect(after?.pendingConfirmation).toBeUndefined();
  });

  it("a corrected level (Wrong, but really high) publishes at that level", () => {
    const out = applySeaweedOverrides(heldFeed(), [publish({ verdict: "wrong", level: "high", coveragePct: null, note: null })], NOW);
    expect(inlet(out.latest)).toMatchObject({ level: "high", confirmedBy: "owner" });
  });

  it("falls back to the reading's own claim for coverage and note when the verdict has none", () => {
    const out = applySeaweedOverrides(heldFeed(), [publish({ coveragePct: null, note: null })], NOW);
    expect(inlet(out.latest)).toMatchObject({ level: "moderate", coveragePct: 35, note: "rock?" });
  });

  it("a verdict about frame A never touches a newer held frame B of the same cam", () => {
    const out = applySeaweedOverrides(heldFeed(SHA_B), [publish({ frameSha: SHA_A })], NOW);
    expect(inlet(out.latest).unconfirmed).toBe(true);
    expect(out.pendingClaims!["boca-inlet-surf"].confirmed).toBeUndefined();
  });

  it("a verdict about a courier frame is matched by the frame's time", () => {
    const f = heldFeed();
    for (const g of [f.latest, f.lastSeaweed, f.morning]) delete (g!.cams![0] as { frameSha?: string }).frameSha;
    delete (f.pendingClaims!["boca-inlet-surf"] as { frameSha?: string }).frameSha;
    const out = applySeaweedOverrides(f, [publish({ frameSha: null, frameAt: "2026-10-13T17:25:00Z" })], NOW);
    expect(inlet(out.latest).confirmedBy).toBe("owner");
    const other = applySeaweedOverrides(f, [publish({ frameSha: null, frameAt: "2026-10-13T17:26:00Z" })], NOW);
    expect(inlet(other.latest).unconfirmed).toBe(true);
  });

  it("a verdict for another cam, one that has ended, and one with no frame identity do nothing", () => {
    const f = heldFeed();
    expect(applySeaweedOverrides(f, [publish({ camId: "boca-south" })], NOW).latest!.cams![0]).toMatchObject({ unconfirmed: true });
    expect(applySeaweedOverrides(f, [publish({ untilUtc: "2026-10-13T17:00:00.000Z" })], NOW)).toBe(f);
    expect(applySeaweedOverrides(f, [publish({ frameSha: null, frameAt: null })], NOW)).toBe(f);
    expect(applySeaweedOverrides(f, [publish({ claimedAt: null })], NOW)).toBe(f);
  });

  it("the same image scored at another time is a different claim: the verdict does not touch it", () => {
    const f = heldFeed();
    const late = { claimedAt: "2026-10-13T17:40:00Z" };
    const out = applySeaweedOverrides(f, [publish(late), reject({ ...late, id: 5 })], NOW);
    expect(inlet(out.latest).unconfirmed).toBe(true);
    expect(out.pendingClaims!["boca-inlet-surf"]).toBeDefined();
    expect(out.pendingClaims!["boca-inlet-surf"].confirmed).toBeUndefined();
  });

  it("leaves a reading that is not held alone", () => {
    const f = heldFeed();
    f.latest!.cams![0] = cam("boca-inlet-surf", "none", { frameSha: SHA_A }) as never;
    expect(applySeaweedOverrides(f, [publish()], NOW).latest!.cams![0].level).toBe("none");
  });
});

describe("applySeaweedOverrides: reject", () => {
  it("clears that frame's held reading and removes its pending claim; publishes nothing for it", () => {
    const out = applySeaweedOverrides(heldFeed(), [reject()], NOW);
    for (const g of [out.latest, out.lastSeaweed, out.morning]) {
      expect(inlet(g).level).toBe("unknown");
      expect(inlet(g).unconfirmed).toBeUndefined();
      expect(inlet(g).claim).toBeUndefined();
      expect(g!.cams![1]).toMatchObject({ level: "none" });
    }
    expect(Object.keys(out.pendingClaims!)).toEqual(["boca-south"]);
    const summary = summarizeSeaweed(out, "2026-10-13", { now: new Date(NOW), timezone: "America/New_York" });
    expect(summary?.level).toBe("none");
    expect(summary?.pendingConfirmation).toBeUndefined();
  });

  it("a reject for frame A leaves a different held frame B and its claim alone", () => {
    const out = applySeaweedOverrides(heldFeed(SHA_B), [reject({ frameSha: SHA_A })], NOW);
    expect(inlet(out.latest).unconfirmed).toBe(true);
    expect(out.pendingClaims!["boca-inlet-surf"]).toBeDefined();
  });

  it("does not change the feed it was given", () => {
    const f = heldFeed();
    const before = JSON.stringify(f);
    applySeaweedOverrides(f, [reject(), publish({ camId: "boca-south", frameSha: SHA_B })], NOW);
    expect(JSON.stringify(f)).toBe(before);
  });
});

describe("applySeaweedOverrides: supersession", () => {
  it("a later Wrong on the same frame replaces an earlier Right, and a later Right replaces a Wrong, in either input order", () => {
    const right = publish({ id: 1, createdAtUtc: "2026-10-13T17:31:00.000Z" });
    const wrong = reject({ id: 2, createdAtUtc: "2026-10-13T17:50:00.000Z" });
    for (const list of [[right, wrong], [wrong, right]]) expect(inlet(applySeaweedOverrides(heldFeed(), list, NOW).latest).level).toBe("unknown");
    const wrongFirst = reject({ id: 3, createdAtUtc: "2026-10-13T17:31:00.000Z" });
    const rightLater = publish({ id: 4, createdAtUtc: "2026-10-13T17:50:00.000Z" });
    for (const list of [[wrongFirst, rightLater], [rightLater, wrongFirst]]) {
      expect(inlet(applySeaweedOverrides(heldFeed(), list, NOW).latest).confirmedBy).toBe("owner");
    }
  });

  it("Wrong, Right, Wrong and Right, Wrong, Right on three frames replay as one stream in time order", () => {
    // Three frames of one cam, three verdicts. The held frame is A (the first); the others are other frames.
    const at = (m: number) => `2026-10-13T17:${String(m).padStart(2, "0")}:00.000Z`;
    const wrw = [reject({ id: 1, createdAtUtc: at(30) }), publish({ id: 2, frameSha: SHA_B, createdAtUtc: at(35) }), reject({ id: 3, frameSha: "c".repeat(20), createdAtUtc: at(40) })];
    expect(effectiveOverrides(wrw, NOW).map((o) => [o.id, o.action])).toEqual([[1, "reject"], [2, "publish"], [3, "reject"]]);
    expect(effectiveOverrides([...wrw].reverse(), NOW).map((o) => o.id)).toEqual([1, 2, 3]);
    const out = applySeaweedOverrides(heldFeed(), wrw, NOW);
    expect(inlet(out.latest).level).toBe("unknown"); // frame A was rejected; B and C are other frames
    const rwr = [publish({ id: 1, createdAtUtc: at(30) }), reject({ id: 2, frameSha: SHA_B, createdAtUtc: at(35) }), publish({ id: 3, frameSha: "c".repeat(20), createdAtUtc: at(40) })];
    expect(inlet(applySeaweedOverrides(heldFeed(), rwr, NOW).latest).confirmedBy).toBe("owner");
  });

  it("verdicts on two different frames of one cam are independent", () => {
    const f = heldFeed();
    const out = applySeaweedOverrides(f, [reject({ frameSha: SHA_B }), publish({ frameSha: SHA_A })], NOW);
    expect(inlet(out.latest).confirmedBy).toBe("owner");
  });

  it("copes with a feed that has no groups or no claims", () => {
    expect(applySeaweedOverrides({} as CamSeaweedFeed, [publish(), reject({ frameSha: SHA_B })], NOW)).toMatchObject({ morning: undefined });
    expect(applySeaweedOverrides({ latest: { cams: [] } } as CamSeaweedFeed, [publish()], NOW).latest).toEqual({ cams: [] });
  });
});

describe("fetchSargassum with an override loader", () => {
  afterEach(() => vi.restoreAllMocks());

  const BOCA = {
    slug: "boca-raton", name: "Boca Raton", region: "FL", tier: "curated", lat: 26.35, lon: -80.07, timezone: "America/New_York",
    noaaTideStationId: "x", ndbcBuoyId: "x", cams: [{ id: "c", name: "c", provider: "p", embedType: "image" as const, url: "https://example.com" }],
  } as Location;

  function stubFeed(): string {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: BOCA.timezone }).format(new Date());
    const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const group = { capturedAtLocal: `${today}T12:00-04:00`, cams: [heldInlet(SHA_A, nowIso), cam("boca-south", "none", { scoredAt: nowIso })] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ generatedAt: nowIso, latest: { ...group, cams: group.cams.map((c) => ({ ...c, scoredAt: nowIso })) } }), { status: 200 })));
    return nowIso;
  }

  it("applies the loaded verdicts to the feed it just fetched", async () => {
    // stubFeed scores the held reading "now", to the second: that is the claim time the verdict names.
    const claimedAt = stubFeed();
    const loader = vi.fn(async () => [
      publish({ claimedAt, frameAt: claimedAt, frameSha: SHA_A, createdAtUtc: new Date().toISOString(), untilUtc: new Date(Date.now() + 3_600_000).toISOString() }),
    ]);
    const w = await fetchSargassum(BOCA, loader);
    expect(loader).toHaveBeenCalledWith("boca-raton");
    expect(w.data?.level).toBe("moderate");
  });

  it("without a loader the feed is used as published (the held claim shows nothing)", async () => {
    stubFeed();
    expect((await fetchSargassum(BOCA)).data?.level).toBe("none");
  });
});
