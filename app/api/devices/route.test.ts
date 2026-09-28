// The device pref round-trip for "coming-up" (SKY_EVENTS_PLAN.md §10, Crew G
// scope: "the coming-up key round-trips through the same validation the
// other 11 keys already go through"). patchFromBody() validates every
// ALERT_KEY generically (app/api/devices/route.ts), so this mostly proves
// that generic path actually reaches the new key — not a re-test of the
// other ten.

import { describe, it, expect, beforeEach } from "vitest";
import { POST, GET } from "@/app/api/devices/route";
import { resetMemoryStore } from "@/lib/db/memoryStore";

const DEV = "11111111-2222-4333-8444-555555555555";

function post(body: unknown): Request {
  return new Request("https://x/api/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const json = async (r: Response) =>
  (await r.json()) as { ok: boolean; device?: { prefs: Record<string, boolean> } };

beforeEach(() => {
  resetMemoryStore();
});

describe("POST /api/devices — coming-up pref", () => {
  it("a brand-new device defaults coming-up to false, every other alert to true", async () => {
    const res = await POST(post({ deviceId: DEV }));
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.device?.prefs["coming-up"]).toBe(false);
    expect(body.device?.prefs.morning).toBe(true);
  });

  it("opts a device in", async () => {
    await POST(post({ deviceId: DEV }));
    const res = await POST(post({ deviceId: DEV, prefs: { "coming-up": true } }));
    const body = await json(res);
    expect(body.device?.prefs["coming-up"]).toBe(true);
    // Merged, not replaced — every other pref survives untouched.
    expect(body.device?.prefs.lightning).toBe(true);
  });

  it("opts a device back out", async () => {
    await POST(post({ deviceId: DEV, prefs: { "coming-up": true } }));
    const res = await POST(post({ deviceId: DEV, prefs: { "coming-up": false } }));
    expect((await json(res)).device?.prefs["coming-up"]).toBe(false);
  });

  it("rejects a non-boolean value for coming-up, same as any other alert key", async () => {
    const res = await POST(post({ deviceId: DEV, prefs: { "coming-up": "yes" } }));
    expect(res.status).toBe(400);
  });

  it("GET round-trips the same prefs shape", async () => {
    await POST(post({ deviceId: DEV, prefs: { "coming-up": true } }));
    const res = await GET(new Request(`https://x/api/devices?deviceId=${DEV}`));
    const body = await json(res);
    expect(body.device?.prefs["coming-up"]).toBe(true);
  });
});
