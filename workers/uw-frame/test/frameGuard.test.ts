import { describe, expect, it } from "vitest";
import { shouldReplaceStoredFrame } from "../src/lib/frameGuard";

describe("shouldReplaceStoredFrame", () => {
  it("allows the write when nothing is stored yet", () => {
    expect(shouldReplaceStoredFrame(null, "2026-09-14T15:00:00Z")).toBe(true);
    expect(shouldReplaceStoredFrame(undefined, "2026-09-14T15:00:00Z")).toBe(true);
  });

  it("allows the write when the stored frame is not ok, regardless of timestamps", () => {
    const stored = { ok: false, grabbedAtUtc: "2026-09-14T16:00:00Z" }; // "newer" but bad
    expect(shouldReplaceStoredFrame(stored, "2026-09-14T15:00:00Z")).toBe(true);
  });

  it("rejects the write when the stored frame is ok and strictly newer", () => {
    const stored = { ok: true, grabbedAtUtc: "2026-09-14T15:07:00Z" };
    expect(shouldReplaceStoredFrame(stored, "2026-09-14T15:00:00Z")).toBe(false);
  });

  it("allows the write when the candidate is newer than a good stored frame", () => {
    const stored = { ok: true, grabbedAtUtc: "2026-09-14T14:00:00Z" };
    expect(shouldReplaceStoredFrame(stored, "2026-09-14T15:00:00Z")).toBe(true);
  });

  it("allows the write when the candidate is the same age as a good stored frame", () => {
    const stored = { ok: true, grabbedAtUtc: "2026-09-14T15:00:00Z" };
    expect(shouldReplaceStoredFrame(stored, "2026-09-14T15:00:00Z")).toBe(true);
  });

  it("fails open when the stored timestamp doesn't parse", () => {
    const stored = { ok: true, grabbedAtUtc: "not-a-date" };
    expect(shouldReplaceStoredFrame(stored, "2026-09-14T15:00:00Z")).toBe(true);
  });

  it("fails open when the candidate timestamp doesn't parse", () => {
    const stored = { ok: true, grabbedAtUtc: "2026-09-14T15:00:00Z" };
    expect(shouldReplaceStoredFrame(stored, "not-a-date")).toBe(true);
  });

  it("protects a newer courier frame from a browser tick that started earlier", () => {
    // Courier uploaded 15:07 (ok:true). A slow browser tick that STARTED at
    // 15:05 and only finishes writing at 15:08 still carries its own
    // grabbedAtUtc of 15:05 (captured when the tick began) — older than the
    // courier's 15:07 — so it must not overwrite the courier's frame.
    const stored = { ok: true, grabbedAtUtc: "2026-09-14T15:07:00Z" };
    expect(shouldReplaceStoredFrame(stored, "2026-09-14T15:05:00Z")).toBe(false);
  });
});
