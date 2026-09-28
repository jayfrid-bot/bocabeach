// The settings-UI toggle for "coming-up" (SKY_EVENTS_PLAN.md §10): its own
// group, a label that says up front how rarely it fires, and — like every
// other AlertKey — a home in exactly one ALERT_GROUPS entry so
// components/plus/PlusSettingsSheet.tsx (which renders ALERT_GROUPS
// generically) always shows it.

import { describe, expect, it } from "vitest";
import { ALERT_GROUPS, ALERT_LABELS, ungroupedAlertKeys } from "@/lib/plus/labels";
import { ALERT_KEYS } from "@/lib/db/types";

describe("coming-up settings label", () => {
  it("has a label naming what it covers and how often it fires", () => {
    expect(ALERT_LABELS["coming-up"]).toMatch(/tides|moon|meteors|launches/i);
    expect(ALERT_LABELS["coming-up"]).toMatch(/month/i);
  });

  it("is grouped with the other sky/sea events, separate from the daily 'Every day' group", () => {
    const group = ALERT_GROUPS.find((g) => g.keys.includes("coming-up"));
    expect(group?.title).toBe("Sky and sea events");
    // sun-color joined this group later — same "opt-in, sky-related" home,
    // not the daily group.
    expect(group?.keys).toEqual(["coming-up", "sun-color"]);
  });

  it("every ALERT_KEY (including coming-up) is homed in exactly one group", () => {
    expect(ungroupedAlertKeys()).toEqual([]);
    for (const key of ALERT_KEYS) {
      const groups = ALERT_GROUPS.filter((g) => g.keys.includes(key));
      expect(groups).toHaveLength(1);
    }
  });
});
