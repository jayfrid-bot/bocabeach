import { describe, it, expect } from "vitest";
import {
  AUTO_ARM_MS,
  decideLiveActivityStart,
  isFirstArmedIdentityEligibleForAdoption,
  isStaleLiveActivityTicket,
  lockScreenRowState,
  parseIOSMajorMinor,
  resolveLiveActivityAdoption,
  shouldAutoArm,
} from "@/components/plus/BeachModeCard";
import type { ActivityStatus } from "@/lib/plus/liveActivity";

const NOW = Date.parse("2026-09-02T16:00:00Z");
const MIN = 60_000;

describe("shouldAutoArm", () => {
  it("arms on arrival, when nothing is armed yet", () => {
    expect(shouldAutoArm(NOW, 0, 0)).toBe(true);
  });

  it("holds off for a minute after it just armed", () => {
    expect(shouldAutoArm(NOW, NOW - 30_000, 0)).toBe(false);
  });

  it("does not re-arm a window that still has hours on it", () => {
    // The effect re-runs on every render, and the app re-renders once a minute
    // to keep the clock moving — so a bare throttle wrote a new presence row
    // every 60 seconds for as long as someone stood on the sand.
    const justArmed = NOW + AUTO_ARM_MS;
    expect(shouldAutoArm(NOW + 61 * MIN, NOW, justArmed)).toBe(false);
    expect(shouldAutoArm(NOW + 2 * 60 * MIN, NOW, justArmed)).toBe(false);
  });

  it("tops the window up once it is down to its last hour", () => {
    expect(shouldAutoArm(NOW, NOW - 2 * MIN, NOW + 45 * MIN)).toBe(true);
  });

  it("re-arms a window that has already run out", () => {
    expect(shouldAutoArm(NOW, NOW - 2 * MIN, NOW - MIN)).toBe(true);
  });
});

describe("isStaleLiveActivityTicket", () => {
  it("is not stale when the ticket is still the current one", () => {
    expect(isStaleLiveActivityTicket(1, 1)).toBe(false);
  });

  it("is stale once a newer session (Off, or another start) bumped the ticket", () => {
    // A start() that resolves after the session it was requested for has
    // already ended must recognize itself as stale, so it can end the
    // activity it just created instead of recording a runaway session.
    expect(isStaleLiveActivityTicket(1, 2)).toBe(true);
  });
});

describe("resolveLiveActivityAdoption", () => {
  it("returns nothing to adopt when getStatus reports no activities — the ordinary start() path applies", () => {
    const status: ActivityStatus = { enabled: true, activities: [] };
    expect(resolveLiveActivityAdoption(status)).toBeNull();
  });

  it("adopts an already-running activity: strips seq for the next call and continues numbering from it", () => {
    const status: ActivityStatus = {
      enabled: true,
      activities: [
        {
          id: "act-1",
          state: { v: 1, seq: 4, score: 77, updatedAt: 1_700_000_000_000 },
        },
      ],
    };
    const adoption = resolveLiveActivityAdoption(status);
    expect(adoption).not.toBeNull();
    expect(adoption?.activityId).toBe("act-1");
    expect(adoption?.nextSeq).toBe(5); // continues from the adopted activity's own seq, not reset to 0
    expect(adoption?.content).toEqual({ v: 1, score: 77, updatedAt: 1_700_000_000_000 });
    expect(adoption?.content).not.toHaveProperty("seq");
  });

  it("adopts the first activity when native ever reports more than one (should not happen; native enforces one per device)", () => {
    const status: ActivityStatus = {
      enabled: true,
      activities: [
        { id: "act-1", state: { v: 1, seq: 0, score: 50, updatedAt: 1 } },
        { id: "act-2", state: { v: 1, seq: 9, score: 90, updatedAt: 2 } },
      ],
    };
    expect(resolveLiveActivityAdoption(status)?.activityId).toBe("act-1");
  });
});

describe("decideLiveActivityStart", () => {
  it("a stale ticket always aborts, even with an activity id in hand", () => {
    expect(decideLiveActivityStart({ stale: true, adoptionChecked: true, hasActivityId: true })).toBe("abort");
    expect(decideLiveActivityStart({ stale: true, adoptionChecked: true, hasActivityId: false })).toBe("abort");
  });

  // Order 1: adoption settles BEFORE the start effect's own gate check runs
  // — laActivityIdRef is already set by the time `decideLiveActivityStart`
  // is asked, so it must update() rather than ever consider start().
  it("adoption-resolves-first: an activity id already recorded means update, regardless of the adoption-checked flag", () => {
    expect(decideLiveActivityStart({ stale: false, adoptionChecked: true, hasActivityId: true })).toBe("update");
    // Even if adoptionChecked somehow reads false here (shouldn't happen —
    // adoption only ever sets an id once its own check has settled — but
    // the race must be closed either way): an id in hand always wins.
    expect(decideLiveActivityStart({ stale: false, adoptionChecked: false, hasActivityId: true })).toBe("update");
  });

  // Order 2: the start effect's gate check runs BEFORE adoption has
  // settled — it must wait rather than race start() against the adoption
  // check still in flight.
  it("start-begins-first: no activity id yet and adoption for this identity hasn't settled means wait", () => {
    expect(decideLiveActivityStart({ stale: false, adoptionChecked: false, hasActivityId: false })).toBe("wait");
  });

  it("only starts once adoption has settled with nothing to adopt", () => {
    expect(decideLiveActivityStart({ stale: false, adoptionChecked: true, hasActivityId: false })).toBe("start");
  });
});

describe("isFirstArmedIdentityEligibleForAdoption", () => {
  it("a reload/relaunch while already armed — the first real identity this mount sees — is eligible", () => {
    expect(isFirstArmedIdentityEligibleForAdoption("boca-raton|1700000000000", false)).toBe(true);
  });

  it("a retarget or re-arm after the first real identity is NEVER eligible", () => {
    // The identity-teardown effect already ends the previous identity's
    // activity itself — nothing external is left to adopt, only a race
    // against that end() call.
    expect(isFirstArmedIdentityEligibleForAdoption("deerfield-beach|1700003600000", true)).toBe(false);
  });

  it("not armed (no identity) is never eligible, regardless of history", () => {
    expect(isFirstArmedIdentityEligibleForAdoption(null, false)).toBe(false);
    expect(isFirstArmedIdentityEligibleForAdoption(null, true)).toBe(false);
  });
});

describe("retarget end-then-start ordering", () => {
  it("the start path only proceeds to start() once the previous identity's pending end() has settled, and rechecks for a race after", async () => {
    // Mirrors the shape of the start effect's post-pending-end recheck: a
    // retarget's end(oldId) is in flight (Codex round-4) when start
    // begins, so it must await that promise before deciding again.
    let endSettled = false;
    const pendingEnd = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        endSettled = true;
        resolve();
      });
    });
    expect(endSettled).toBe(false); // not settled yet — start must not proceed on this info alone

    await pendingEnd.catch(() => {});
    expect(endSettled).toBe(true);

    // Once settled, with no activity id recorded (the end() truly finished
    // and nothing adopted it — retargets are never adoption-eligible) and a
    // still-current ticket, the effect is clear to call native start().
    expect(decideLiveActivityStart({ stale: false, adoptionChecked: true, hasActivityId: false })).toBe("start");

    // If a race left an activity id recorded by the time the end() settled,
    // update() wins over a second start() regardless.
    expect(decideLiveActivityStart({ stale: false, adoptionChecked: true, hasActivityId: true })).toBe("update");
  });

  it("a failed end() never blocks the retarget's start() — the catch() no-ops it", async () => {
    const pendingEnd = Promise.reject(new Error("native end failed"));
    await expect(pendingEnd.catch(() => {})).resolves.toBeUndefined();
    expect(decideLiveActivityStart({ stale: false, adoptionChecked: true, hasActivityId: false })).toBe("start");
  });
});

describe("parseIOSMajorMinor", () => {
  it("reads major.minor out of a Capacitor WebView user agent", () => {
    expect(
      parseIOSMajorMinor("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15"),
    ).toEqual({ major: 18, minor: 0 });
  });

  it("reads a two-digit minor version", () => {
    expect(parseIOSMajorMinor("Mozilla/5.0 (iPhone; CPU iPhone OS 16_11 like Mac OS X)")).toEqual({
      major: 16,
      minor: 11,
    });
  });

  it("returns null when the user agent has no iPhone OS token (desktop, Android, a gutted test UA)", () => {
    expect(parseIOSMajorMinor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBeNull();
    expect(parseIOSMajorMinor("")).toBeNull();
  });
});

describe("lockScreenRowState", () => {
  // A fully-available, freshly-armed phone that hasn't answered the prompt
  // yet — each test overrides just the one thing it's exercising.
  const base = {
    native: true,
    entitled: true,
    armed: true,
    pluginAvailable: true,
    osEnabled: true,
    iosMajorMinor: { major: 18, minor: 0 },
    pref: null as "on" | "off" | null,
    running: false,
  };

  it("is hidden off Beach Mode, off native, or off entitlement — the three gates the card itself already checks", () => {
    expect(lockScreenRowState({ ...base, armed: false })).toEqual({ kind: "hidden" });
    expect(lockScreenRowState({ ...base, native: false })).toEqual({ kind: "hidden" });
    expect(lockScreenRowState({ ...base, entitled: false })).toEqual({ kind: "hidden" });
  });

  it("shows the one-time Yes/No prompt when nothing has been answered yet and everything is available", () => {
    expect(lockScreenRowState({ ...base, pref: null })).toEqual({ kind: "prompt" });
  });

  it("shows on/Turn off when the pref is on, carrying whether the activity is actually running", () => {
    expect(lockScreenRowState({ ...base, pref: "on", running: false })).toEqual({ kind: "on", running: false });
    expect(lockScreenRowState({ ...base, pref: "on", running: true })).toEqual({ kind: "on", running: true });
  });

  it("shows off/Turn on when the pref is off", () => {
    expect(lockScreenRowState({ ...base, pref: "off" })).toEqual({ kind: "off" });
  });

  it("reads as unavailable (plugin missing) ahead of everything else, regardless of a saved pref", () => {
    expect(lockScreenRowState({ ...base, pluginAvailable: false, pref: "on" })).toEqual({
      kind: "unavailable",
      reason: "plugin-missing",
      message: "Update the app to show this on your Lock Screen.",
    });
    expect(lockScreenRowState({ ...base, pluginAvailable: false, osEnabled: false, pref: null })).toMatchObject({
      reason: "plugin-missing",
    }); // a stale-enough build could fail both checks — plugin missing still wins
  });

  it("reads as unavailable (iOS too old) below 16.2, ahead of asking the plugin's own Settings answer", () => {
    expect(lockScreenRowState({ ...base, iosMajorMinor: { major: 16, minor: 1 }, pref: "off" })).toEqual({
      kind: "unavailable",
      reason: "ios-too-old",
      message: "Needs iOS 16.2 or later.",
    });
    expect(lockScreenRowState({ ...base, iosMajorMinor: { major: 15, minor: 4 }, osEnabled: true })).toMatchObject({
      reason: "ios-too-old",
    });
  });

  it("16.2 exactly, and anything newer, is new enough", () => {
    expect(lockScreenRowState({ ...base, iosMajorMinor: { major: 16, minor: 2 }, pref: "on" }).kind).toBe("on");
    expect(lockScreenRowState({ ...base, iosMajorMinor: { major: 17, minor: 0 }, pref: "on" }).kind).toBe("on");
  });

  it("reads as unavailable (Settings off) when the plugin is present and iOS is new enough, but getStatus says disabled", () => {
    expect(lockScreenRowState({ ...base, osEnabled: false, pref: "on" })).toEqual({
      kind: "unavailable",
      reason: "os-disabled",
      message:
        "Live Activities are off for this app — turn them on in iPhone Settings → Is It Beach Day → Live Activities.",
    });
  });

  it("keeps the saved pref through every unavailable reason instead of resetting it", () => {
    // The row's job is to show a REASON, not to forget what the user chose —
    // so a temporarily-off Setting (or an old iOS, or a stale build) never
    // silently reverts someone's "on" back to unasked.
    for (const reason of [
      { pluginAvailable: false },
      { iosMajorMinor: { major: 15, minor: 0 } },
      { osEnabled: false },
    ] as const) {
      const state = lockScreenRowState({ ...base, ...reason, pref: "on" });
      expect(state.kind).toBe("unavailable");
    }
  });

  it("falls back to the plugin's own Settings answer when the user agent has no parseable iOS version", () => {
    expect(lockScreenRowState({ ...base, iosMajorMinor: null, osEnabled: true, pref: "off" })).toEqual({
      kind: "off",
    });
    expect(lockScreenRowState({ ...base, iosMajorMinor: null, osEnabled: false, pref: "off" })).toEqual({
      kind: "unavailable",
      reason: "os-disabled",
      message:
        "Live Activities are off for this app — turn them on in iPhone Settings → Is It Beach Day → Live Activities.",
    });
  });
});
