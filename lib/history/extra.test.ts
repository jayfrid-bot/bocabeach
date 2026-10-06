import { describe, it, expect, vi } from "vitest";
import { getLocation } from "@/config/locations";
import { scorableResponse } from "@/lib/alerts/fixtures";
import { deriveMetrics } from "@/lib/score";
import { buildExtra, extraJsonFor, EXTRA_SCHEMA_VERSION } from "@/lib/history/extra";
import { rowFromConditions } from "@/lib/history/archive";
import * as storm from "@/lib/stormActivity";
import type { ConditionsResponse } from "@/lib/types";
import fixture from "@/lib/__fixtures__/boca-2026-09-08-darkening.json";

const boca = getLocation("boca-raton")!;

describe("buildExtra", () => {
  const res = scorableResponse();
  const anchor = Date.parse(res.snapshot.generatedAt);
  const d = deriveMetrics(res.snapshot, anchor);
  const extra = buildExtra(res, d, anchor);

  it("carries the schema version and a version tag on every present block", () => {
    expect(extra.v).toBe(EXTRA_SCHEMA_VERSION);
    for (const [k, v] of Object.entries(extra)) {
      if (k === "v" || v == null) continue;
      expect((v as { av?: string }).av, k).toBeTruthy();
    }
  });

  it("always has safety levels, and sand model output that matches the score's sand column", () => {
    expect(["safe", "caution", "stay-out"]).toContain(extra.safety?.swim);
    expect(["go", "experienced", "closed"]).toContain(extra.safety?.surf);
    if (d.sandTempF != null) expect(extra.sand?.tempF).toBe(d.sandTempF);
  });

  it("mirrors the derived surf estimate", () => {
    if (d.waveHeightFt != null) {
      expect(extra.surf?.surfFt).toBe(Math.round(d.waveHeightFt * 10) / 10);
    }
  });

  it("stays well under the ~4 KB row budget", () => {
    expect(JSON.stringify(extra).length).toBeLessThan(4096);
  });

  it("a block that throws is skipped; the rest still land", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(storm, "computeStormActivity").mockImplementation(() => {
      throw new Error("boom");
    });
    const e = buildExtra(res, d, anchor);
    expect(e.storm).toBeUndefined();
    expect(e.safety).toBeDefined();
    expect(err).toHaveBeenCalled();
    spy.mockRestore();
    err.mockRestore();
  });
});

describe("rowFromConditions extra_json", () => {
  it("is now a parseable v1 document", () => {
    const res = scorableResponse();
    const row = rowFromConditions(res, boca, Date.now());
    expect(row.extra_json).not.toBeNull();
    expect(JSON.parse(row.extra_json!).v).toBe(1);
  });

  it("extraJsonFor never throws", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => extraJsonFor({} as never, {} as never, 0)).not.toThrow();
    err.mockRestore();
  });
});

describe("buildExtra on a real captured snapshot (Boca 2026-09-08, carried sand reading)", () => {
  const real = JSON.parse(JSON.stringify(fixture)) as ConditionsResponse;
  const anchor = Date.parse("2026-09-08T15:41:00.000Z");
  const d = deriveMetrics(real.snapshot, anchor);
  const extra = buildExtra(real, d, anchor);

  it("re-runs the sand model on the SAME inputs the score used (same temp, inputs recorded)", () => {
    expect(d.sandTempF).toBeDefined();
    expect(extra.sand?.tempF).toBe(d.sandTempF);
    expect(extra.sand?.carried).toBe(1);
    expect(extra.sand?.cloudPct).toBe(0); // a carried observation already embodies its sky
    expect(extra.sand?.soilF).not.toBeNull();
    expect(extra.sand?.solarWm2).not.toBeNull();
  });

  it("fills the other readouts a live snapshot supports", () => {
    expect(extra.surf?.surfFt).not.toBeUndefined();
    expect(extra.feels?.tempF).toBeGreaterThan(0);
    expect(extra.storm).toBeDefined();
    expect(!extra.window || typeof extra.window.score === "number").toBe(true);
  });
});
