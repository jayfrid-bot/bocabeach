import { describe, expect, it } from "vitest";
import { seasonalHazards, type SeasonalHazardRow } from "@/lib/seasonalHazards";
import type { MarineStingerAdvisory } from "@/lib/marineStinger";
import type { SharkContext, SharkFactor } from "@/lib/sharkContext";

// Boca Raton — inside both the SE-US Atlantic mullet band (24-35°N) and the
// narrow winter-blacktip band (25.5-27.5°N).
const BOCA_LAT = 26.3587;
// In the mullet band, but NORTH of the blacktip band (e.g. NE Florida).
const NON_BLACKTIP_LAT = 30;
// Atlantic-facing but well north of the whole SE-US band — no shark seasonal
// science applies here.
const NORTH_LAT = 40;

/** A quiet, everything-null live shape — the realistic off/in-season baseline
 *  when neither advisory has anything elevated to say. */
const QUIET: Pick<
  Parameters<typeof seasonalHazards>[0],
  "marineStinger" | "sharkContext"
> = { marineStinger: null, sharkContext: null };

function rows(month: number, latDeg = BOCA_LAT, live = QUIET): SeasonalHazardRow[] {
  return seasonalHazards({ month, latDeg, ...live });
}

function row(month: number, key: SeasonalHazardRow["key"], latDeg = BOCA_LAT, live = QUIET) {
  return rows(month, latDeg, live).find((r) => r.key === key);
}

function manOWar(level: "low" | "possible" | "elevated" | "high"): MarineStingerAdvisory {
  return {
    manOWar: { level, score: 0, confidence: "wind-only", note: "x" },
    seaLice: null,
  };
}

function seaLice(level: "low" | "possible" | "elevated"): MarineStingerAdvisory {
  return { manOWar: null, seaLice: { level, note: "x" } };
}

function sharkWith(factors: SharkFactor[]): SharkContext {
  return { active: true, season: null, factors, note: "x", rarityNote: "y" };
}

describe("seasonalHazards — shape + ordering", () => {
  it("returns exactly the ordered [manowar, sealice, shark] rows for an in-band beach", () => {
    const r = rows(9); // September, Boca
    expect(r.map((x) => x.key)).toEqual(["manowar", "sealice", "shark"]);
  });

  it("every statusLabel is <=14 chars and every line is <=90 chars", () => {
    for (let m = 1; m <= 12; m++) {
      for (const r of rows(m)) {
        expect(r.statusLabel.length).toBeLessThanOrEqual(14);
        expect(r.line.length).toBeLessThanOrEqual(90);
      }
    }
  });

  it("tone is calm only when quiet, amber otherwise", () => {
    for (let m = 1; m <= 12; m++) {
      for (const r of rows(m)) {
        expect(r.tone).toBe(r.status === "quiet" ? "calm" : "amber");
      }
    }
  });
});

describe("seasonalHazards — man-o'-war month window", () => {
  it("is in-season in the Nov–Apr window", () => {
    for (const m of [11, 12, 1, 2, 3, 4]) {
      expect(row(m, "manowar")?.status).toBe("in-season");
    }
  });

  it("is quiet in the off-season months", () => {
    for (const m of [5, 6, 7, 8, 9, 10]) {
      const r = row(m, "manowar");
      expect(r?.status).toBe("quiet");
      expect(r?.statusLabel).toBe("Out of season");
    }
  });
});

describe("seasonalHazards — sea lice month window", () => {
  it("peaks in May–Jun", () => {
    for (const m of [5, 6]) {
      const r = row(m, "sealice");
      expect(r?.status).toBe("peak");
      expect(r?.statusLabel).toBe("Peak season");
    }
  });

  it("is in-season in the shoulder months of Mar–Aug", () => {
    for (const m of [3, 4, 7, 8]) {
      expect(row(m, "sealice")?.status).toBe("in-season");
    }
  });

  it("is quiet outside Mar–Aug", () => {
    for (const m of [1, 2, 9, 10, 11, 12]) {
      expect(row(m, "sealice")?.status).toBe("quiet");
    }
  });
});

describe("seasonalHazards — shark month window (in blacktip band)", () => {
  it("peaks in the Sep–Oct mullet run", () => {
    for (const m of [9, 10]) {
      expect(row(m, "shark")?.status).toBe("peak");
    }
  });

  it("is in-season in the Aug/Nov mullet shoulder", () => {
    for (const m of [8, 11]) {
      expect(row(m, "shark")?.status).toBe("in-season");
    }
  });

  it("peaks in the Feb–Mar blacktip window and is in-season Dec/Jan", () => {
    expect(row(2, "shark")?.status).toBe("peak");
    expect(row(3, "shark")?.status).toBe("peak");
    expect(row(12, "shark")?.status).toBe("in-season");
    expect(row(1, "shark")?.status).toBe("in-season");
  });

  it("is quiet in the dead months", () => {
    for (const m of [4, 5, 6, 7]) {
      expect(row(m, "shark")?.status).toBe("quiet");
    }
  });
});

describe("seasonalHazards — latitude gating", () => {
  it("drops the shark row for an Atlantic beach north of the SE-US band", () => {
    const r = rows(9, NORTH_LAT);
    expect(r.map((x) => x.key)).toEqual(["manowar", "sealice"]);
    // Man-o'-war + sea lice still apply at any Atlantic latitude.
    expect(r.find((x) => x.key === "sealice")).toBeDefined();
  });

  it("keeps a shark row in the mullet band but reads winter as quiet outside the blacktip band", () => {
    // January is a blacktip-only month; north of the narrow band it doesn't apply.
    expect(row(1, "shark", NON_BLACKTIP_LAT)?.status).toBe("quiet");
    // But the fall mullet run still fires in the wider band.
    expect(row(9, "shark", NON_BLACKTIP_LAT)?.status).toBe("peak");
  });
});

describe("seasonalHazards — live-signal elevation overrides", () => {
  it("lifts man-o'-war to watch when the live level is elevated/high, even off-season", () => {
    for (const level of ["elevated", "high"] as const) {
      const r = row(7, "manowar", BOCA_LAT, { marineStinger: manOWar(level), sharkContext: null });
      expect(r?.status).toBe("watch");
      expect(r?.statusLabel).toBe("Watch");
      expect(r?.tone).toBe("amber");
    }
  });

  it("does NOT lift man-o'-war to watch for a low/possible live level", () => {
    const r = row(7, "manowar", BOCA_LAT, { marineStinger: manOWar("possible"), sharkContext: null });
    expect(r?.status).toBe("quiet"); // July is off-season, no elevation
  });

  it("swaps sea lice to the fuller line when live level is possible/elevated in season", () => {
    for (const level of ["possible", "elevated"] as const) {
      const r = row(8, "sealice", BOCA_LAT, { marineStinger: seaLice(level), sharkContext: null });
      expect(r?.status).toBe("in-season"); // status still the calendar window
      expect(r?.line).toContain("water's warm");
    }
  });

  it("lifts shark to watch when live micro-factors are present, even off-season", () => {
    const r = row(5, "shark", BOCA_LAT, {
      marineStinger: null,
      sharkContext: sharkWith(["murky water", "dawn/dusk"]),
    });
    expect(r?.status).toBe("watch");
    expect(r?.line).toContain("low-light");
  });

  it("does NOT lift shark to watch when the live context has no micro-factors", () => {
    const r = row(5, "shark", BOCA_LAT, {
      marineStinger: null,
      sharkContext: sharkWith([]),
    });
    expect(r?.status).toBe("quiet"); // May, no season, no factors
  });
});

describe("seasonalHazards — never emits a numeric risk", () => {
  it("no row's name, statusLabel, or line contains any digit, across every month and both quiet + elevated data", () => {
    const liveShapes = [
      QUIET,
      { marineStinger: manOWar("high"), sharkContext: sharkWith(["murky water", "dawn/dusk"]) },
      { marineStinger: seaLice("elevated"), sharkContext: sharkWith(["near inlet"]) },
    ];
    for (let m = 1; m <= 12; m++) {
      for (const latDeg of [BOCA_LAT, NON_BLACKTIP_LAT, NORTH_LAT]) {
        for (const live of liveShapes) {
          for (const r of seasonalHazards({ month: m, latDeg, ...live })) {
            expect(r.name, `name @ month ${m}`).not.toMatch(/\d/);
            expect(r.statusLabel, `statusLabel @ month ${m}`).not.toMatch(/\d/);
            expect(r.line, `line "${r.line}" @ month ${m}`).not.toMatch(/\d/);
          }
        }
      }
    }
  });
});
