// /api/presence input hardening (LOC-09) and the delivery-readiness answer
// (LOC-03), against the shared in-memory store `getStore()` hands out under
// vitest.

import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "@/app/api/presence/route";
import { getStore } from "@/lib/db/store";
import { FIX_MAX_FUTURE_SKEW_MS } from "@/lib/alerts/run";

const DEV = "33333333-4444-4555-8666-777777777777";
const HOUR = 3600 * 1000;

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://localhost/api/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    deviceId: DEV,
    slug: "boca-raton",
    lat: 26.3587,
    lon: -80.0686,
    accuracyM: 20,
    fixAt: now - 30_000,
    armedUntil: now + 4 * HOUR,
    source: "auto",
    ...over,
  };
}

beforeEach(async () => {
  const store = await getStore();
  await store.deleteDevice(DEV);
  await store.upsertDevice(DEV, { platform: "ios", codeUntil: Date.now() + 30 * 24 * HOUR });
});

describe("POST /api/presence — input validation (LOC-09)", () => {
  it("arms with an acceptable fix", async () => {
    const res = await post(base());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; device: { presence: { slug: string; hasFix: boolean } } };
    expect(json.device.presence).toMatchObject({ slug: "boca-raton", hasFix: true });
  });

  it("tolerates a little clock skew, rejects a future-dated fix", async () => {
    expect((await post(base({ fixAt: Date.now() + FIX_MAX_FUTURE_SKEW_MS - 1000 }))).status).toBe(200);
    expect((await post(base({ fixAt: Date.now() + 24 * HOUR }))).status).toBe(400);
  });

  it("rejects a malformed accuracy instead of storing it as unknown", async () => {
    expect((await post(base({ accuracyM: "fine" }))).status).toBe(400);
    expect((await post(base({ accuracyM: -5 }))).status).toBe(400);
    expect((await post(base({ fixAt: "yesterday" }))).status).toBe(400);
  });

  it("still accepts genuinely missing precision and coordinates", async () => {
    const res = await post(base({ lat: null, lon: null, accuracyM: null, fixAt: null }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { device: { presence: { hasFix: boolean } } };
    expect(json.device.presence.hasFix).toBe(false);
  });
});

describe("POST /api/presence — delivery readiness (LOC-03)", () => {
  it("answers pushReady:false for a device with no push token — monitoring, not delivery", async () => {
    const json = (await (await post(base())).json()) as { ok: boolean; pushReady: boolean };
    expect(json.ok).toBe(true);
    expect(json.pushReady).toBe(false);
  });

  it("answers pushReady:true once a token is registered", async () => {
    const store = await getStore();
    await store.upsertDevice(DEV, { pushToken: "t".repeat(64) });
    const json = (await (await post(base())).json()) as { pushReady: boolean };
    expect(json.pushReady).toBe(true);
  });
});
