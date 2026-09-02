import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore } from "@/lib/db/memoryStore";
import { legacyDeviceId } from "@/lib/db/legacy";
import { entitled, defaultPrefs, toRecord, newDeviceRow, applyPatch } from "@/lib/db/types";
import type { DeviceStore } from "@/lib/db/store";
import type { NativeSub } from "@/lib/push/nativeStore";

const HOUR = 3600 * 1000;
let store: DeviceStore;

beforeEach(() => {
  store = createMemoryStore(); // no file → nothing touches the disk
});

function sub(over: Partial<NativeSub> = {}): NativeSub {
  return {
    token: "a".repeat(64),
    platform: "ios",
    slug: "boca-raton",
    tz: "America/New_York",
    prefs: { morning: true, safety: true },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("entitled", () => {
  const now = 1_000_000;
  it("is false for a free device", () => {
    expect(entitled({ plan: "free", entitlementUntil: now + HOUR }, now)).toBe(false);
  });
  it("is false for an expired plus device", () => {
    expect(entitled({ plan: "plus", entitlementUntil: now - 1 }, now)).toBe(false);
  });
  it("is false when plus has no expiry", () => {
    expect(entitled({ plan: "plus", entitlementUntil: null }, now)).toBe(false);
  });
  it("is true for a live plus device", () => {
    expect(entitled({ plan: "plus", entitlementUntil: now + 1 }, now)).toBe(true);
  });
  it("reads the snake_case row shape too", () => {
    expect(entitled({ plan: "plus", entitlement_until: now + 1 }, now)).toBe(true);
  });
});

describe("toRecord", () => {
  it("defaults prefs to all-on and leaves optional fields null", () => {
    const rec = toRecord(newDeviceRow("d1", 0));
    expect(rec.prefs).toEqual(defaultPrefs());
    expect(rec.plan).toBe("free");
    expect(rec.profile).toBeNull();
    expect(rec.presence).toBeNull();
    expect(rec.trialUsed).toBe(false);
  });

  it("survives a corrupt prefs blob", () => {
    const row = { ...newDeviceRow("d1", 0), prefs_json: "{not json" };
    expect(toRecord(row).prefs).toEqual(defaultPrefs());
  });
});

describe("applyPatch", () => {
  it("changes only the provided fields", () => {
    const base = applyPatch(newDeviceRow("d1", 1), { tz: "America/New_York" }, 1);
    const next = applyPatch(base, { previewSeen: true }, 2);
    expect(next.tz).toBe("America/New_York");
    expect(next.preview_seen).toBe(1);
  });

  it("merges prefs rather than replacing them", () => {
    const base = applyPatch(newDeviceRow("d1", 1), { prefs: { morning: false } }, 1);
    const next = applyPatch(base, { prefs: { rip: false } }, 2);
    const prefs = toRecord(next).prefs;
    expect(prefs.morning).toBe(false);
    expect(prefs.rip).toBe(false);
    expect(prefs.lightning).toBe(true);
  });
});

describe("device CRUD", () => {
  it("creates on first upsert and patches after", async () => {
    const a = await store.upsertDevice("dev-1111", { platform: "ios", tz: "America/New_York" });
    expect(a.id).toBe("dev-1111");
    expect(a.platform).toBe("ios");
    expect(a.plan).toBe("free");

    const b = await store.upsertDevice("dev-1111", { homeSlug: "boca-raton" });
    expect(b.homeSlug).toBe("boca-raton");
    expect(b.tz).toBe("America/New_York"); // untouched
  });

  it("reads back, lists and deletes", async () => {
    await store.upsertDevice("dev-1111", {});
    await store.upsertDevice("dev-2222", {});
    expect((await store.listDevices()).map((d) => d.id).sort()).toEqual(["dev-1111", "dev-2222"]);
    await store.deleteDevice("dev-1111");
    expect(await store.getDevice("dev-1111")).toBeNull();
    expect(await store.listDevices()).toHaveLength(1);
  });

  it("finds a device by its push token", async () => {
    await store.upsertDevice("dev-1111", { pushToken: "tok-abc" });
    expect((await store.findByPushToken("tok-abc"))?.id).toBe("dev-1111");
    expect(await store.findByPushToken("nope")).toBeNull();
  });

  it("round-trips a profile", async () => {
    const profile = { profiles: ["swim" as const], heat: "hot" as const, crowds: "low" as const };
    await store.upsertDevice("dev-1111", { profile });
    expect((await store.getDevice("dev-1111"))?.profile).toEqual(profile);
    await store.upsertDevice("dev-1111", { profile: null });
    expect((await store.getDevice("dev-1111"))?.profile).toBeNull();
  });

  it("stores and clears the push dedup state", async () => {
    await store.upsertDevice("dev-1111", {});
    await store.setSent("dev-1111", { morningDate: "2026-09-02" });
    expect(await store.getSent("dev-1111")).toEqual({ morningDate: "2026-09-02" });
    await store.setSent("dev-1111", {});
    expect(await store.getSent("dev-1111")).toEqual({});
  });

  it("lists only pushable devices", async () => {
    await store.upsertDevice("dev-1111", { platform: "ios", pushToken: "tok-a" });
    await store.upsertDevice("dev-2222", { platform: "web" }); // no token
    await store.upsertDevice("dev-3333", { pushToken: "tok-c" }); // no platform
    const pushable = await store.listPushable();
    expect(pushable.map((p) => p.device.id)).toEqual(["dev-1111"]);
    expect(pushable[0].token).toBe("tok-a");
    expect(await store.getPushToken("dev-1111")).toBe("tok-a");
  });
});

describe("presence + listArmed", () => {
  const now = 1_700_000_000_000;

  async function armed(id: string, plan: "free" | "plus", until: number, armedUntil: number) {
    await store.upsertDevice(id, { plan, entitlementUntil: until });
    await store.setPresence(id, {
      slug: "boca-raton",
      lat: 26.35,
      lon: -80.07,
      accuracyM: 12,
      fixAt: now,
      armedUntil,
      source: "auto",
    });
  }

  it("returns only entitled devices whose window is still open", async () => {
    await armed("dev-plus-live", "plus", now + HOUR, now + HOUR); // ✓
    await armed("dev-plus-expired-arm", "plus", now + HOUR, now - 1); // window closed
    await armed("dev-plus-lapsed", "plus", now - 1, now + HOUR); // entitlement lapsed
    await armed("dev-free", "free", now + HOUR, now + HOUR); // not Plus

    const list = await store.listArmed(now);
    expect(list.map((a) => a.device.id)).toEqual(["dev-plus-live"]);
    expect(list[0].presence).toMatchObject({
      slug: "boca-raton",
      lat: 26.35,
      lon: -80.07,
      accuracyM: 12,
      source: "auto",
    });
    expect(list[0].device.presence).toEqual({
      slug: "boca-raton",
      armedUntil: now + HOUR,
      source: "auto",
    });
  });

  it("disarms", async () => {
    await armed("dev-plus-live", "plus", now + HOUR, now + HOUR);
    await store.clearPresence("dev-plus-live");
    expect(await store.listArmed(now)).toHaveLength(0);
    expect((await store.getDevice("dev-plus-live"))?.presence).toBeNull();
  });

  it("drops presence when the device is deleted", async () => {
    await armed("dev-plus-live", "plus", now + HOUR, now + HOUR);
    await store.deleteDevice("dev-plus-live");
    expect(await store.listArmed(now)).toHaveLength(0);
  });
});

describe("alert log", () => {
  it("records and overwrites one mark per device+key", async () => {
    expect(await store.lastAlert("dev-1111", "lightning")).toBeNull();
    await store.markAlert("dev-1111", "lightning", 1000, { mi: 3 });
    expect(await store.lastAlert("dev-1111", "lightning")).toEqual({ sentAt: 1000, meta: { mi: 3 } });
    await store.markAlert("dev-1111", "lightning", 2000);
    expect(await store.lastAlert("dev-1111", "lightning")).toEqual({ sentAt: 2000, meta: null });
  });
});

describe("importLegacy", () => {
  it("creates one device per legacy subscription, with mapped prefs", async () => {
    const s = sub({ prefs: { morning: true, safety: false } });
    const r = await store.importLegacy([s]);
    expect(r.imported).toBe(1);

    const dev = await store.getDevice(legacyDeviceId(s.token));
    expect(dev).toBeTruthy();
    expect(dev!.homeSlug).toBe("boca-raton");
    expect(dev!.platform).toBe("ios");
    expect(dev!.tz).toBe("America/New_York");
    expect(dev!.plan).toBe("free");
    expect(dev!.prefs.morning).toBe(true);
    expect(dev!.prefs.lightning).toBe(false);
    expect(dev!.prefs.rip).toBe(false);
    expect(dev!.prefs["score-excellent"]).toBe(true); // outside the legacy switches
  });

  it("carries the dedup state across", async () => {
    const s = sub({ sent: { morningDate: "2026-09-01" } });
    await store.importLegacy([s]);
    expect(await store.getSent(legacyDeviceId(s.token))).toEqual({ morningDate: "2026-09-01" });
  });

  it("is idempotent — a second import changes nothing", async () => {
    const s = sub();
    await store.importLegacy([s]);
    await store.setSent(legacyDeviceId(s.token), { morningDate: "2026-09-02" });

    const again = await store.importLegacy([s]);
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(1);
    expect(await store.listDevices()).toHaveLength(1);
    // Stale KV state must not clobber what the sender has since written.
    expect(await store.getSent(legacyDeviceId(s.token))).toEqual({ morningDate: "2026-09-02" });
  });

  it("skips a token that already belongs to a real device", async () => {
    const s = sub();
    await store.upsertDevice("dev-1111", { pushToken: s.token });
    const r = await store.importLegacy([s]);
    expect(r.imported).toBe(0);
    expect(await store.getDevice(legacyDeviceId(s.token))).toBeNull();
  });

  it("imports several subscriptions at once", async () => {
    const r = await store.importLegacy([
      sub({ token: "a".repeat(64) }),
      sub({ token: "b".repeat(64), platform: "android", slug: "deerfield-beach" }),
    ]);
    expect(r.imported).toBe(2);
    expect(await store.listDevices()).toHaveLength(2);
  });
});
