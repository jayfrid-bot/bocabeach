import { describe, expect, it } from "vitest";
import { camLabel, hourlyStatement, othersText, pushCopy, seaweedStatement, statementFor } from "@/lib/quality/text";
import type { HourlyAlertPayload, SeaweedAlertPayload } from "@/lib/quality/types";

const seaweed = (over: Partial<SeaweedAlertPayload> = {}): SeaweedAlertPayload => ({
  camId: "boca-inlet-surf",
  camName: "Boca Inlet Cam",
  observedAt: "2026-10-13T17:20:00.000Z",
  published: { level: "none", pct: 0 },
  claim: { level: "moderate", coveragePct: 35, note: "rocks", provider: "gemini", model: "m" },
  secondOpinion: { provider: "clef", model: "m", level: "none", coveragePct: 0, note: null },
  others: [
    { id: "a", name: "Boca South", level: "none", coveragePct: 0, carried: false },
    { id: "b", name: "South Surf Cam", level: "none", coveragePct: 0, carried: false },
  ],
  frame: { sha256: null, archivedThisTick: false },
  ...over,
});

const hourly = (over: Partial<HourlyAlertPayload> = {}): HourlyAlertPayload => ({
  observedAt: "2026-10-13T17:00:00.000Z",
  fromHourUtc: "2026-10-13T16:00:00.000Z",
  from: 78,
  to: 58,
  delta: -20,
  cause: null,
  published: { value: 58 },
  ...over,
});

describe("the seaweed push", () => {
  it("reads like the plan's example", () => {
    expect(pushCopy("boca-raton", "seaweed-held-disagreed", "seaweed", seaweed())).toEqual({
      title: "Boca Raton",
      body: "Check: Boca Inlet cam says moderate seaweed (35%). Other cams: none.",
    });
  });

  it("lists each cam when the others disagree with each other", () => {
    const p = seaweed({
      others: [
        { id: "a", name: "Boca South", level: "none", coveragePct: 0, carried: false },
        { id: "b", name: "South Surf Cam", level: "low", coveragePct: 12, carried: true },
      ],
    });
    expect(pushCopy("boca-raton", "seaweed-held-disagreed", "seaweed", p).body).toBe(
      "Check: Boca Inlet cam says moderate seaweed (35%). Other cams: Boca South: none, South Surf: low.",
    );
  });

  it("says so when no other cam has a reading, and leaves out a missing percent", () => {
    const p = seaweed({ others: [], claim: { ...seaweed().claim, coveragePct: null } });
    expect(pushCopy("boca-raton", "seaweed-held-disagreed", "seaweed", p).body).toBe(
      "Check: Boca Inlet cam says moderate seaweed. Other cams: no other readings.",
    );
  });
});

describe("the hourly push", () => {
  it("states the move in plain words", () => {
    expect(pushCopy("boca-raton", "hourly-jump", "score", hourly()).body).toBe(
      "Check: Beach Day score went from 78 to 58 in an hour, and nothing obvious explains it.",
    );
    expect(hourlyStatement("surf", hourly({ from: 1.5, to: 4 }))).toBe("Surf went from 1.5 ft to 4 ft in an hour");
    expect(hourlyStatement("sand", hourly({ from: 92, to: 108 }))).toBe("Sand temperature went from 92 F to 108 F in an hour");
    expect(hourlyStatement("clarity", hourly({ from: 80, to: 55 }))).toBe("Water clarity went from 80% clear to 55% clear in an hour");
  });
});

describe("helpers", () => {
  it("camLabel trims a trailing 'cam' and keeps a name that is only 'cam'", () => {
    expect(camLabel("Boca Inlet Cam")).toBe("Boca Inlet");
    expect(camLabel("Boca South")).toBe("Boca South");
    expect(camLabel("Cam")).toBe("Cam");
  });

  it("othersText: one word when all agree", () => {
    expect(othersText([{ id: "a", name: "A", level: "low", coveragePct: 10, carried: false }])).toBe("low");
  });

  it("statementFor picks the right sentence for each kind", () => {
    expect(statementFor("seaweed-held-disagreed", "seaweed", seaweed())).toBe(seaweedStatement(seaweed()));
    expect(statementFor("hourly-jump", "score", hourly())).toBe("Beach Day score went from 78 to 58 in an hour");
  });

  it("an unknown beach falls back to its slug, and no copy says the word AI", () => {
    expect(pushCopy("nowhere", "hourly-jump", "score", hourly()).title).toBe("nowhere");
    const all = [
      pushCopy("boca-raton", "seaweed-held-disagreed", "seaweed", seaweed()),
      pushCopy("boca-raton", "hourly-jump", "clarity", hourly()),
    ];
    for (const c of all) expect(`${c.title} ${c.body}`).not.toMatch(/\bAI\b/);
  });
});
