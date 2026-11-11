import { describe, expect, it } from "vitest";
import { CamGrid } from "./CamGrid";

// No React test harness in this repo (see SkyEventsCard.test.ts). CamGrid uses no
// hooks before its empty check, so it can be called as a plain function.
// The conditions build drops offline cams (lib/cams.ts visibleCamViews); a beach
// whose cams are all down then hands CamGrid an empty list, and the page must show
// no cam section at all, not an empty box. ConditionsDashboard also skips the
// section's wrapper when `res.cams` is empty.
describe("CamGrid with every cam hidden", () => {
  it("renders nothing", () => {
    expect(CamGrid({ cams: [], tz: "America/New_York" })).toBeNull();
  });
});
