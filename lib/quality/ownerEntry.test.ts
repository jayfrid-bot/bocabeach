import { describe, expect, it, vi } from "vitest";

// Plain stand-ins for the two React hooks, so the hook can be run without a renderer.
vi.mock("react", () => ({
  useRef: <T,>(v: T) => ({ current: v }),
  useCallback: <T,>(fn: T) => fn,
}));

import { OWNER_ENTRY_PATH, OWNER_ENTRY_TAPS, OWNER_ENTRY_WINDOW_MS, registerTap, useOwnerEntryTap } from "@/lib/quality/ownerEntry";

describe("registerTap", () => {
  it("fires on the 5th tap inside 3 seconds, then starts over", () => {
    let taps: number[] = [];
    const out: boolean[] = [];
    for (const t of [0, 500, 1000, 1500, 2000, 2100]) {
      const r = registerTap(taps, t);
      taps = r.taps;
      out.push(r.hit);
    }
    expect(OWNER_ENTRY_TAPS).toBe(5);
    expect(out).toEqual([false, false, false, false, true, false]);
  });

  it("does not fire when the 5 taps are spread over more than 3 seconds", () => {
    let taps: number[] = [];
    let hits = 0;
    for (const t of [0, 1000, 2000, 3000, 4000, 5000, 6000]) {
      const r = registerTap(taps, t);
      taps = r.taps;
      hits += r.hit ? 1 : 0;
    }
    expect(hits).toBe(0);
  });

  it("the window is exactly 3 seconds: the 5th tap at 3000 ms counts, at 3001 ms it does not", () => {
    expect(OWNER_ENTRY_WINDOW_MS).toBe(3000);
    const four = [0, 1, 2, 3];
    expect(registerTap(four, 3000).hit).toBe(true);
    expect(registerTap(four, 3001).hit).toBe(false);
  });

  it("slow taps that follow a burst do not add up with it", () => {
    let taps: number[] = [];
    for (const t of [0, 100, 200, 300]) taps = registerTap(taps, t).taps;
    expect(registerTap(taps, 10_000).hit).toBe(false);
  });
});

describe("useOwnerEntryTap", () => {
  it("goes to the owner review only after five quick taps, and only then", () => {
    const go = vi.fn();
    let now = 1000;
    const tap = useOwnerEntryTap(go, () => now);
    for (let i = 0; i < 4; i++) {
      tap();
      now += 400;
    }
    expect(go).not.toHaveBeenCalled();
    tap();
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(OWNER_ENTRY_PATH);
    expect(OWNER_ENTRY_PATH).toBe("/admin/review");
    // a sixth tap right after does not fire again
    now += 100;
    tap();
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("an ordinary single tap never navigates", () => {
    const go = vi.fn();
    const tap = useOwnerEntryTap(go, () => 5);
    tap();
    expect(go).not.toHaveBeenCalled();
  });
});
