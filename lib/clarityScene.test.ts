import { describe, expect, it } from "vitest";
import {
  clarityHazeOpacity,
  clarityParticleCount,
  clarityParticles,
  radicalInverse,
} from "@/lib/clarityScene";

describe("clarityHazeOpacity", () => {
  it("clamps to a visible floor in perfectly clear water", () => {
    expect(clarityHazeOpacity(100)).toBe(0.05);
  });

  it("tops out below opaque in the murkiest water", () => {
    expect(clarityHazeOpacity(0)).toBe(0.75);
  });

  it("gets hazier as the clear percentage drops", () => {
    const readings = [95, 80, 60, 40, 20].map(clarityHazeOpacity);
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i]).toBeGreaterThan(readings[i - 1]);
    }
  });

  it("treats out-of-range readings as the nearest valid end", () => {
    expect(clarityHazeOpacity(140)).toBe(clarityHazeOpacity(100));
    expect(clarityHazeOpacity(-20)).toBe(clarityHazeOpacity(0));
  });
});

describe("clarityParticleCount", () => {
  it("leaves only a couple of motes in clear water", () => {
    expect(clarityParticleCount(100)).toBe(2);
  });

  it("swarms the column when the water is churned", () => {
    expect(clarityParticleCount(0)).toBe(24);
  });

  it("never decreases as clarity drops", () => {
    let prev = clarityParticleCount(100);
    for (let pct = 95; pct >= 0; pct -= 5) {
      const n = clarityParticleCount(pct);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });
});

describe("radicalInverse", () => {
  it("matches the known van der Corput base-2 sequence", () => {
    expect([1, 2, 3, 4].map((i) => radicalInverse(i, 2))).toEqual([0.5, 0.25, 0.75, 0.125]);
  });

  it("stays inside the unit interval", () => {
    for (let i = 1; i <= 50; i++) {
      const v = radicalInverse(i, 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("clarityParticles", () => {
  it("is deterministic — the same reading yields the same field", () => {
    expect(clarityParticles(42)).toEqual(clarityParticles(42));
  });

  it("keeps every particle inside the scene box", () => {
    for (const p of clarityParticles(10)) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(280);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(56);
      expect(p.r).toBeGreaterThan(0);
    }
  });

  it("makes particles both more numerous and more visible in murk", () => {
    const clear = clarityParticles(90);
    const murky = clarityParticles(20);
    expect(murky.length).toBeGreaterThan(clear.length);
    expect(murky[0].o).toBeGreaterThan(clear[0].o);
  });
});
