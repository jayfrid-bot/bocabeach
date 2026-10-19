import { describe, expect, it, vi } from "vitest";

describe("track", () => {
  it("never throws and sends nothing while analytics is not running", async () => {
    const capture = vi.fn();
    vi.doMock("posthog-js", () => ({ default: { __loaded: false, capture } }));
    const { track } = await import("./track");
    expect(() => track("cam_open", { cam: "boca-south" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(capture).not.toHaveBeenCalled();
    vi.doUnmock("posthog-js");
  });
});
