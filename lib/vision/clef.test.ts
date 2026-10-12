// The production Clef mapping must equal the offline backtest's, so the backtest
// stays the evidence for production behavior. These tests load the backtest
// script itself and compare it with lib/vision/clef.ts on every cached reply.

import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  beachQuestions,
  buildClefRequest,
  deriveClef,
  isUnreadable,
  surfaceReading,
  underwaterReading,
  unwrapClefResult,
  uwQuestions,
} from "@/lib/vision/clef";

const BENCH = path.join(process.cwd(), "docs", "benchmarks", "clef-vision-2026-10-12");
const CACHE = path.join(BENCH, "cache");
const UW_CAM = "deerfield-spinner-uw";

interface Backtest {
  deriveClef: (ans: unknown, uw: boolean) => Record<string, unknown> | null;
  beachQuestions: () => unknown;
  uwQuestions: () => unknown;
}
let bt: Backtest;

interface CacheRec {
  model: string;
  frameId: string;
  cam: string;
  answers: Record<string, unknown>;
  tokens: number | null;
}
const cacheFiles = fs.existsSync(CACHE)
  ? fs.readdirSync(CACHE).filter((f) => f.startsWith("clef_") && f.endsWith(".json") && !f.endsWith(".err.json"))
  : [];
const records: CacheRec[] = cacheFiles.map((f) => JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8")));

beforeAll(async () => {
  // The script prints a usage line when imported without flags.
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    bt = (await import("@/scripts/clef_vision_backtest.mjs")) as unknown as Backtest;
  } finally {
    spy.mockRestore();
  }
});

describe("backtest evidence is present", () => {
  it("has the 229 cached clef 27B replies (never clef-flash)", () => {
    expect(records.length).toBe(229);
    expect(records.every((r) => r.model === "clef")).toBe(true);
  });
});

describe("the request equals the backtest's", () => {
  it("asks the same surface questions", () => {
    expect(beachQuestions()).toEqual(bt.beachQuestions());
  });
  it("asks the same underwater questions", () => {
    expect(uwQuestions()).toEqual(bt.uwQuestions());
  });
  it("sends one base64 data URI per call, with the backtest's state text", () => {
    const req = buildClefRequest("surface", "/9j/AAAA");
    expect(req.images).toEqual(["data:image/jpeg;base64,/9j/AAAA"]);
    expect(req.state.task).toBe("This is a live beach webcam photo. Read it with the rubric in the questions.");
    expect(req.state.photos).toBe("One photo: this frame.");
    expect(req.questions).toEqual(bt.beachQuestions());
    const uw = buildClefRequest("underwater", "/9j/AAAA");
    expect(uw.state.task).toContain("UNDERWATER ocean webcam");
    expect(uw.questions).toEqual(bt.uwQuestions());
  });
  it("has no `model` field (the binding takes the model as its first argument)", () => {
    expect(Object.keys(buildClefRequest("surface", "/9j/AAAA")).sort()).toEqual(["images", "questions", "state"]);
  });
});

describe("the mapping equals the backtest's on every cached reply", () => {
  it("deriveClef gives identical fields for all 229 frames", () => {
    let uwCount = 0;
    for (const r of records) {
      const uw = r.cam === UW_CAM;
      if (uw) uwCount += 1;
      expect(deriveClef(r.answers, uw), r.frameId).toEqual(bt.deriveClef(r.answers, uw));
    }
    expect(uwCount).toBeGreaterThan(10);
  });

  it("every cached reply yields a complete reading (no failures in the backtest)", () => {
    for (const r of records) {
      const uw = r.cam === UW_CAM;
      if (uw) {
        expect(underwaterReading(deriveClef(r.answers, true)), r.frameId).not.toBeNull();
      } else {
        expect(surfaceReading(deriveClef(r.answers, false)), r.frameId).not.toBeNull();
      }
    }
  });
});

describe("spot checks against known cached frames", () => {
  const find = (id: string) => {
    const r = records.find((x) => x.frameId === id);
    if (!r) throw new Error("missing cache " + id);
    return r;
  };

  it("boca-inlet-jetty 2026-10-11 1059Z: water unknown becomes null, level words kept", () => {
    const d = deriveClef(find("boca-inlet-jetty/2026-10-11/1059Z").answers, false);
    expect(d).toMatchObject({ seaweed: "low", crowd: "empty", water: null, waterUnknown: true, ok: true });
    const reading = surfaceReading(d);
    expect(reading).toMatchObject({ level: "low", crowd: "empty", water: null });
    // 0.7934 weighted over 0/5/30/60/95 bands => a small number, not the raw score
    expect(reading?.coveragePct).toBeLessThan(10);
    expect(reading?.note).toBe("");
  });

  it("deerfield-beach-cam 2026-10-11 2007Z: the big crowd the backtest read low is read the same way", () => {
    const d = deriveClef(find("deerfield-beach-cam/2026-10-11/2007Z").answers, false);
    expect(d?.people).toBe(23); // REPORT.md: "Clef 23" against a key of 50
    expect(d?.waterPct).toBe(72);
    expect(d?.seaweed).toBe("none");
  });

  it("spinner 2026-10-11 1007Z: murky, and flagged unreadable (dark)", () => {
    const d = deriveClef(find("deerfield-spinner-uw/2026-10-11/1007Z").answers, true);
    expect(d?.uwLevel).toBe("murky");
    expect(isUnreadable(d?.unreadableP ?? null)).toBe(true);
    expect(underwaterReading(d)).toMatchObject({ level: "murky", note: "" });
  });
});

describe("missing fields are never invented", () => {
  const good = records.find((r) => r.cam !== UW_CAM)!.answers;

  it("returns null when an answer is missing", () => {
    for (const k of Object.keys(good)) {
      const { [k]: _drop, ...rest } = good;
      expect(surfaceReading(deriveClef(rest, false)), `without ${k}`).toBeNull();
    }
  });
  it("returns null for no answers at all", () => {
    expect(deriveClef(null, false)).toBeNull();
    expect(surfaceReading(deriveClef(undefined, false))).toBeNull();
    expect(underwaterReading(deriveClef({}, true))).toBeNull();
  });
  it("rejects a choice outside the allowed words", () => {
    const bad = { ...good, seaweed: { type: "choice", choice: "extreme" } };
    expect(surfaceReading(deriveClef(bad, false))).toBeNull();
  });
});

describe("isUnreadable", () => {
  it("uses 0.5, the backtest's cut", () => {
    expect(isUnreadable(0.5)).toBe(true);
    expect(isUnreadable(0.4999)).toBe(false);
    expect(isUnreadable(null)).toBe(false);
  });
});

describe("unwrapClefResult", () => {
  const answers = { a: 1 };
  it("reads the binding shape", () => {
    expect(unwrapClefResult({ answers, usage: { input_tokens: 1795 } })).toEqual({ answers, inputTokens: 1795 });
  });
  it("reads the REST shape", () => {
    expect(unwrapClefResult({ result: { answers, usage: { input_tokens: 7 } }, success: true })).toEqual({ answers, inputTokens: 7 });
  });
  it("tolerates junk", () => {
    expect(unwrapClefResult(null)).toEqual({ answers: null, inputTokens: null });
    expect(unwrapClefResult("x")).toEqual({ answers: null, inputTokens: null });
    expect(unwrapClefResult({ answers: "no" })).toEqual({ answers: null, inputTokens: null });
  });
});
