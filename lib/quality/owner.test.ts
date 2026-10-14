import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStore, hashInstallToken } from "@/lib/db/store";
import { resetMemoryStore } from "@/lib/db/memoryStore";
import { resetMemoryRateLimit } from "@/lib/plus/rateLimit";
import { isOwnerDevice, ownerDeviceIds, requireOwner } from "@/lib/quality/owner";

const OWNER = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const TOKEN = "owner-install-token";

const req = (headers: Record<string, string> = {}) => new Request("http://x/api/quality/owner/list", { method: "POST", headers });

beforeEach(async () => {
  resetMemoryStore();
  resetMemoryRateLimit();
  process.env.OWNER_DEVICE_IDS = OWNER;
  const store = await getStore();
  await store.upsertDevice(OWNER, {});
  await store.setInstallTokenHash(OWNER, hashInstallToken(TOKEN), Date.now());
  await store.upsertDevice(OTHER, {});
  await store.setInstallTokenHash(OTHER, hashInstallToken("other-token"), Date.now());
});
afterEach(() => {
  delete process.env.OWNER_DEVICE_IDS;
});

describe("ownerDeviceIds", () => {
  it("splits on commas, trims, and drops anything that is not a device id", () => {
    expect(ownerDeviceIds(` ${OWNER} , ${OTHER},nope,, `)).toEqual([OWNER, OTHER]);
    expect(ownerDeviceIds("")).toEqual([]);
    expect(ownerDeviceIds(undefined)).toEqual(ownerDeviceIds(process.env.OWNER_DEVICE_IDS));
  });

  it("isOwnerDevice", () => {
    expect(isOwnerDevice(OWNER, `${OWNER},${OTHER}`)).toBe(true);
    expect(isOwnerDevice("x", OWNER)).toBe(false);
  });
});

describe("requireOwner", () => {
  const status = async (r: Response | { deviceId: string }) => (r instanceof Response ? { status: r.status, body: await r.json() } : r);

  it("lets the owner device through with its install token", async () => {
    expect(await status(await requireOwner(req({ "x-install-token": TOKEN }), { deviceId: OWNER }))).toEqual({ deviceId: OWNER });
  });

  it("the device id alone is not enough", async () => {
    expect(await status(await requireOwner(req(), { deviceId: OWNER }))).toEqual({ status: 401, body: { ok: false, error: "no-token" } });
    expect(await status(await requireOwner(req({ "x-install-token": "wrong" }), { deviceId: OWNER }))).toMatchObject({ status: 401 });
  });

  it("a real device that is not on the list is refused, even with its own valid token", async () => {
    expect(await status(await requireOwner(req({ "x-install-token": "other-token" }), { deviceId: OTHER }))).toEqual({
      status: 403,
      body: { ok: false, error: "not-owner" },
    });
  });

  it("an owner token cannot be used with another device id", async () => {
    expect(await status(await requireOwner(req({ "x-install-token": TOKEN }), { deviceId: OTHER }))).toMatchObject({ status: 403 });
  });

  it("a device with no token minted yet says so", async () => {
    const store = await getStore();
    const fresh = "55555555-2222-4333-8444-555555555555";
    await store.upsertDevice(fresh, {});
    process.env.OWNER_DEVICE_IDS = fresh;
    expect(await status(await requireOwner(req({ "x-install-token": TOKEN }), { deviceId: fresh }))).toEqual({
      status: 401,
      body: { ok: false, error: "token-required" },
    });
  });

  it("stays closed when no owner list is set", async () => {
    delete process.env.OWNER_DEVICE_IDS;
    expect(await status(await requireOwner(req({ "x-install-token": TOKEN }), { deviceId: OWNER }))).toEqual({
      status: 503,
      body: { ok: false, error: "owner-not-configured" },
    });
  });

  it("refuses a missing or malformed body", async () => {
    expect(await status(await requireOwner(req(), null))).toMatchObject({ status: 400 });
    expect(await status(await requireOwner(req(), { deviceId: "short" }))).toMatchObject({ status: 400 });
    expect(await status(await requireOwner(req(), {}))).toMatchObject({ status: 400 });
  });

  it("slows down a flood from one address", async () => {
    const flood = () => requireOwner(new Request("http://x", { headers: { "cf-connecting-ip": "9.9.9.9" } }), { deviceId: OTHER });
    let last: Response | { deviceId: string } = { deviceId: "" };
    for (let i = 0; i < 241; i++) last = await flood();
    expect(last instanceof Response && last.status).toBe(429);
  });
});
