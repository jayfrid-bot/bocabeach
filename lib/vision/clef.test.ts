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
  validateClefAnswers,
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

describe("strict validation runs before the mapping", () => {
  const beach = () => structuredClone(records.find((r) => r.cam !== UW_CAM)!.answers) as Record<string, any>;
  const uw = () => structuredClone(records.find((r) => r.cam === UW_CAM)!.answers) as Record<string, any>;

  it("accepts all 229 cached valid replies unchanged", () => {
    for (const r of records) {
      expect(validateClefAnswers(r.answers, r.cam === UW_CAM ? "underwater" : "surface"), r.frameId).toBeNull();
    }
  });

  it("rejects no answers and a missing question", () => {
    expect(validateClefAnswers(null, "surface")).toMatch(/no answers/);
    const a = beach();
    delete a.people;
    expect(validateClefAnswers(a, "surface")).toMatch(/people: missing/);
    const b = uw();
    delete b.unreadable;
    expect(validateClefAnswers(b, "underwater")).toMatch(/unreadable: missing/);
  });

  it("rejects a non-finite or out-of-range noul", () => {
    for (const bad of [Number.NaN, Infinity, -0.1, 1.2, "0.5", null]) {
      const a = beach();
      a.unreadable.noul = bad;
      expect(validateClefAnswers(a, "surface"), String(bad)).toMatch(/noul/);
    }
    const u = uw();
    u.unreadable.noul = 2;
    expect(validateClefAnswers(u, "underwater")).toMatch(/noul/);
  });

  it("rejects non-finite or out-of-[0,1] probabilities", () => {
    for (const bad of [Number.NaN, Infinity, -0.01, 1.01, "0.3"]) {
      const a = beach();
      a.crowd.probabilities.empty = bad;
      expect(validateClefAnswers(a, "surface"), String(bad)).toMatch(/crowd: probability for empty/);
      const b = beach();
      b.people.probabilities["2"] = bad;
      expect(validateClefAnswers(b, "surface"), String(bad)).toMatch(/people: probability for 2/);
    }
  });

  it("rejects probability keys outside the question's bands or options", () => {
    const a = beach();
    a.people.probabilities["7"] = 0.2; // people has bands 0..6
    expect(validateClefAnswers(a, "surface")).toMatch(/people: probability key "7"/);
    const b = beach();
    b.seaweed_pct.probabilities["5"] = 0.2; // seaweed_pct has bands 0..4
    expect(validateClefAnswers(b, "surface")).toMatch(/seaweed_pct: probability key/);
    const c = beach();
    c.crowd.probabilities.chaos = 0.2;
    expect(validateClefAnswers(c, "surface")).toMatch(/crowd: probability key "chaos"/);
    const d = beach();
    d.water_pct.probabilities["-1"] = 0.2;
    expect(validateClefAnswers(d, "surface")).toMatch(/water_pct: probability key/);
    const e = beach();
    e.water_pct.probabilities["1.5"] = 0.2;
    expect(validateClefAnswers(e, "surface")).toMatch(/water_pct: probability key/);
    const f = uw();
    f.uw_pct.probabilities["5"] = 0.2; // uw_pct has bands 0..4
    expect(validateClefAnswers(f, "underwater")).toMatch(/uw_pct: probability key/);
  });

  it("rejects empty, all-zero, or over-1 probability sets", () => {
    const a = beach();
    a.people.probabilities = {};
    expect(validateClefAnswers(a, "surface")).toMatch(/empty or all zero/);
    const b = beach();
    for (const k of Object.keys(b.people.probabilities)) b.people.probabilities[k] = 0;
    expect(validateClefAnswers(b, "surface")).toMatch(/empty or all zero/);
    const c = beach();
    for (const k of Object.keys(c.people.probabilities)) c.people.probabilities[k] = 0.9;
    expect(validateClefAnswers(c, "surface")).toMatch(/sum above 1/);
    const d = beach();
    const keys = Object.keys(d.people.probabilities);
    for (const k of keys) d.people.probabilities[k] = 0;
    d.people.probabilities[keys[0]] = 0.01; // truncated: would normalize to a confident endpoint
    expect(validateClefAnswers(d, "surface")).toMatch(/well below 1/);
  });

  it("rejects a score index outside the question's band range", () => {
    for (const bad of [-0.5, 6.01, Number.NaN, Infinity]) {
      const a = beach();
      a.people.score = bad; // people has bands 0..6
      expect(validateClefAnswers(a, "surface"), String(bad)).toMatch(/people: score outside 0\.\.6/);
    }
    const b = beach();
    b.crowd_pct.score = 4.5; // crowd_pct has bands 0..4
    expect(validateClefAnswers(b, "surface")).toMatch(/crowd_pct: score outside 0\.\.4/);
  });

  it("rejects probabilities that are not an object", () => {
    const a = beach();
    a.people.probabilities = [0.5, 0.5];
    expect(validateClefAnswers(a, "surface")).toMatch(/not an object/);
    const b = beach();
    b.seaweed.probabilities = "none";
    expect(validateClefAnswers(b, "surface")).toMatch(/not an object/);
  });

  it("rejects a choice outside the options, or a score with neither probabilities nor score", () => {
    const a = beach();
    a.water.choice = "foggy";
    expect(validateClefAnswers(a, "surface")).toMatch(/water: choice outside/);
    const b = beach();
    delete b.people.probabilities;
    delete b.people.score;
    expect(validateClefAnswers(b, "surface")).toMatch(/people: no probabilities and no score/);
  });

  it("treats a REST reply with success:false as no answers", () => {
    expect(unwrapClefResult({ success: false, result: { answers: { a: 1 } } })).toEqual({ answers: null, inputTokens: null });
    expect(unwrapClefResult({ success: false, answers: { a: 1 } })).toEqual({ answers: null, inputTokens: null });
    expect(unwrapClefResult({ success: true, result: { answers: { a: 1 }, usage: { input_tokens: 3 } } }).inputTokens).toBe(3);
    expect(unwrapClefResult({ answers: { a: 1 }, usage: { input_tokens: Number.NaN } }).inputTokens).toBeNull();
  });
});
