import { describe, it, expect } from "vitest";
import {
  clearField,
  clearPrefsKeys,
  isEmpty,
  isRetryableSaveError,
  mergeHomeSlug,
  mergePrefs,
  mergeProfile,
  type PendingWrites,
} from "@/lib/plus/pendingWrites";
import type { ScoreProfile } from "@/lib/profile/types";

const PROFILE_A: ScoreProfile = { profiles: ["swim"], heat: "normal", crowds: "normal" };
const PROFILE_B: ScoreProfile = { profiles: ["surf"], heat: "hot", crowds: "low" };

describe("mergeProfile / mergeHomeSlug — replace, not merge", () => {
  it("a later profile edit supersedes an earlier unsent one outright", () => {
    let pending: PendingWrites = {};
    pending = mergeProfile(pending, PROFILE_A);
    pending = mergeProfile(pending, PROFILE_B);
    expect(pending.profile).toEqual(PROFILE_B);
  });

  it("a later home pick supersedes an earlier unsent one outright", () => {
    let pending: PendingWrites = {};
    pending = mergeHomeSlug(pending, "delray");
    pending = mergeHomeSlug(pending, "boca-raton");
    expect(pending.homeSlug).toBe("boca-raton");
  });

  it("queuing a profile does not disturb an unrelated pending home", () => {
    let pending: PendingWrites = { homeSlug: "delray" };
    pending = mergeProfile(pending, PROFILE_A);
    expect(pending).toEqual({ homeSlug: "delray", profile: PROFILE_A });
  });
});

describe("mergePrefs — per-key merge, not replace", () => {
  it("toggling two different alerts offline queues both", () => {
    let pending: PendingWrites = {};
    pending = mergePrefs(pending, { lightning: false });
    pending = mergePrefs(pending, { rip: false });
    expect(pending.prefs).toEqual({ lightning: false, rip: false });
  });

  it("a later toggle of the SAME key wins over the earlier one", () => {
    let pending: PendingWrites = {};
    pending = mergePrefs(pending, { lightning: false });
    pending = mergePrefs(pending, { lightning: true });
    expect(pending.prefs).toEqual({ lightning: true });
  });
});

describe("revert-on-prefs-failure composition (what savePrefs does with these)", () => {
  it("a failed toggle folds into whatever prefs were already pending, keyed correctly", () => {
    // Simulates: "rip" already failed once and is queued; the user then
    // toggles "lightning" and that save also fails.
    let pending: PendingWrites = { prefs: { rip: false } };
    pending = mergePrefs(pending, { lightning: true });
    expect(pending.prefs).toEqual({ rip: false, lightning: true });
  });
});

describe("clearField / clearPrefsKeys", () => {
  it("clearField drops one whole kind and leaves the others untouched", () => {
    const pending: PendingWrites = { profile: PROFILE_A, homeSlug: "delray", prefs: { rip: false } };
    expect(clearField(pending, "profile")).toEqual({ homeSlug: "delray", prefs: { rip: false } });
  });

  it("clearPrefsKeys drops only the given keys, keeping the rest queued", () => {
    const pending: PendingWrites = { prefs: { lightning: false, rip: false, morning: true } };
    expect(clearPrefsKeys(pending, ["rip"])).toEqual({ prefs: { lightning: false, morning: true } });
  });

  it("clearPrefsKeys removes the prefs field entirely once it is empty", () => {
    const pending: PendingWrites = { homeSlug: "delray", prefs: { rip: false } };
    expect(clearPrefsKeys(pending, ["rip"])).toEqual({ homeSlug: "delray" });
  });

  it("clearPrefsKeys is a no-op when nothing is pending", () => {
    expect(clearPrefsKeys({}, ["rip"])).toEqual({});
  });
});

describe("isEmpty", () => {
  it("true for nothing pending, false for any one field", () => {
    expect(isEmpty({})).toBe(true);
    expect(isEmpty({ profile: PROFILE_A })).toBe(false);
    expect(isEmpty({ homeSlug: "delray" })).toBe(false);
    expect(isEmpty({ prefs: { rip: false } })).toBe(false);
  });

  it("an empty prefs object still counts as empty", () => {
    expect(isEmpty({ prefs: {} })).toBe(true);
  });
});

describe("isRetryableSaveError", () => {
  it("queues a network failure and a 5xx", () => {
    expect(isRetryableSaveError({ ok: false, error: "network", status: 0 })).toBe(true);
    expect(isRetryableSaveError({ ok: false, error: "server", status: 500 })).toBe(true);
    expect(isRetryableSaveError({ ok: false, error: "server", status: 503 })).toBe(true);
  });

  it("does not queue a rejection — the server has already answered", () => {
    expect(isRetryableSaveError({ ok: false, error: "not-entitled", status: 402 })).toBe(false);
    expect(isRetryableSaveError({ ok: false, error: "bad-request", status: 400 })).toBe(false);
    expect(isRetryableSaveError({ ok: false, error: "not-found", status: 404 })).toBe(false);
  });

  it("a successful result is never retryable", () => {
    expect(isRetryableSaveError({ ok: true, error: null, status: 200 })).toBe(false);
  });
});
