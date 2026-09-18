// The shared session fix (lib/plus/client.ts): an older position must never
// replace a newer one, however the in-flight requests happen to resolve (R-02).

import { describe, it, expect, beforeEach } from "vitest";
import { getSessionFix, setSessionFix } from "@/lib/plus/client";

const NOW = 1_800_000_000_000;
const older = { lat: 26.35, lon: -80.08, accuracyM: 10, at: NOW - 60_000 };
const newer = { lat: 26.36, lon: -80.07, accuracyM: 10, at: NOW };

beforeEach(() => {
  setSessionFix(null);
});

describe("setSessionFix", () => {
  it("publishes a newer fix over an older one", () => {
    setSessionFix(older);
    expect(setSessionFix(newer)).toEqual(newer);
    expect(getSessionFix()).toEqual(newer);
  });

  it("drops an older fix that resolves after a newer one", () => {
    setSessionFix(newer);
    expect(setSessionFix(older)).toEqual(newer);
    expect(getSessionFix()).toEqual(newer);
  });

  it("still allows an explicit clear", () => {
    setSessionFix(newer);
    setSessionFix(null);
    expect(getSessionFix()).toBeNull();
  });

  it("accepts a same-timestamp fix — the rule is strictly OLDER, not older-or-equal", () => {
    setSessionFix(newer);
    const sameTime = { ...newer, lat: 26.4, lon: -80.05 };
    expect(setSessionFix(sameTime)).toEqual(sameTime);
    expect(getSessionFix()).toEqual(sameTime);
  });
});
