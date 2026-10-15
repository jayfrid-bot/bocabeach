// An owner's seaweed answer must show on the beach card on the next request, not after the
// 120-second conditions cache expires. The cache key includes the fingerprint of the verdicts in
// force (lib/quality/overrides.ts overridesVersion), so a new verdict means a new key, which means
// a fresh build. `next/cache`'s unstable_cache is faked with the same keyed-store contract.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ctl = vi.hoisted(() => ({ store: new Map<string, unknown>(), builds: 0, version: "0", versionCalls: [] as string[] }));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...a: unknown[]) => Promise<unknown>, keyParts: string[]) => {
    const key = keyParts.join(":");
    return async (...args: unknown[]) => {
      if (ctl.store.has(key)) return ctl.store.get(key);
      ctl.builds += 1;
      const result = await fn(...args);
      ctl.store.set(key, result);
      return result;
    };
  },
}));
vi.mock("@/lib/quality/overrides", () => ({
  loadSeaweedOverrides: async () => [],
  overridesFingerprint: async (slug: string) => {
    ctl.versionCalls.push(slug);
    return { version: ctl.version, reliable: true };
  },
}));

import { SubrequestBudget, runWithBudget } from "@/lib/alerts/budget";
import { getConditions } from "@/lib/conditions";

const originalFetch = globalThis.fetch;
beforeEach(() => {
  ctl.store.clear();
  ctl.builds = 0;
  ctl.version = "0";
  ctl.versionCalls = [];
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const get = (slug: string) => runWithBudget(new SubrequestBudget(500), () => getConditions(slug));

describe("the conditions cache key and the owner's verdicts", () => {
  it("with no verdicts the key is exactly what it always was, and a second request is served from cache", async () => {
    await get("boca-raton");
    await get("boca-raton");
    expect(ctl.builds).toBe(1);
    expect([...ctl.store.keys()]).toEqual(["conditions:boca-raton"]);
  });

  it("a new verdict changes the key, so the NEXT request builds a fresh snapshot instead of serving the stale one", async () => {
    await get("boca-raton");
    expect(ctl.builds).toBe(1);
    ctl.version = "1.17"; // the owner just tapped
    await get("boca-raton");
    expect(ctl.builds).toBe(2);
    expect([...ctl.store.keys()].sort()).toEqual(["conditions:boca-raton", "conditions:boca-raton:ov-1.17"]);
    await get("boca-raton"); // and that new snapshot is itself cached
    expect(ctl.builds).toBe(2);
  });

  it("each later change (a second tap, a verdict ending) builds again", async () => {
    ctl.version = "1.17";
    await get("boca-raton");
    ctl.version = "2.18";
    await get("boca-raton");
    ctl.version = "0"; // the day ended
    await get("boca-raton");
    expect(ctl.builds).toBe(3);
  });

  it("only a beach with cams asks for the fingerprint: a cam-less beach never pays for the lookup", async () => {
    await get("boca-raton");
    expect(ctl.versionCalls).toEqual(["boca-raton"]);
    ctl.versionCalls = [];
    const { listLocations } = await import("@/config/locations");
    const camless = listLocations().find((l) => !l.cams?.length);
    if (camless) {
      await get(camless.slug);
      expect(ctl.versionCalls).toEqual([]);
    }
  });
});

describe("a caller that already read the fingerprint hands it in", () => {
  it("getConditions uses it for the cache key and does not read it again", async () => {
    const run = (ov: string) => runWithBudget(new SubrequestBudget(500), () => getConditions("boca-raton", { ovVersion: ov }));
    ctl.version = "9.9"; // what a second, independent read would have said
    await run("0");
    expect(ctl.versionCalls).toEqual([]);
    expect(ctl.builds).toBe(1);
    await run("0");
    expect(ctl.builds).toBe(1); // same key, cached
    await run("2.5");
    expect(ctl.builds).toBe(2); // a different fingerprint is a different key
  });
});
