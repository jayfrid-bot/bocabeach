import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PLUS_KEYS,
  cleanCache,
  cleanPreview,
  cleanProfile,
  readCache,
  readFirstRunDone,
  readPreview,
  readPreviewSeen,
  readProfile,
  writeCache,
  writeFirstRunDone,
  writePreview,
  writePreviewSeen,
  writeProfile,
} from "@/lib/plus/storage";

// The suite runs under environment: "node", so there is no localStorage. Every
// read/write in lib/plus/storage.ts is guarded on the localStorage global (NOT
// on `window`) precisely so a fake one can be installed here and the real
// persistence paths get exercised rather than skipped.
class FakeStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
  key(i: number) {
    return Array.from(this.map.keys())[i] ?? null;
  }
  get length() {
    return this.map.size;
  }
}

let fake: FakeStorage;

beforeEach(() => {
  fake = new FakeStorage();
  (globalThis as { localStorage?: unknown }).localStorage = fake;
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("profile round-trip", () => {
  it("survives a write and a read", () => {
    writeProfile({ profiles: ["snorkel"], heat: "hot", crowds: "low" });
    expect(readProfile()).toEqual({ profiles: ["snorkel"], heat: "hot", crowds: "low" });
  });

  it("keeps Advanced edits", () => {
    writeProfile({
      profiles: ["surf", "swim"],
      heat: "normal",
      crowds: "normal",
      advanced: { mult: { waves: 3 }, airIdeal: [70, 85], wavePref: "surf" },
    });
    expect(readProfile()?.advanced).toEqual({
      mult: { waves: 3 },
      airIdeal: [70, 85],
      wavePref: "surf",
    });
  });

  it("clears on null", () => {
    writeProfile({ profiles: ["swim"], heat: "normal", crowds: "normal" });
    writeProfile(null);
    expect(readProfile()).toBeNull();
  });
});

describe("cleanProfile", () => {
  it("rejects anything that is not an object with a known profile", () => {
    expect(cleanProfile(null)).toBeNull();
    expect(cleanProfile("swim")).toBeNull();
    expect(cleanProfile([])).toBeNull();
    expect(cleanProfile({ profiles: [] })).toBeNull();
    expect(cleanProfile({ profiles: ["kayaking"] })).toBeNull();
  });

  it("drops unknown profiles but keeps the known ones", () => {
    expect(cleanProfile({ profiles: ["swim", "kayaking"] })?.profiles).toEqual(["swim"]);
  });

  it("never keeps more than two profiles", () => {
    expect(cleanProfile({ profiles: ["swim", "surf", "dog"] })?.profiles).toEqual(["swim", "surf"]);
  });

  it("falls back to the middle answer for a bad heat or crowd value", () => {
    const p = cleanProfile({ profiles: ["swim"], heat: "boiling", crowds: 7 });
    expect(p?.heat).toBe("normal");
    expect(p?.crowds).toBe("normal");
  });

  it("drops multipliers that are not one of the five stops", () => {
    const p = cleanProfile({ profiles: ["swim"], advanced: { mult: { waves: 7, sky: 2 } } });
    expect(p?.advanced?.mult).toEqual({ sky: 2 });
  });

  it("drops a backwards or non-numeric ideal range", () => {
    expect(cleanProfile({ profiles: ["swim"], advanced: { airIdeal: [90, 70] } })?.advanced)
      .toBeUndefined();
    expect(cleanProfile({ profiles: ["swim"], advanced: { airIdeal: ["hot", 90] } })?.advanced)
      .toBeUndefined();
  });

  it("survives a corrupted stored value", () => {
    fake.setItem(PLUS_KEYS.profile, "{not json");
    expect(readProfile()).toBeNull();
  });
});

describe("entitlement cache", () => {
  it("round-trips", () => {
    writeCache({ plan: "plus", until: 123, checkedAt: 456 });
    expect(readCache()).toEqual({ plan: "plus", until: 123, checkedAt: 456 });
  });

  it("rejects an unknown plan outright", () => {
    expect(cleanCache({ plan: "premium", until: 1, checkedAt: 1 })).toBeNull();
  });

  it("treats a missing checkedAt as ancient rather than trusted", () => {
    expect(cleanCache({ plan: "plus", until: 1 })?.checkedAt).toBe(0);
  });
});

describe("the one-time reveal", () => {
  it("round-trips the saved numbers", () => {
    writePreview({ date: "2026-09-02", personal: 71, everyone: 58, label: "snorkeling" });
    expect(readPreview()).toEqual({
      date: "2026-09-02",
      personal: 71,
      everyone: 58,
      label: "snorkeling",
    });
  });

  it("rejects a record with no real date", () => {
    expect(cleanPreview({ date: "yesterday", personal: 1, everyone: 2, label: "" })).toBeNull();
    expect(cleanPreview({ personal: 1, everyone: 2 })).toBeNull();
  });

  it("only ever fires once: the seen flag is sticky until it is cleared", () => {
    expect(readPreviewSeen()).toBe(false);
    writePreviewSeen(true);
    expect(readPreviewSeen()).toBe(true);
    writePreviewSeen(false);
    expect(readPreviewSeen()).toBe(false);
  });

  it("keeps the first-run banner from coming back", () => {
    expect(readFirstRunDone()).toBe(false);
    writeFirstRunDone(true);
    expect(readFirstRunDone()).toBe(true);
  });
});

describe("with no storage at all (server render, private mode)", () => {
  it("reads as empty and writes without throwing", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(readProfile()).toBeNull();
    expect(readCache()).toBeNull();
    expect(readPreview()).toBeNull();
    expect(readPreviewSeen()).toBe(false);
    expect(readFirstRunDone()).toBe(false);
    expect(() => writeProfile({ profiles: ["swim"], heat: "normal", crowds: "normal" })).not.toThrow();
    expect(() => writeFirstRunDone(true)).not.toThrow();
  });
});
