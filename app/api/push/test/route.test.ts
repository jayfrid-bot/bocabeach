import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: { token: string; title: string }[] = [];
vi.mock("@/lib/push/apns", () => ({
  getApns: () => ({ keyId: "k", teamId: "t", bundleId: "b", privateKey: "p", production: false }),
  openApnsSession: () => ({
    send: async (token: string, payload: { title: string }) => {
      sent.push({ token, title: payload.title });
      return { ok: true, status: 200 };
    },
    sendLiveActivityUpdate: async () => ({ ok: true, status: 200 }),
    close: () => {},
  }),
}));

import { POST } from "@/app/api/push/test/route";
import { getStore } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";

const DEV = "11111111-2222-4333-8444-555555555555";
const post = (body: unknown, auth = "Bearer test-token") =>
  POST(new Request("http://x/api/push/test", { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(async () => {
  process.env.INGEST_TOKEN = "test-token";
  resetMemoryStore();
  sent.length = 0;
  await (await getStore()).upsertDevice(DEV, { platform: "ios", pushToken: "tok-abc" });
});
afterEach(() => {
  delete process.env.INGEST_TOKEN;
});

describe("POST /api/push/test", () => {
  it("503 without the secret, 401 with the wrong one", async () => {
    delete process.env.INGEST_TOKEN;
    expect((await post({ deviceId: DEV })).status).toBe(503);
    process.env.INGEST_TOKEN = "test-token";
    expect((await post({ deviceId: DEV }, "Bearer nope")).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("sends one test alert to the device's own token and writes no alert state", async () => {
    const res = await post({ deviceId: DEV });
    expect(res.status).toBe(200);
    expect(sent).toEqual([{ token: "tok-abc", title: "Test alert" }]);
    // No dedupe state is written: a later real alert can't be suppressed by a test.
    const [pushable] = await (await getStore()).listPushable();
    expect(pushable?.sent ?? {}).toEqual({});
  });

  it("404 for a device with no push token, 400 for a bad id", async () => {
    expect((await post({ deviceId: "99999999-2222-4333-8444-555555555555" })).status).toBe(404);
    expect((await post({ deviceId: "nope" })).status).toBe(400);
  });
});
