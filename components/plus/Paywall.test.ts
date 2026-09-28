import { describe, it, expect } from "vitest";
import { shouldShowCodeEntry, supportId } from "@/components/plus/Paywall";

// Codex round 2 #2 (App Review risk): a code must NEVER appear while store
// billing is available — the App Store is the only checkout there, whatever
// the offers status is this one time. It stays only for builds with no
// billing key at all (dev/e2e). Shared with
// components/plus/PlusSettingsSheet.tsx's own code-entry block.
describe("shouldShowCodeEntry", () => {
  it("hides the code entry whenever billing is available", () => {
    expect(shouldShowCodeEntry(true)).toBe(false);
  });

  it("always shows it when billing is off (dev/e2e builds with no key)", () => {
    expect(shouldShowCodeEntry(false)).toBe(true);
  });
});

// Codex round 2 #1: both the Paywall footer and components/plus/
// PlusSettingsSheet.tsx's Account section show this — a free user (no
// entitlement, so no Settings gear) can only reach the Paywall's copy.
describe("supportId", () => {
  it("is the first 12 characters of the device id (Codex round 3 #1)", () => {
    expect(supportId("11111111-2222-4333-8444-555555555555")).toBe("11111111-222");
  });

  it("is stable — the same device id always yields the same support id", () => {
    const id = "abcdef12-3456-7890-abcd-ef1234567890";
    expect(supportId(id)).toBe(supportId(id));
  });

  it("degrades gracefully for a shorter-than-usual id rather than throwing", () => {
    expect(supportId("abc")).toBe("abc");
  });
});
