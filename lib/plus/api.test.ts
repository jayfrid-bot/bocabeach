import { afterEach, describe, expect, it, vi } from "vitest";
import { plusApi, plusErrorMessage } from "@/lib/plus/api";

// Every test here mocks `fetch`. No network, and the point of the suite is that
// NOTHING these helpers do can ever reject — the dashboard calls them in effects
// where a rejection would surface as an unhandled promise.

interface Call {
  url: string;
  init?: RequestInit;
}

function mockFetch(handler: (call: Call) => Response | Promise<Response> | never): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve().then(() => handler({ url, init }));
  });
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const DEVICE = {
  id: "11111111-2222-4333-8444-555555555555",
  platform: "ios",
  tz: "America/New_York",
  homeSlug: "boca-raton",
  profile: null,
  prefs: {},
  plan: "plus",
  entitlementUntil: 123,
  trialUsed: true,
  previewSeen: true,
  presence: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("success", () => {
  it("unwraps { ok: true, device }", async () => {
    mockFetch(() => json({ ok: true, device: DEVICE }));
    const res = await plusApi.getDevice(DEVICE.id);
    expect(res.ok).toBe(true);
    expect(res.device?.plan).toBe("plus");
    expect(res.error).toBeNull();
  });

  it("passes the device id in the query on a read", async () => {
    const calls = mockFetch(() => json({ ok: true, device: DEVICE }));
    await plusApi.getDevice(DEVICE.id);
    expect(calls[0].url).toBe(`/api/devices?deviceId=${DEVICE.id}`);
    expect(calls[0].init).toBeUndefined();
  });

  it("posts the device id alongside the patch", async () => {
    const calls = mockFetch(() => json({ ok: true, device: DEVICE }));
    await plusApi.saveDevice(DEVICE.id, { homeSlug: "deerfield-beach", platform: "web" });
    expect(calls[0].url).toBe("/api/devices");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      deviceId: DEVICE.id,
      homeSlug: "deerfield-beach",
      platform: "web",
    });
  });

  it("sends the whole presence window to /api/presence", async () => {
    const calls = mockFetch(() => json({ ok: true, device: DEVICE }));
    await plusApi.arm(DEVICE.id, {
      slug: "boca-raton",
      lat: 26.36,
      lon: -80.07,
      accuracyM: 12,
      fixAt: 1000,
      armedUntil: 5000,
      source: "auto",
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      deviceId: DEVICE.id,
      slug: "boca-raton",
      lat: 26.36,
      lon: -80.07,
      accuracyM: 12,
      fixAt: 1000,
      armedUntil: 5000,
      source: "auto",
    });
  });

  it("disarms with a DELETE that still carries the device id", async () => {
    const calls = mockFetch(() => json({ ok: true, device: DEVICE }));
    await plusApi.disarm(DEVICE.id);
    expect(calls[0].init?.method).toBe("DELETE");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ deviceId: DEVICE.id });
  });

  it("trims a pasted code before redeeming it is even attempted", async () => {
    const calls = mockFetch(() => json({ ok: true, device: DEVICE }));
    await plusApi.unlock(DEVICE.id, "LETMEIN");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      deviceId: DEVICE.id,
      code: "LETMEIN",
    });
  });
});

describe("failure", () => {
  it("returns the server's error slug rather than throwing", async () => {
    mockFetch(() => json({ ok: false, error: "trial-used" }, 409));
    const res = await plusApi.startTrial(DEVICE.id);
    expect(res).toMatchObject({ ok: false, error: "trial-used", status: 409, device: null });
  });

  it("reports a refused code as bad-code", async () => {
    mockFetch(() => json({ ok: false, error: "bad-code" }, 403));
    expect((await plusApi.unlock(DEVICE.id, "nope")).error).toBe("bad-code");
  });

  it("reports an unentitled arm as not-entitled", async () => {
    mockFetch(() => json({ ok: false, error: "not-entitled" }, 403));
    const res = await plusApi.arm(DEVICE.id, { slug: "boca-raton", armedUntil: 1, source: "auto" });
    expect(res.error).toBe("not-entitled");
  });

  it("resolves (never rejects) when the network is gone", async () => {
    mockFetch(() => {
      throw new Error("Failed to fetch");
    });
    const res = await plusApi.getDevice(DEVICE.id);
    expect(res).toMatchObject({ ok: false, error: "network", status: 0 });
  });

  it("survives a body that is not JSON at all", async () => {
    mockFetch(() => new Response("<html>502</html>", { status: 502 }));
    const res = await plusApi.getDevice(DEVICE.id);
    expect(res).toMatchObject({ ok: false, error: "server", status: 502 });
  });

  it("treats a 200 without ok:true as a failure", async () => {
    mockFetch(() => json({ device: DEVICE }));
    expect((await plusApi.getDevice(DEVICE.id)).ok).toBe(false);
  });
});

describe("plusErrorMessage", () => {
  it("has plain English for every slug the routes can answer with", () => {
    for (const slug of [
      "network",
      "trial-used",
      "bad-code",
      "not-entitled",
      "not-found",
      "store-unavailable",
      "bad-request",
    ]) {
      const msg = plusErrorMessage(slug);
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).toMatch(/[.!]$/);
    }
  });

  it("says nothing when there is no error", () => {
    expect(plusErrorMessage(null)).toBe("");
  });

  it("still has something to say about a slug it has never seen", () => {
    expect(plusErrorMessage("kaboom")).toMatch(/try again/i);
  });
});
