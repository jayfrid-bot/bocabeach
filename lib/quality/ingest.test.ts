import { describe, expect, it } from "vitest";
import { parseSeaweedAlert } from "@/lib/quality/ingest";

const NOW = Date.parse("2026-10-13T17:30:00.000Z");
const SHA = "ab".repeat(32);

const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: "boca-raton",
  camId: "boca-inlet-surf",
  camName: "Boca Inlet Surf Cam",
  observedAt: "2026-10-13T17:20:00Z",
  published: { level: "none", pct: 0 },
  claim: { level: "moderate", coveragePct: 35, note: "brown rock shelf", provider: "gemini", model: "gemini-2.5-flash" },
  secondOpinion: { provider: "clef", model: "@cf/cloudflare/clef", level: "none", coveragePct: 0, note: null },
  others: [{ id: "boca-south", name: "Boca South", level: "none", coveragePct: 0, carried: false }],
  claimTarget: { frameSha: SHA, frameAt: "2026-10-13T17:20:00Z", claimedAt: "2026-10-13T17:21:00Z" },
  frame: { sha256: SHA, archivedThisTick: true },
  ...over,
});

describe("parseSeaweedAlert", () => {
  it("accepts what the reader sends and builds the stored payload", () => {
    const r = parseSeaweedAlert(body(), NOW);
    expect(r).toEqual({
      ok: true,
      value: {
        slug: "boca-raton",
        dedupeKey: `seaweed:boca-raton:boca-inlet-surf:${SHA.slice(0, 16)}:2026-10-13T17:21:00.000Z`,
        frameJpeg: null,
        payload: {
          camId: "boca-inlet-surf",
          camName: "Boca Inlet Surf Cam",
          observedAt: "2026-10-13T17:20:00.000Z",
          published: { level: "none", pct: 0 },
          claim: { level: "moderate", coveragePct: 35, note: "brown rock shelf", provider: "gemini", model: "gemini-2.5-flash" },
          secondOpinion: { provider: "clef", model: "@cf/cloudflare/clef", level: "none", coveragePct: 0, note: null },
          others: [{ id: "boca-south", name: "Boca South", level: "none", coveragePct: 0, carried: false }],
          claimTarget: { frameSha: SHA.slice(0, 20), frameAt: "2026-10-13T17:20:00Z", claimedAt: "2026-10-13T17:21:00Z" },
          localDate: "2026-10-13",
          frame: { sha256: SHA, archivedThisTick: true, r2Key: null },
        },
      },
    });
  });

  it("keys the alert by frame time when there is no hash", () => {
    const r = parseSeaweedAlert(
      body({ frame: { sha256: null, archivedThisTick: false }, claimTarget: { frameSha: null, frameAt: "2026-10-13T17:20:00Z", claimedAt: "2026-10-13T17:21:00Z" } }),
      NOW,
    );
    expect(r.ok && r.value.dedupeKey).toBe("seaweed:boca-raton:boca-inlet-surf:2026-10-13T17:20:00.000Z:2026-10-13T17:21:00.000Z");
  });

  it("the key names the exact claim: the same image scored again is a different alert, the same claim written another way is not", () => {
    const at = (claimedAt: string) => parseSeaweedAlert(body({ claimTarget: { frameSha: SHA, frameAt: "2026-10-13T17:20:00Z", claimedAt } }), NOW);
    const key = (r: ReturnType<typeof at>) => (r.ok ? r.value.dedupeKey : r.error);
    expect(key(at("2026-10-13T17:21:00Z"))).not.toBe(key(at("2026-10-13T17:26:00Z")));
    expect(key(at("2026-10-13T17:21:00Z"))).toBe(key(at("2026-10-13T13:21:00-04:00")));
    expect(key(at("2026-10-13T17:21:00Z"))).toBe(key(at("2026-10-13T17:21:00.000Z")));
  });

  it("refuses an unknown beach, a bad cam id and a bad time", () => {
    expect(parseSeaweedAlert(body({ slug: "atlantis" }), NOW)).toEqual({ ok: false, error: "unknown-beach" });
    expect(parseSeaweedAlert(body({ camId: "Bad Cam!" }), NOW)).toEqual({ ok: false, error: "bad-cam" });
    expect(parseSeaweedAlert(body({ observedAt: "yesterday" }), NOW)).toEqual({ ok: false, error: "bad-time" });
    expect(parseSeaweedAlert(body({ observedAt: "2026-10-13T20:00:00Z" }), NOW)).toEqual({ ok: false, error: "bad-time" }); // future
    expect(parseSeaweedAlert(body({ observedAt: "2026-10-13T03:00:00Z" }), NOW)).toEqual({ ok: false, error: "bad-time" }); // 14 h old
  });

  it("only records a claim of moderate or high seaweed", () => {
    for (const level of ["none", "low", "unknown", 3, null]) {
      expect(parseSeaweedAlert(body({ claim: { level } }), NOW)).toEqual({ ok: false, error: "bad-claim" });
    }
    expect(parseSeaweedAlert(body({ claim: undefined }), NOW)).toEqual({ ok: false, error: "bad-claim" });
    expect(parseSeaweedAlert(body({ claim: { level: "high" } }), NOW).ok).toBe(true);
  });

  it("only records a DISAGREEMENT", () => {
    expect(parseSeaweedAlert(body({ secondOpinion: { provider: "clef", level: "moderate" } }), NOW)).toEqual({ ok: false, error: "not-a-disagreement" });
    expect(parseSeaweedAlert(body({ secondOpinion: { provider: "clef", level: "high" } }), NOW)).toEqual({ ok: false, error: "not-a-disagreement" });
    expect(parseSeaweedAlert(body({ secondOpinion: { provider: "clef", level: "low" } }), NOW).ok).toBe(true);
    expect(parseSeaweedAlert(body({ secondOpinion: { provider: "clef", level: null } }), NOW).ok).toBe(true);
    expect(parseSeaweedAlert(body({ secondOpinion: {} }), NOW)).toEqual({ ok: false, error: "bad-second-opinion" });
    expect(parseSeaweedAlert(body({ secondOpinion: "none" }), NOW)).toEqual({ ok: false, error: "bad-second-opinion" });
  });

  it("drops a malformed other cam, caps the list, and cuts long strings", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `cam-${i}`, name: "x", level: "none" }));
    const r = parseSeaweedAlert(
      body({ others: [{ id: "ok", level: "none" }, { id: "bad", level: "enormous" }, "junk", ...many], claim: { level: "moderate", note: "n".repeat(500) } }),
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.payload.others).toHaveLength(8);
      expect(r.value.payload.others[0]).toMatchObject({ id: "ok", name: "ok", coveragePct: null, carried: false });
      expect(r.value.payload.claim.note).toHaveLength(200);
    }
  });

  it("ignores a malformed hash and out-of-range percentages", () => {
    const r = parseSeaweedAlert(
      body({
        frame: { sha256: "xyz", archivedThisTick: "yes" },
        claimTarget: { frameSha: null, frameAt: "2026-10-13T17:20:00Z", claimedAt: "2026-10-13T17:21:00Z" },
        claim: { level: "moderate", coveragePct: 400 },
      }),
      NOW,
    );
    expect(r.ok && r.value.payload.frame).toEqual({ sha256: null, archivedThisTick: false, r2Key: null });
    expect(r.ok && r.value.payload.claim.coveragePct).toBeNull();
  });

  it("passes along a good shrunk frame and drops a bad one without refusing the alert", () => {
    const jpeg = new Uint8Array(2000);
    jpeg.set([0xff, 0xd8, 0xff]);
    const good = btoa(String.fromCharCode(...jpeg));
    const ok = parseSeaweedAlert(body({ frame: { sha256: SHA, archivedThisTick: true, jpegB64: good } }), NOW);
    expect(ok.ok && ok.value.frameJpeg?.length).toBe(2000);
    for (const bad of ["not base64!!", btoa("tiny"), 12, "", btoa("x".repeat(3000))]) {
      const r = parseSeaweedAlert(body({ frame: { sha256: SHA, archivedThisTick: true, jpegB64: bad } }), NOW);
      expect(r.ok && r.value.frameJpeg).toBeNull();
    }
  });

  it("keeps the exact claim identity: frame hash (first 20), frame time and claim time, exactly as written", () => {
    // an upper-case hash is not a hash we wrote: it is dropped, and the time identifies the claim
    const upper = parseSeaweedAlert(
      body({ claimTarget: { frameSha: "ABCDEF0123456789abcdef0123456789", frameAt: "2026-10-13T17:20:00Z", claimedAt: "2026-10-13T17:21:00Z" } }),
      NOW,
    );
    expect(upper.ok && upper.value.payload.claimTarget).toEqual({ frameSha: null, frameAt: "2026-10-13T17:20:00Z", claimedAt: "2026-10-13T17:21:00Z" });
    // a courier cam has no hash: its time is its identity (the alert's own time is the frame's)
    const courier = parseSeaweedAlert(
      body({ frame: { sha256: null }, claimTarget: { frameSha: null, frameAt: "2026-10-13T17:20:00Z", claimedAt: "2026-10-13T17:21:00Z" } }),
      NOW,
    );
    expect(courier.ok && courier.value.payload.claimTarget).toEqual({ frameSha: null, frameAt: "2026-10-13T17:20:00Z", claimedAt: "2026-10-13T17:21:00Z" });
  });

  it("refuses a claim that cannot name one exact claim", () => {
    const refuse = (claimTarget: unknown, error: string, extra: Record<string, unknown> = {}) =>
      expect(parseSeaweedAlert(body({ claimTarget, ...extra }), NOW), error).toEqual({ ok: false, error });
    refuse(undefined, "bad-claim-time");
    refuse({ frameSha: SHA, frameAt: "2026-10-13T17:20:00Z" }, "bad-claim-time"); // no claimedAt
    refuse({ frameSha: SHA, frameAt: "2026-10-13T17:20:00Z", claimedAt: "not a time" }, "bad-claim-time");
    refuse({ frameSha: SHA, frameAt: "2026-10-13T17:20:00Z", claimedAt: "2026-10-13T19:00:00Z" }, "bad-claim-time"); // future
    refuse({ frameSha: SHA, frameAt: "2026-10-13T17:20:00Z", claimedAt: "2026-10-13T03:00:00Z" }, "bad-claim-time"); // 14 h old
    refuse({ frameSha: SHA, frameAt: "2026-10-13T17:50:00Z", claimedAt: "2026-10-13T17:21:00Z" }, "claim-frame-mismatch"); // not the alert's frame time
    refuse({ frameSha: null, frameAt: null, claimedAt: "2026-10-13T17:21:00Z" }, "unbound-claim");
    refuse({ frameSha: 7, frameAt: "not a time", claimedAt: "2026-10-13T17:21:00Z" }, "unbound-claim");
  });

  it("checks the frame hash against the image that came with the alert", () => {
    const other = "cd".repeat(32);
    const t = { frameAt: "2026-10-13T17:20:00Z", claimedAt: "2026-10-13T17:21:00Z" };
    expect(parseSeaweedAlert(body({ claimTarget: { frameSha: other, ...t } }), NOW)).toEqual({ ok: false, error: "claim-frame-mismatch" });
    // a hash with no image hash to check it against cannot be trusted
    expect(parseSeaweedAlert(body({ frame: { sha256: null }, claimTarget: { frameSha: SHA, ...t } }), NOW)).toEqual({ ok: false, error: "claim-frame-mismatch" });
    // a long hash is cut to 20 and still matches its image
    const r = parseSeaweedAlert(body({ claimTarget: { frameSha: SHA.slice(0, 30), ...t } }), NOW);
    expect(r.ok && r.value.payload.claimTarget.frameSha).toBe(SHA.slice(0, 20));
  });

  it("without a frame time the alert's own time must be the claim time", () => {
    const t = { frameSha: SHA, frameAt: null };
    expect(parseSeaweedAlert(body({ observedAt: "2026-10-13T17:21:00Z", claimTarget: { ...t, claimedAt: "2026-10-13T17:21:00Z" } }), NOW).ok).toBe(true);
    expect(parseSeaweedAlert(body({ observedAt: "2026-10-13T17:20:00Z", claimTarget: { ...t, claimedAt: "2026-10-13T17:21:00Z" } }), NOW)).toEqual({
      ok: false,
      error: "claim-frame-mismatch",
    });
  });

  it("works out the claim's beach-local date from claimedAt, not the UTC date and not observedAt", () => {
    // 2026-10-14T02:30Z is 10:30 PM EDT on the 13th
    const t = (at: string) => ({ frameSha: SHA, frameAt: at, claimedAt: at });
    const night = parseSeaweedAlert(body({ observedAt: "2026-10-14T02:30:00Z", claimTarget: t("2026-10-14T02:30:00Z") }), Date.parse("2026-10-14T02:35:00.000Z"));
    expect(night.ok && night.value.payload.localDate).toBe("2026-10-13");
    const morning = parseSeaweedAlert(body({ observedAt: "2026-10-14T04:30:00Z", claimTarget: t("2026-10-14T04:30:00Z") }), Date.parse("2026-10-14T04:35:00.000Z"));
    expect(morning.ok && morning.value.payload.localDate).toBe("2026-10-14");
    // a frame taken at 11:58 PM and scored at 12:02 AM belongs to the day it was SCORED
    const across = parseSeaweedAlert(
      body({ observedAt: "2026-10-14T03:58:00Z", claimTarget: { frameSha: SHA, frameAt: "2026-10-14T03:58:00Z", claimedAt: "2026-10-14T04:02:00Z" } }),
      Date.parse("2026-10-14T04:05:00.000Z"),
    );
    expect(across.ok && across.value.payload.localDate).toBe("2026-10-14");
  });
});
