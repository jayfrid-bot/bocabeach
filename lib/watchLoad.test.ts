import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "@/lib/__fixtures__/boca-2026-09-04-phantom-rain.json";
import type { ConditionsResponse } from "@/lib/types";

vi.mock("@/lib/conditions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/conditions")>();
  return { ...actual, getConditions: vi.fn() };
});

import { getConditions } from "@/lib/conditions";
import { isValidSlug, loadWatchView, secondsValid, viewCacheControl, viewsCacheControl } from "@/lib/watchLoad";

afterEach(() => vi.mocked(getConditions).mockReset());
const copy = () => JSON.parse(JSON.stringify(fixture)) as ConditionsResponse;

describe("loadWatchView", () => {
  it("builds the view, strips internal snapshot fields first", async () => {
    const data = copy();
    (data.snapshot as unknown as Record<string, unknown>).skyAlertCandidates = [{ secret: true }];
    vi.mocked(getConditions).mockResolvedValue(data);
    const r = await loadWatchView("boca-raton");
    expect(r.status).toBe("ok");
    expect(JSON.stringify(r)).not.toContain("secret");
  });
  it("reports not_found and incomplete", async () => {
    vi.mocked(getConditions).mockResolvedValue(null);
    expect((await loadWatchView("nope")).status).toBe("not_found");
    vi.mocked(getConditions).mockResolvedValue({ ...copy(), budgetAborted: true });
    expect((await loadWatchView("boca-raton")).status).toBe("incomplete");
  });
  it("never asks the pipeline about a malformed slug", async () => {
    expect((await loadWatchView("../etc")).status).toBe("not_found");
    expect(getConditions).not.toHaveBeenCalled();
  });
});

describe("slug and cache helpers", () => {
  it("validates slugs", () => {
    expect(isValidSlug("boca-raton")).toBe(true);
    for (const bad of ["", "Boca", "a--b", "-a", "a-", "a b", "x".repeat(65)]) expect(isValidSlug(bad), bad).toBe(false);
  });
  it("takes the shortest cache time across views", () => {
    const a = { capturedAt: "2026-10-14T15:00:00Z", validUntil: "2026-10-14T15:05:00Z" };
    const b = { capturedAt: "2026-10-14T15:00:00Z", validUntil: "2026-10-14T15:00:20Z" };
    expect(secondsValid(b)).toBe(20);
    expect(viewCacheControl(a)).toBe("public, s-maxage=60");
    expect(viewsCacheControl([a, b])).toBe("public, s-maxage=20");
    expect(viewsCacheControl([a, { capturedAt: a.capturedAt, validUntil: a.capturedAt }])).toBe("no-store");
    expect(viewsCacheControl([])).toBe("no-store");
  });
});
