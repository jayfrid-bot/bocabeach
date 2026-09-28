// The device-row round-trip for the "sun-color" alert's two settings
// (migrations/0012_sun_color_prefs.sql): the "sun-color" AlertKey pref
// itself round-trips through the same generic validation every other key
// already goes through (see route.test.ts's coming-up file for that
// pattern) — this covers the two EXTRA fields, sunColorMinBand/
// sunColorLeadMin, which patchFromBody (app/api/devices/route.ts) validates
// by hand.

import { describe, it, expect, beforeEach } from "vitest";
import { POST, GET } from "@/app/api/devices/route";
import { resetMemoryStore } from "@/lib/db/memoryStore";

const DEV = "22222222-3333-4444-8555-666666666666";

function post(body: unknown): Request {
  return new Request("https://x/api/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const json = async (r: Response) =>
  (await r.json()) as {
    ok: boolean;
    error?: string;
    device?: { prefs: Record<string, boolean>; sunColor: { minBand: string; leadMin: number } };
  };

beforeEach(() => {
  resetMemoryStore();
});

describe("POST /api/devices — sun-color pref + settings", () => {
  it("a brand-new device defaults sun-color to off, and its settings to Great-or-better / 60 min", async () => {
    const res = await POST(post({ deviceId: DEV }));
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.device?.prefs["sun-color"]).toBe(false);
    expect(body.device?.sunColor).toEqual({ minBand: "vivid", leadMin: 60 });
  });

  it("opts a device in without touching any other pref", async () => {
    await POST(post({ deviceId: DEV }));
    const res = await POST(post({ deviceId: DEV, prefs: { "sun-color": true } }));
    const body = await json(res);
    expect(body.device?.prefs["sun-color"]).toBe(true);
    expect(body.device?.prefs.lightning).toBe(true);
  });

  it("rejects a non-boolean value for sun-color, same as any other alert key", async () => {
    const res = await POST(post({ deviceId: DEV, prefs: { "sun-color": "yes" } }));
    expect(res.status).toBe(400);
  });

  it("accepts a valid threshold and lead time", async () => {
    await POST(post({ deviceId: DEV }));
    const res = await POST(post({ deviceId: DEV, sunColorMinBand: "epic", sunColorLeadMin: 120 }));
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.device?.sunColor).toEqual({ minBand: "epic", leadMin: 120 });
  });

  it("rejects an unrecognized threshold", async () => {
    const res = await POST(post({ deviceId: DEV, sunColorMinBand: "great" }));
    expect(res.status).toBe(400);
  });

  it("rejects a lead time outside the offered choices", async () => {
    const res = await POST(post({ deviceId: DEV, sunColorLeadMin: 45 }));
    expect(res.status).toBe(400);
  });

  it("null resets either setting back to its default", async () => {
    await POST(post({ deviceId: DEV, sunColorMinBand: "epic", sunColorLeadMin: 180 }));
    const res = await POST(post({ deviceId: DEV, sunColorMinBand: null, sunColorLeadMin: null }));
    const body = await json(res);
    expect(body.device?.sunColor).toEqual({ minBand: "vivid", leadMin: 60 });
  });

  it("GET round-trips the same settings shape", async () => {
    await POST(post({ deviceId: DEV, sunColorMinBand: "epic", sunColorLeadMin: 30 }));
    const res = await GET(new Request(`https://x/api/devices?deviceId=${DEV}`));
    const body = await json(res);
    expect(body.device?.sunColor).toEqual({ minBand: "epic", leadMin: 30 });
  });

  it("changing the threshold leaves the lead time untouched, and vice versa", async () => {
    await POST(post({ deviceId: DEV, sunColorLeadMin: 180 }));
    const res = await POST(post({ deviceId: DEV, sunColorMinBand: "epic" }));
    const body = await json(res);
    expect(body.device?.sunColor).toEqual({ minBand: "epic", leadMin: 180 });
  });
});
