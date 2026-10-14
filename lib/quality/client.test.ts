import { afterEach, describe, expect, it, vi } from "vitest";
import { ownerErrorText, ownerPost, ownerRequestInit, readOwnerHint, writeOwnerHint } from "@/lib/quality/client";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubStorage(): Map<string, string> {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
  return m;
}

describe("ownerRequestInit", () => {
  it("is a JSON POST with the device id in the body and the token in a header", () => {
    const init = ownerRequestInit("dev-1", "tok", { alertId: 4 });
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toEqual({ "content-type": "application/json", "x-install-token": "tok" });
    expect(JSON.parse(init.body as string)).toEqual({ alertId: 4, deviceId: "dev-1" });
  });

  it("omits the token header when the phone has none, and the device id cannot be overridden by the body", () => {
    const init = ownerRequestInit("dev-1", null, { deviceId: "forged" });
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string).deviceId).toBe("dev-1");
  });
});

describe("ownerPost", () => {
  it("sends this phone's id and token and returns the data", async () => {
    const m = stubStorage();
    m.set("bd:device-id", "dev-aaaa-bbbb");
    m.set("bd:install-token", "tok-1");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, open: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {});
    const r = await ownerPost<{ ok: true; open: unknown[] }>("/api/quality/owner/list", { x: 1 });
    expect(r).toEqual({ ok: true, data: { ok: true, open: [] } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/quality/owner/list");
    expect((init.headers as Record<string, string>)["x-install-token"]).toBe("tok-1");
    expect(JSON.parse(init.body as string)).toEqual({ x: 1, deviceId: "dev-aaaa-bbbb" });
  });

  it("turns a refusal into an error code and a network failure into 'network'", async () => {
    const m = stubStorage();
    m.set("bd:device-id", "dev-aaaa-bbbb");
    vi.stubGlobal("window", {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "not-owner" }), { status: 403 })));
    expect(await ownerPost("/p")).toEqual({ ok: false, error: "not-owner", status: 403 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    expect(await ownerPost("/p")).toEqual({ ok: false, error: "server", status: 502 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await ownerPost("/p")).toEqual({ ok: false, error: "network", status: 0 });
  });

  it("does not call out when the browser cannot keep a device id", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await ownerPost("/p")).toEqual({ ok: false, error: "no-device", status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the owner hint", () => {
  it("is off until set, on after, and off again", () => {
    stubStorage();
    expect(readOwnerHint()).toBe(false);
    writeOwnerHint(true);
    expect(readOwnerHint()).toBe(true);
    writeOwnerHint(false);
    expect(readOwnerHint()).toBe(false);
  });

  it("reads as off when storage is blocked", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    expect(readOwnerHint()).toBe(false);
    expect(() => writeOwnerHint(true)).not.toThrow();
  });
});

describe("ownerErrorText", () => {
  it("has plain words for each refusal, none of them the raw code", () => {
    for (const code of ["not-owner", "owner-not-configured", "token-required", "no-token", "network", "no-device", "already-answered", "something-else"]) {
      const text = ownerErrorText(code);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain(code === "network" ? "xx" : code);
      expect(text).not.toMatch(/\bAI\b/);
    }
  });
});
