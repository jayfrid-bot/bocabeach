import { describe, expect, it } from "vitest";
import {
  BUILD_RELOAD_GAP_MS,
  BUILD_RELOAD_WINDOW_MS,
  SAVED_NOTE_AFTER_MS,
  formatSavedAt,
  optOutState,
  savedAtFromServerTiming,
  shouldApplyFresh,
  shouldReloadForNewBuild,
  showSavedNote,
  swDecision,
} from "@/lib/swClient";

const WEB_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";
const APP_UA = `${WEB_UA} IsItBeachDayApp/ios`;
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile IsItBeachDayApp/android";

describe("swDecision", () => {
  it("runs the worker in a production browser", () => {
    expect(swDecision({ production: true, userAgent: WEB_UA, optedOut: false })).toBe("register");
  });
  it("removes it in dev, in both native shells, and after an opt-out", () => {
    expect(swDecision({ production: false, userAgent: WEB_UA, optedOut: false })).toBe("remove");
    expect(swDecision({ production: true, userAgent: APP_UA, optedOut: false })).toBe("remove");
    expect(swDecision({ production: true, userAgent: ANDROID_UA, optedOut: false })).toBe("remove");
    expect(swDecision({ production: true, userAgent: WEB_UA, optedOut: true })).toBe("remove");
  });
});

describe("optOutState", () => {
  it("?nosw=1 opts out and sticks; ?sw=on undoes it; stored 'off' holds", () => {
    expect(optOutState("?nosw=1", null)).toEqual({ optedOut: true, store: "off" });
    expect(optOutState("?nosw", null)).toEqual({ optedOut: true, store: "off" });
    expect(optOutState("?sw=on", "off")).toEqual({ optedOut: false, store: "clear" });
    expect(optOutState("", "off")).toEqual({ optedOut: true, store: null });
    expect(optOutState("", null)).toEqual({ optedOut: false, store: null });
    expect(optOutState("?ref=tag", null)).toEqual({ optedOut: false, store: null });
  });
});

describe("saved-copy note", () => {
  it("reads the worker's Server-Timing stamp and ignores everything else", () => {
    expect(savedAtFromServerTiming([{ name: "ibd-sw", description: "1760800000000" }])).toBe(1760800000000);
    expect(savedAtFromServerTiming([{ name: "cfRequestDuration", description: "12" }])).toBeNull();
    expect(savedAtFromServerTiming([{ name: "ibd-sw", description: "nope" }])).toBeNull();
    expect(savedAtFromServerTiming([])).toBeNull();
  });
  it("shows only for copies older than 30 minutes", () => {
    const now = 2_000_000_000_000;
    expect(showSavedNote(null, now)).toBe(false);
    expect(showSavedNote(now - SAVED_NOTE_AFTER_MS + 1000, now)).toBe(false);
    expect(showSavedNote(now - SAVED_NOTE_AFTER_MS - 1000, now)).toBe(true);
  });
  it("formats the time, with the weekday only for another day", () => {
    const now = new Date(2026, 9, 18, 15, 0).getTime();
    const same = formatSavedAt(new Date(2026, 9, 18, 9, 5).getTime(), now, "en-US");
    expect(same).toBe("9:05 AM");
    const other = formatSavedAt(new Date(2026, 9, 16, 9, 5).getTime(), now, "en-US");
    expect(other).toMatch(/^Fri/);
  });
});

describe("shouldApplyFresh", () => {
  const msg = (over: Record<string, unknown> = {}) => ({
    type: "ibd-fresh",
    kind: "conditions",
    slug: "boca-raton",
    data: { snapshot: { generatedAt: "2026-10-18T10:05:00Z" } },
    ...over,
  });
  it("applies a newer snapshot for this beach", () => {
    expect(shouldApplyFresh(msg(), "boca-raton", "2026-10-18T10:00:00Z")).not.toBeNull();
    expect(shouldApplyFresh(msg(), "boca-raton", "2026-10-18T10:05:00Z")).not.toBeNull(); // same time: other fields may differ
  });
  it("ignores other beaches, older data, missing data and other message types", () => {
    expect(shouldApplyFresh(msg({ slug: "jupiter" }), "boca-raton", "2026-10-18T10:00:00Z")).toBeNull();
    expect(shouldApplyFresh(msg(), "boca-raton", "2026-10-18T11:00:00Z")).toBeNull();
    expect(shouldApplyFresh(msg({ data: undefined }), "boca-raton", "2026-10-18T10:00:00Z")).toBeNull();
    expect(shouldApplyFresh(msg({ data: { snapshot: {} } }), "boca-raton", "2026-10-18T10:00:00Z")).toBeNull();
    expect(shouldApplyFresh(msg({ type: "ibd-fresh-failed" }), "boca-raton", "2026-10-18T10:00:00Z")).toBeNull();
    expect(shouldApplyFresh(null, "boca-raton", "2026-10-18T10:00:00Z")).toBeNull();
  });
});

describe("shouldReloadForNewBuild", () => {
  const base = { now: 100_000, openedAt: 95_000, interacted: false, dialogOpen: false, held: false, lastReloadAt: null };
  it("reloads an untouched page that just opened", () => {
    expect(shouldReloadForNewBuild(base)).toBe(true);
  });
  it("never when the reader touched the page, a dialog is open, or a purchase is in flight", () => {
    expect(shouldReloadForNewBuild({ ...base, interacted: true })).toBe(false);
    expect(shouldReloadForNewBuild({ ...base, dialogOpen: true })).toBe(false);
    expect(shouldReloadForNewBuild({ ...base, held: true })).toBe(false);
  });
  it("not late in the visit, and not twice in a row", () => {
    expect(shouldReloadForNewBuild({ ...base, openedAt: base.now - BUILD_RELOAD_WINDOW_MS - 1 })).toBe(false);
    expect(shouldReloadForNewBuild({ ...base, lastReloadAt: base.now - BUILD_RELOAD_GAP_MS + 1 })).toBe(false);
    expect(shouldReloadForNewBuild({ ...base, lastReloadAt: base.now - BUILD_RELOAD_GAP_MS - 1 })).toBe(true);
  });
});
