// An owner's seaweed answer must show on the beach card on the next request, not after the
// 120-second conditions cache expires. The cache key includes the fingerprint of the verdicts in
// force (lib/quality/overrides.ts overridesVersion), so a new verdict means a new key, which means
// a fresh build. `next/cache`'s unstable_cache is faked with the same keyed-store contract.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ctl = vi.hoisted(() => ({ store: new Map<string, unknown>(), builds: 0, version: "0", versionCalls: [] as string[], revalidate: {} as Record<string, number> }));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...a: unknown[]) => Promise<unknown>, keyParts: string[], opts?: { revalidate?: number }) => {
    const key = keyParts.join(":");
    if (opts?.revalidate !== undefined) ctl.revalidate[key] = opts.revalidate;
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
import { conditionsCacheKey, getConditions } from "@/lib/conditions";

const originalFetch = globalThis.fetch;
beforeEach(() => {
  ctl.store.clear();
  ctl.builds = 0;
  ctl.version = "0";
  ctl.versionCalls = [];
  ctl.revalidate = {};
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
    const run = (version: string) =>
      runWithBudget(new SubrequestBudget(500), () => getConditions("boca-raton", { fingerprint: { version, reliable: true } }));
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

describe("an unreliable fingerprint (the override lookup failed)", () => {
  const run = (fingerprint: { version: string; reliable: boolean }) =>
    runWithBudget(new SubrequestBudget(500), () => getConditions("boca-raton", { fingerprint }));

  it("has its own cache key, never the real one", () => {
    expect(conditionsCacheKey("boca-raton", { version: "0", reliable: true })).toEqual(["conditions", "boca-raton"]);
    expect(conditionsCacheKey("boca-raton", { version: "3.9", reliable: true })).toEqual(["conditions", "boca-raton", "ov-3.9"]);
    expect(conditionsCacheKey("boca-raton", { version: "0", reliable: false })).toEqual(["conditions", "boca-raton", "unreliable"]);
    expect(conditionsCacheKey("boca-raton", { version: "3.9", reliable: false })).toEqual(["conditions", "boca-raton", "unreliable"]);
  });

  it("never reads or writes the real entry, and a later reliable read uses the real key", async () => {
    // A real, pre-correction entry is sitting under the normal key.
    await run({ version: "0", reliable: true });
    expect(ctl.builds).toBe(1);
    expect([...ctl.store.keys()]).toEqual(["conditions:boca-raton"]);
    const realEntry = ctl.store.get("conditions:boca-raton");
    // The lookup fails: it must NOT be served that entry. It builds under its own key instead.
    await run({ version: "0", reliable: false });
    expect(ctl.builds).toBe(2);
    expect([...ctl.store.keys()].sort()).toEqual(["conditions:boca-raton", "conditions:boca-raton:unreliable"]);
    expect(ctl.store.get("conditions:boca-raton")).toBe(realEntry); // untouched
    // The unreliable result is reused by the next unreliable call (short-lived key), not rebuilt.
    await run({ version: "0", reliable: false });
    expect(ctl.builds).toBe(2);
    // Healthy again: the real key serves, with no rebuild.
    await run({ version: "0", reliable: true });
    expect(ctl.builds).toBe(2);
    expect(ctl.store.get("conditions:boca-raton")).toBe(realEntry);
  });

  it("does not store a build under the real key when the real key was empty", async () => {
    await run({ version: "0", reliable: false });
    expect([...ctl.store.keys()]).toEqual(["conditions:boca-raton:unreliable"]);
    await run({ version: "0", reliable: true });
    expect(ctl.builds).toBe(2); // the healthy request builds its own, real entry
    expect([...ctl.store.keys()].sort()).toEqual(["conditions:boca-raton", "conditions:boca-raton:unreliable"]);
  });

  it("revalidates in 30 s, the real entry in 120 s", async () => {
    await run({ version: "0", reliable: false });
    await run({ version: "0", reliable: true });
    expect(ctl.revalidate["conditions:boca-raton:unreliable"]).toBe(30);
    expect(ctl.revalidate["conditions:boca-raton"]).toBe(120);
  });

  it("a caller that passes nothing gets the fingerprint read once inside", async () => {
    ctl.version = "4.4";
    await runWithBudget(new SubrequestBudget(500), () => getConditions("boca-raton"));
    expect(ctl.versionCalls).toEqual(["boca-raton"]);
    expect([...ctl.store.keys()]).toEqual(["conditions:boca-raton:ov-4.4"]);
  });
});
