import { describe, expect, it } from "vitest";
import { alertSaveStatus } from "./saveStatus";

describe("alertSaveStatus", () => {
  it("is idle with nothing going on", () => {
    expect(alertSaveStatus({ inFlight: 0, pendingCount: 0, justSaved: false })).toBe("idle");
  });
  it("shows saving while a save is in flight", () => {
    expect(alertSaveStatus({ inFlight: 1, pendingCount: 0, justSaved: true })).toBe("saving");
  });
  it("shows saved after a save lands", () => {
    expect(alertSaveStatus({ inFlight: 0, pendingCount: 0, justSaved: true })).toBe("saved");
  });
  it("never shows saved while a change is queued for retry", () => {
    expect(alertSaveStatus({ inFlight: 0, pendingCount: 2, justSaved: true })).toBe("retrying");
    expect(alertSaveStatus({ inFlight: 1, pendingCount: 1, justSaved: false })).toBe("retrying");
  });
});
