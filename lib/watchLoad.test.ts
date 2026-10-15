import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "@/lib/__fixtures__/boca-2026-09-04-phantom-rain.json";
import type { ConditionsResponse } from "@/lib/types";

vi.mock("@/lib/watchViewCache", () => ({ peekWatchView: vi.fn(), storeWatchView: vi.fn(async () => true) }));

vi.mock("@/lib/quality/overrides", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/quality/overrides")>();
  return { ...actual, overridesVersion: vi.fn(async () => "0") };
});

vi.mock("@/lib/conditions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/conditions")>();
  return { ...actual, getConditions: vi.fn() };
});

import { getConditions } from "@/lib/conditions";
import { peekWatchView, storeWatchView } from "@/lib/watchViewCache";
import { overridesVersion } from "@/lib/quality/overrides";
import { isValidSlug, loadWatchView, secondsValid, viewCacheControl } from "@/lib/watchLoad";

afterEach(() => {
  vi.mocked(getConditions).mockReset();
  vi.mocked(peekWatchView).mockReset();
  vi.mocked(storeWatchView).mockClear();
  vi.useRealTimers();
});
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

describe("loadWatchView remembers what it builds", () => {
  it("stores every successful view, once", async () => {
    vi.mocked(getConditions).mockResolvedValue(copy());
    const r = await loadWatchView("boca-raton");
    expect(r.status).toBe("ok");
    expect(storeWatchView).toHaveBeenCalledTimes(1);
    expect(vi.mocked(storeWatchView).mock.calls[0][0]).toEqual(r.status === "ok" ? r.view : null);
    // Stored under the owner-override fingerprint.
    expect(vi.mocked(storeWatchView).mock.calls[0][1]).toBe("0");
  });
  it("stores nothing for a partial build, an unknown beach or a bad slug", async () => {
    vi.mocked(getConditions).mockResolvedValue({ ...copy(), budgetAborted: true });
    expect((await loadWatchView("boca-raton")).status).toBe("incomplete");
    vi.mocked(getConditions).mockResolvedValue(null);
    expect((await loadWatchView("nope")).status).toBe("not_found");
    expect((await loadWatchView("../x")).status).toBe("not_found");
    expect(storeWatchView).not.toHaveBeenCalled();
  });
});

describe("recent-view identity includes the owner-override fingerprint", () => {
  it("uses the fingerprint the conditions cache key uses, for both the read and the write", async () => {
    vi.mocked(overridesVersion).mockResolvedValue("3.17"); // boca-raton has cams
    vi.mocked(peekWatchView).mockResolvedValue(null);
    await loadWatchView("boca-raton", { cacheOnly: true });
    expect(peekWatchView).toHaveBeenCalledWith("boca-raton", "3.17");
    vi.mocked(getConditions).mockResolvedValue(copy());
    await loadWatchView("boca-raton");
    expect(vi.mocked(storeWatchView).mock.calls[0][1]).toBe("3.17");
    vi.mocked(overridesVersion).mockResolvedValue("0");
  });
  it("is just '0' for a beach with no cams (no database read)", async () => {
    vi.mocked(overridesVersion).mockClear();
    vi.mocked(peekWatchView).mockResolvedValue(null);
    await loadWatchView("miami-beach", { cacheOnly: true });
    expect(peekWatchView).toHaveBeenCalledWith("miami-beach", "0");
    expect(overridesVersion).not.toHaveBeenCalled();
  });
});

describe("loadWatchView with cacheOnly", () => {
  const stored = async () => {
    vi.mocked(getConditions).mockResolvedValue(copy());
    const r = await loadWatchView("boca-raton");
    vi.mocked(getConditions).mockClear();
    vi.mocked(storeWatchView).mockClear();
    return r.status === "ok" ? r.view : null;
  };
  it("returns a stored view and never builds or writes", async () => {
    const view = await stored();
    vi.mocked(peekWatchView).mockResolvedValue(view);
    const r = await loadWatchView("boca-raton", { cacheOnly: true });
    expect(r).toEqual({ status: "ok", view });
    expect(peekWatchView).toHaveBeenCalledWith("boca-raton", "0");
    expect(getConditions).not.toHaveBeenCalled();
    expect(storeWatchView).not.toHaveBeenCalled();
  });
  it("reports not_cached on a miss, and still never builds or writes", async () => {
    vi.mocked(peekWatchView).mockResolvedValue(null);
    expect((await loadWatchView("boca-raton", { cacheOnly: true })).status).toBe("not_cached");
    expect(getConditions).not.toHaveBeenCalled();
    expect(storeWatchView).not.toHaveBeenCalled();
  });
  it("refuses a malformed slug without touching the cache", async () => {
    expect((await loadWatchView("../x", { cacheOnly: true })).status).toBe("not_found");
    expect(peekWatchView).not.toHaveBeenCalled();
  });
});

describe("slug and cache helpers", () => {
  it("validates slugs", () => {
    expect(isValidSlug("boca-raton")).toBe(true);
    for (const bad of ["", "Boca", "a--b", "-a", "a-", "a b", "x".repeat(65)]) expect(isValidSlug(bad), bad).toBe(false);
  });
  it("computes cache time from the clock at the moment of the call, not from when the view was captured", () => {
    const v = { validUntil: "2026-10-14T15:05:00Z" };
    const t = (iso: string) => Date.parse(iso);
    expect(secondsValid(v, t("2026-10-14T15:04:40Z"))).toBe(20);
    expect(viewCacheControl(v, t("2026-10-14T15:00:00Z"))).toBe("public, s-maxage=60");
    expect(viewCacheControl(v, t("2026-10-14T15:04:40Z"))).toBe("public, s-maxage=20");
    expect(viewCacheControl(v, t("2026-10-14T15:04:59Z"))).toBe("public, s-maxage=1");
    expect(viewCacheControl(v, t("2026-10-14T15:05:00Z"))).toBe("no-store");
    expect(viewCacheControl(v, t("2026-10-14T16:00:00Z"))).toBe("no-store");
    expect(viewCacheControl({ validUntil: "nonsense" }, 0)).toBe("no-store");
  });
});
