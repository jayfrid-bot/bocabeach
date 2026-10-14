import { describe, it, expect } from "vitest";
import { legacyDeviceId, redactDeviceId } from "@/lib/db/legacy";

describe("redactDeviceId", () => {
  it("shows a legacy id (which contains the push token) only as a short digest", () => {
    const token = "f".repeat(80);
    const id = legacyDeviceId(token);
    const shown = redactDeviceId(id);
    expect(shown).toMatch(/^legacy:[0-9a-f]{10}$/);
    expect(shown).not.toContain(Buffer.from(token).toString("base64url").slice(0, 12));
    expect(redactDeviceId(id)).toBe(shown); // stable, so log lines can be matched up
    expect(redactDeviceId(legacyDeviceId("g".repeat(80)))).not.toBe(shown);
  });

  it("leaves a real device id alone", () => {
    expect(redactDeviceId("11111111-2222-4333-8444-555555555555")).toBe("11111111-2222-4333-8444-555555555555");
  });
});
