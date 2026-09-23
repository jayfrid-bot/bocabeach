import { describe, it, expect, beforeEach } from "vitest";
import { holdReload, reloadHeld, _resetReloadGuardForTests } from "@/lib/reloadGuard";

describe("reloadGuard", () => {
  beforeEach(() => {
    _resetReloadGuardForTests();
  });

  it("is not held with no outstanding holds", () => {
    expect(reloadHeld()).toBe(false);
  });

  it("is held while a hold is outstanding", () => {
    const release = holdReload();
    expect(reloadHeld()).toBe(true);
    release();
    expect(reloadHeld()).toBe(false);
  });

  it("stays held until every concurrent hold releases", () => {
    const releaseA = holdReload();
    const releaseB = holdReload();
    expect(reloadHeld()).toBe(true);
    releaseA();
    expect(reloadHeld()).toBe(true); // B still outstanding
    releaseB();
    expect(reloadHeld()).toBe(false);
  });

  it("releasing twice is a no-op (never goes negative)", () => {
    const release = holdReload();
    release();
    release();
    expect(reloadHeld()).toBe(false);
    // A fresh hold still works correctly afterward.
    const release2 = holdReload();
    expect(reloadHeld()).toBe(true);
    release2();
    expect(reloadHeld()).toBe(false);
  });
});
