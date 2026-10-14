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
        dedupeKey: `seaweed:boca-raton:boca-inlet-surf:${SHA.slice(0, 16)}`,
        frameJpeg: null,
        payload: {
          camId: "boca-inlet-surf",
          camName: "Boca Inlet Surf Cam",
          observedAt: "2026-10-13T17:20:00.000Z",
          published: { level: "none", pct: 0 },
          claim: { level: "moderate", coveragePct: 35, note: "brown rock shelf", provider: "gemini", model: "gemini-2.5-flash" },
          secondOpinion: { provider: "clef", model: "@cf/cloudflare/clef", level: "none", coveragePct: 0, note: null },
          others: [{ id: "boca-south", name: "Boca South", level: "none", coveragePct: 0, carried: false }],
          frame: { sha256: SHA, archivedThisTick: true, r2Key: null },
        },
      },
    });
  });

  it("keys the alert by frame time when there is no hash", () => {
    const r = parseSeaweedAlert(body({ frame: { sha256: null, archivedThisTick: false } }), NOW);
    expect(r.ok && r.value.dedupeKey).toBe("seaweed:boca-raton:boca-inlet-surf:2026-10-13T17:20:00.000Z");
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
    const r = parseSeaweedAlert(body({ frame: { sha256: "xyz", archivedThisTick: "yes" }, claim: { level: "moderate", coveragePct: 400 } }), NOW);
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
});
