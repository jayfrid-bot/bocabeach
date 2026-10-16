import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isFlagOn, SUN_ALERTS_UI_ENABLED } from "@/lib/plus/flags";
import { inAppSunLine, paywallSunBenefit, sunColorAlertLabel, visibleAlertGroups } from "@/lib/plus/sunAlertCopy";
import { ALERT_GROUPS, ALERT_LABELS } from "@/lib/plus/labels";
import { PlusInAppCard } from "@/components/plus/PlusInAppCard";

describe("the client flag (NEXT_PUBLIC_SUN_ALERTS)", () => {
  it("is off by default in this build and parses like the server flag", () => {
    expect(SUN_ALERTS_UI_ENABLED).toBe(false);
    expect(isFlagOn(undefined)).toBe(false);
    for (const v of ["", "off", "0", "false", "no"]) expect(isFlagOn(v)).toBe(false);
    for (const v of ["on", "ON", "1", "true", " yes "]) expect(isFlagOn(v)).toBe(true);
  });
});

describe("copy while the sun alert is OFF: no promise of an alert", () => {
  it("paywall row", () => {
    const b = paywallSunBenefit(false);
    expect(b.title).toBe("Sunrise and sunset color, an hour ahead");
    expect(`${b.title} ${b.body}`).not.toMatch(/alert|heads-up|\bAI\b/i);
  });
  it("website app card line", () => {
    expect(inAppSunLine(false)).toBe("See how colorful tonight's sunset will be, an hour ahead");
  });
  it("settings label", () => {
    expect(sunColorAlertLabel(false)).toBe("Sunrise and sunset color");
  });
  it("hides the sun-color toggle but keeps every other alert and group", () => {
    const groups = visibleAlertGroups(ALERT_GROUPS, false);
    expect(groups.flatMap((g) => g.keys)).not.toContain("sun-color");
    expect(groups.flatMap((g) => g.keys)).toContain("coming-up");
    expect(groups.map((g) => g.title)).toEqual(ALERT_GROUPS.map((g) => g.title));
    // The shared group list is not mutated: stored prefs and the key's home are intact.
    expect(ALERT_GROUPS.flatMap((g) => g.keys)).toContain("sun-color");
  });
  it("drops a group that would be left empty", () => {
    expect(visibleAlertGroups([{ title: "Sun", keys: ["sun-color"] }], false)).toEqual([]);
  });
  it("this build (flag off) uses the off copy everywhere", () => {
    expect(ALERT_LABELS["sun-color"]).toBe("Sunrise and sunset color");
    const html = renderToStaticMarkup(createElement(PlusInAppCard));
    expect(html).toContain("See how colorful tonight&#x27;s sunset will be, an hour ahead");
    expect(html).not.toContain("A heads-up before a great sunrise or sunset");
  });
});

describe("copy while the sun alert is ON: the original promise", () => {
  it("paywall row", () => {
    expect(paywallSunBenefit(true)).toEqual({
      icon: "🌅",
      title: "Sunrise and sunset alerts",
      body: "A heads-up when the sky is forecast to be colorful.",
    });
  });
  it("website app card line", () => {
    expect(inAppSunLine(true)).toBe("A heads-up before a great sunrise or sunset");
  });
  it("settings label", () => {
    expect(sunColorAlertLabel(true)).toBe("Great sunrise or sunset coming");
  });
  it("shows every group and the sun-color toggle", () => {
    expect(visibleAlertGroups(ALERT_GROUPS, true)).toEqual(ALERT_GROUPS);
  });
});
