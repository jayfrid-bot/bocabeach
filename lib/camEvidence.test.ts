import { describe, expect, it } from "vitest";
import { camEvidenceFromSources } from "@/lib/camEvidence";
import type { CamConfig } from "@/lib/types";

// The scorecard's read of each cam (uw-frame /cams + county latest.json), the same
// evidence rules as the page (lib/cams.ts).

const feedCam = (id: string, view: string): CamConfig => ({
  id,
  name: id,
  provider: "Test",
  embedType: "image",
  url: "https://example.test",
  snapshotFeed: { base: "https://feed.test/x", view },
});
const metaCam = (id: string): CamConfig => ({
  id,
  name: id,
  provider: "Test",
  embedType: "image",
  url: "https://example.test",
  snapshotUrl: `https://uw.test/frame?cam=${id}`,
  snapshotMetaUrl: `https://uw.test/meta?cam=${id}`,
});

describe("camEvidenceFromSources", () => {
  it("a feed view with an image but no capture time is unknown (shown), an absent view is dropped", () => {
    const feeds = new Map<string, unknown>([
      ["https://feed.test/x", { s4: { hr: "pics/s4/a.jpg", mr: "pics/s4/a_.jpg" }, s8: { mr: "s8.jpg", timestamp: 1_793_990_000 } }],
    ]);
    const ev = camEvidenceFromSources([{ cams: [feedCam("a", "s4"), feedCam("b", "s8"), feedCam("c", "s9")] }], undefined, feeds);
    expect(ev).toEqual([
      { id: "a", lastGoodFrameAt: undefined },
      { id: "b", lastGoodFrameAt: new Date(1_793_990_000_000).toISOString() },
      { id: "c", lastGoodFrameAt: null },
    ]);
  });

  it("reads courier cams from one /cams answer, with the last blank try", () => {
    const uw = {
      cams: [
        { id: "ok", ok: true, grabbedAtUtc: "2026-11-06T18:00:00Z", lastAttempt: null },
        { id: "dead", ok: false, grabbedAtUtc: "2026-11-06T18:00:00Z", lastAttempt: { grabbedAtUtc: "2026-11-06T17:18:10Z", error: "blank frame: ..." } },
      ],
    };
    const ev = camEvidenceFromSources([{ cams: [metaCam("ok"), metaCam("dead"), metaCam("missing")] }], uw, new Map());
    expect(ev).toEqual([
      { id: "ok", lastGoodFrameAt: "2026-11-06T18:00:00.000Z", lastAttempt: null },
      { id: "dead", lastGoodFrameAt: null, lastAttempt: { at: "2026-11-06T17:18:10Z", blank: true } },
      { id: "missing", lastGoodFrameAt: undefined },
    ]);
  });
});
