import { describe, it, expect } from "vitest";
import { shouldReload } from "@/lib/useReloadOnNewVersion";

describe("shouldReload", () => {
  it("reloads when the served SHA differs from the baked one", () => {
    expect(shouldReload("abc123", "def456", null)).toBe(true);
  });

  it("does not reload when the served SHA matches the baked one", () => {
    expect(shouldReload("abc123", "abc123", null)).toBe(false);
  });

  it("does not reload when nothing was served (empty string, null, undefined)", () => {
    expect(shouldReload("abc123", "", null)).toBe(false);
    expect(shouldReload("abc123", null, null)).toBe(false);
    expect(shouldReload("abc123", undefined, null)).toBe(false);
  });

  it("never reloads a local dev build, even with a different served SHA", () => {
    expect(shouldReload("dev", "def456", null)).toBe(false);
  });

  it("does not reload twice for the same already-tried target SHA (loop guard)", () => {
    expect(shouldReload("abc123", "def456", "def456")).toBe(false);
  });

  it("reloads again for a NEW target SHA after already trying a different one", () => {
    expect(shouldReload("abc123", "ghi789", "def456")).toBe(true);
  });
});
