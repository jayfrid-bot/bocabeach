import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The suite runs under environment: "node" — there is no `window`. Every
// export in lib/plus/liveActivity.ts resolves its plugin off `window.Capacitor`
// (never the module-scope import path, since this is a local, non-npm
// plugin), so installing a fake one here exercises the real bridge path.

function installBridge(plugin: Record<string, unknown> | undefined, isPluginAvailable = true) {
  (globalThis as { window?: unknown }).window = {
    Capacitor: {
      isPluginAvailable: (n: string) => (n === "BeachSessionActivity" ? isPluginAvailable : false),
      Plugins: plugin ? { BeachSessionActivity: plugin } : {},
    },
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.resetModules();
});

const wireState = () => ({
  v: 1,
  seq: 0,
  score: 84,
  updatedAt: Date.now(),
});

describe("off-native / unavailable", () => {
  beforeEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("isAvailable() is false with no window", async () => {
    const mod = await import("@/lib/plus/liveActivity");
    expect(mod.isAvailable()).toBe(false);
  });

  it("start/update/end resolve {ok:false} instead of throwing", async () => {
    const mod = await import("@/lib/plus/liveActivity");
    const s = await mod.start(
      { beachName: "South Beach", slug: "south-beach", sessionStart: Date.now() },
      wireState(),
      "device-1",
    );
    expect(s.ok).toBe(false);
    const u = await mod.update("act-1", wireState());
    expect(u.ok).toBe(false);
    const e = await mod.end("act-1", { dismissal: "immediate" });
    expect(e.ok).toBe(false);
  });

  it("getStatus() degrades to disabled/no activities", async () => {
    const mod = await import("@/lib/plus/liveActivity");
    expect(await mod.getStatus()).toEqual({ enabled: false, activities: [] });
  });

  it("listener subscribers return a no-op unsubscribe", async () => {
    const mod = await import("@/lib/plus/liveActivity");
    const unsub = mod.onPushToken(() => {});
    expect(() => unsub()).not.toThrow();
  });
});

describe("plugin registered but isPluginAvailable() says no", () => {
  it("treats it as unavailable", async () => {
    installBridge({ start: vi.fn() }, false);
    const mod = await import("@/lib/plus/liveActivity");
    expect(mod.isAvailable()).toBe(false);
  });
});

/** A minimal in-memory Storage, so tests can give lib/plus/storage.ts a real
 *  install token to read (environment: "node" has no `localStorage` — see
 *  the file header — so this stands in for it). */
function installFakeLocalStorage(entries: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(entries));
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("native bridge present", () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("start() forwards to the plugin and returns its result", async () => {
    const start = vi.fn().mockResolvedValue({ ok: true, activityId: "act-1" });
    installBridge({ start });
    installFakeLocalStorage({ "bd:install-token": "tok-abc" });
    const mod = await import("@/lib/plus/liveActivity");
    expect(mod.isAvailable()).toBe(true);
    const attrs = { beachName: "South Beach", slug: "south-beach", sessionStart: 123 };
    const state = wireState();
    const res = await mod.start(attrs, state, "device-1", "42");
    expect(res).toEqual({ ok: true, activityId: "act-1" });
    expect(start).toHaveBeenCalledWith({
      attributes: attrs,
      state,
      deviceId: "device-1",
      installToken: "tok-abc",
      appBuild: "42",
    });
  });

  it("start() never calls the plugin with a null install token (round-2 #1d) — fails soft instead", async () => {
    const start = vi.fn().mockResolvedValue({ ok: true, activityId: "act-1" });
    installBridge({ start });
    // No fake localStorage installed → readInstallToken() is null, same as
    // a phone that hasn't been issued one yet (or lost it).
    const mod = await import("@/lib/plus/liveActivity");
    const attrs = { beachName: "South Beach", slug: "south-beach", sessionStart: 123 };
    const res = await mod.start(attrs, wireState(), "device-1", "42");
    expect(res.ok).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it("update()/end() forward and never throw when the plugin call rejects", async () => {
    const update = vi.fn().mockRejectedValue(new Error("bridge boom"));
    const end = vi.fn().mockRejectedValue(new Error("bridge boom"));
    installBridge({ update, end });
    const mod = await import("@/lib/plus/liveActivity");
    const u = await mod.update("act-1", wireState());
    expect(u).toEqual({ ok: false, reason: "bridge boom" });
    const e = await mod.end("act-1", { dismissal: "default" });
    expect(e).toEqual({ ok: false, reason: "bridge boom" });
  });

  it("getStatus() returns the plugin's real answer", async () => {
    const getStatus = vi.fn().mockResolvedValue({ enabled: true, activities: [{ id: "act-1", state: wireState() }] });
    installBridge({ getStatus });
    const mod = await import("@/lib/plus/liveActivity");
    const status = await mod.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.activities).toHaveLength(1);
  });

  it("onActivityState() subscribes and its unsubscribe calls remove()", async () => {
    const remove = vi.fn();
    const addListener = vi.fn().mockResolvedValue({ remove });
    installBridge({ addListener });
    const mod = await import("@/lib/plus/liveActivity");
    const handler = vi.fn();
    const unsub = mod.onActivityState(handler);
    // addListener resolves asynchronously; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    unsub();
    expect(addListener).toHaveBeenCalledWith("activityState", handler);
    expect(remove).toHaveBeenCalled();
  });
});

describe("createSerialQueue", () => {
  it("runs queued calls strictly one at a time, in the order they were queued, even when a later call would resolve first", async () => {
    // A slower first call and a faster second call: without serializing,
    // the second would finish (and observe/mutate shared state) before the
    // first even starts running. This is the exact shape of the bug —
    // BeachModeCard's Off-then-On — start() takes a while (ensureInstallToken
    // + a native round trip) and a quick end() queued right after it must
    // still not be allowed to run ahead of it.
    const mod = await import("@/lib/plus/liveActivity");
    const run = mod.createSerialQueue();
    const order: string[] = [];
    const running: string[] = []; // names currently mid-flight — length > 1 means overlap

    const task = (name: string, ms: number) => async () => {
      running.push(name);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(name);
      running.splice(running.indexOf(name), 1);
      // Nothing else may be mid-flight while this one is: overlap would mean
      // the native plugin could see two calls at once.
      expect(running.length).toBe(0);
      return name;
    };

    const a = run(task("slow-first", 20));
    const b = run(task("fast-second", 0));
    const c = run(task("fast-third", 0));

    const results = await Promise.all([a, b, c]);
    expect(results).toEqual(["slow-first", "fast-second", "fast-third"]);
    expect(order).toEqual(["slow-first", "fast-second", "fast-third"]);
  });

  it("a rejected call never blocks the ones queued after it, and each queued fn still sees its own error/success", async () => {
    const mod = await import("@/lib/plus/liveActivity");
    const run = mod.createSerialQueue();
    const order: string[] = [];

    const ok = (name: string) => async () => {
      order.push(name);
      return name;
    };
    const boom = (name: string) => async () => {
      order.push(name);
      throw new Error(name);
    };

    const a = run(ok("first"));
    const b = run(boom("second-fails"));
    const c = run(ok("third"));

    await expect(a).resolves.toBe("first");
    await expect(b).rejects.toThrow("second-fails");
    await expect(c).resolves.toBe("third");
    expect(order).toEqual(["first", "second-fails", "third"]);
  });

  it("two independently-created queues never block each other", async () => {
    const mod = await import("@/lib/plus/liveActivity");
    const runA = mod.createSerialQueue();
    const runB = mod.createSerialQueue();
    const order: string[] = [];

    const task = (name: string, ms: number) => async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(name);
      return name;
    };

    // A's first call is slow; if the queues shared state, B's call would
    // wait behind it too — it must not.
    const slowA = runA(task("a-slow", 20));
    const fastB = runB(task("b-fast", 0));

    await fastB;
    expect(order).toEqual(["b-fast"]); // B finished without waiting on A
    await slowA;
    expect(order).toEqual(["b-fast", "a-slow"]);
  });
});
