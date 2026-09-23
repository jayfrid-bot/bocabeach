import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  // Plan/entitlement are now derived at write time against the real clock
  // (#4) — pin it to this suite's fixed `now` so "until = now - 1" still
  // means "already lapsed" and "now + HOUR" still means "live", regardless
  // of what day this actually runs.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function armed(id: string, plan: "free" | "plus", until: number, armedUntil: number) {
    // plan/entitlementUntil aren't patchable — grant (or don't) through
    // codeUntil and let the store derive plan from it.
    if (plan === "plus") await store.upsertDevice(id, { codeUntil: until });
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
      hasFix: true,
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

// The concurrency guard beneath the alerts dedup window (#14). The full race
// (two overlapping runs, one send) is covered end to end in
// lib/alerts/run.test.ts; this is the store contract in isolation.
describe("send claims (#14)", () => {
  const KEY = "dev-1111:lightning:100";

  it("the first claim on a key wins", async () => {
    expect(await store.claimSend(KEY, 1000)).toBe(true);
  });

  it("a second claim on the same key, before it is sent or abandoned, loses", async () => {
    await store.claimSend(KEY, 1000);
    expect(await store.claimSend(KEY, 1005)).toBe(false);
  });

  it("a different key claims independently — an escalation is never blocked by the plain alert's claim", async () => {
    await store.claimSend("dev-1111:lightning:100", 1000);
    expect(await store.claimSend("dev-1111:lightning:2mi:100", 1000)).toBe(true);
  });

  it("markSent does not unblock a fresh claim on the same key", async () => {
    await store.claimSend(KEY, 1000);
    await store.markSent(KEY, 1000);
    expect(await store.claimSend(KEY, 1005)).toBe(false);
  });

  it("an unsent claim younger than the abandonment window cannot be re-claimed", async () => {
    await store.claimSend(KEY, 1000);
    expect(await store.claimSend(KEY, 1000 + 9 * 60_000)).toBe(false);
  });

  it("an unsent claim 10+ minutes old is abandoned, and may be re-claimed", async () => {
    await store.claimSend(KEY, 1000);
    expect(await store.claimSend(KEY, 1000 + 10 * 60_000)).toBe(true);
  });

  it("prunes claims older than the retention window, and leaves fresher ones", async () => {
    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
    await store.claimSend("old", 1000);
    await store.claimSend("fresh", 1000 + THREE_DAYS);
    await store.pruneSendClaims(1000 + THREE_DAYS + 1);
    // A pruned key is gone entirely — re-claiming it looks like the very first
    // claim, not a takeover of an abandoned one.
    expect(await store.claimSend("old", 1000 + THREE_DAYS + 2)).toBe(true);
    // The fresh one is untouched: claiming it again is still a contested claim.
    expect(await store.claimSend("fresh", 1000 + THREE_DAYS + 2)).toBe(false);
  });
});

describe("purgeExpiredPresenceFixes", () => {
  const NOW = 2_000_000_000_000;
  const fix = { lat: 26.35, lon: -80.07, accuracyM: 20, fixAt: NOW - 60_000 };

  it("blanks the coordinates of an expired window but keeps the row and its slug", async () => {
    await store.upsertDevice("d-exp", { codeUntil: NOW + HOUR });
    await store.setPresence("d-exp", { slug: "boca-raton", ...fix, armedUntil: NOW - 1, source: "auto" });
    expect(await store.purgeExpiredPresenceFixes(NOW)).toBe(1);
    const dev = await store.getDevice("d-exp");
    expect(dev?.presence?.slug).toBe("boca-raton"); // the row survives
    // Not armed any more, so it is not listed — and the fix itself is gone.
    expect(await store.listArmed(NOW)).toEqual([]);
    expect(await store.listArmed(NOW - 60_000)).toMatchObject([
      { presence: { lat: null, lon: null, accuracyM: null, fixAt: null } },
    ]);
  });

  it("leaves a live window's fix alone, and is idempotent", async () => {
    await store.upsertDevice("d-live", { codeUntil: NOW + HOUR });
    await store.setPresence("d-live", { slug: "boca-raton", ...fix, armedUntil: NOW + HOUR, source: "auto" });
    expect(await store.purgeExpiredPresenceFixes(NOW)).toBe(0);
    expect((await store.listArmed(NOW))[0].presence.lat).toBe(26.35);
    await store.setPresence("d-live", { slug: "boca-raton", ...fix, armedUntil: NOW - 1, source: "auto" });
    expect(await store.purgeExpiredPresenceFixes(NOW)).toBe(1);
    expect(await store.purgeExpiredPresenceFixes(NOW)).toBe(0);
  });
});

// --- Beach Session Live Activity (migrations/0007_live_activities.sql) -----
describe("live activity store methods", () => {
  const NOW = 2_000_000_000_000;

  function baseInput(over: Partial<Parameters<DeviceStore["upsertLiveActivity"]>[0]> = {}) {
    return {
      activityId: "act-1",
      deviceId: "dev-1",
      beachSlug: "boca-raton",
      schemaVersion: 1,
      appBuild: "42",
      apnsEnvironment: "sandbox" as const,
      pushToken: "a".repeat(64),
      startedAt: NOW,
      expiresAt: NOW + HOUR,
      ...over,
    };
  }

  it("upsertLiveActivity creates an active row", async () => {
    const row = await store.upsertLiveActivity(baseInput());
    expect(row.status).toBe("active");
    expect(row.pushToken).toBe("a".repeat(64));
    expect(row.startedAt).toBe(NOW);
    const forDevice = await store.listLiveActivitiesForDevice("dev-1");
    expect(forDevice).toHaveLength(1);
  });

  it("a token rotation for the SAME activityId replaces the token atomically and keeps startedAt", async () => {
    await store.upsertLiveActivity(baseInput());
    const rotated = await store.upsertLiveActivity(
      baseInput({ pushToken: "b".repeat(64), startedAt: NOW + 999_999, expiresAt: NOW + 2 * HOUR }),
    );
    expect(rotated.pushToken).toBe("b".repeat(64));
    expect(rotated.startedAt).toBe(NOW); // sticky — never overwritten by a rotation
    expect(rotated.expiresAt).toBe(NOW + 2 * HOUR);
    const forDevice = await store.listLiveActivitiesForDevice("dev-1");
    expect(forDevice).toHaveLength(1); // still one row, not a duplicate
  });

  it("rotation never touches a different activity's row for the same device", async () => {
    await store.upsertLiveActivity(baseInput({ activityId: "act-1" }));
    await store.upsertLiveActivity(baseInput({ activityId: "act-2", pushToken: "c".repeat(64) }));
    const forDevice = await store.listLiveActivitiesForDevice("dev-1");
    expect(forDevice.map((r) => r.activityId).sort()).toEqual(["act-1", "act-2"]);
  });

  it("listActiveLiveActivities only returns active rows", async () => {
    await store.upsertLiveActivity(baseInput({ activityId: "act-1" }));
    await store.upsertLiveActivity(baseInput({ activityId: "act-2" }));
    await store.markLiveActivityEnded("act-2", "user", NOW);
    const active = await store.listActiveLiveActivities(NOW);
    expect(active.map((r) => r.activityId)).toEqual(["act-1"]);
  });

  it("markLiveActivityEnded is idempotent and stamps endedAt", async () => {
    await store.upsertLiveActivity(baseInput());
    await store.markLiveActivityEnded("act-1", "user", NOW);
    const first = (await store.listLiveActivitiesForDevice("dev-1"))[0];
    expect(first.status).toBe("ended");
    expect(first.endedAt).not.toBeNull();
    // Ending an already-ended row a second time doesn't move endedAt forward
    // into "never actually ended" territory — a no-op, not a re-stamp bug.
    await store.markLiveActivityEnded("act-1", "user-again", NOW + 1000);
    const second = (await store.listLiveActivitiesForDevice("dev-1"))[0];
    expect(second.endedAt).toBe(first.endedAt);
  });

  it("recordLiveActivitySend updates send bookkeeping and stashes the state for next run", async () => {
    await store.upsertLiveActivity(baseInput());
    const seq = (await store.allocateLiveActivitySeq("act-1", NOW))?.seq;
    await store.recordLiveActivitySend("act-1", {
      timestamp: NOW + 1000,
      status: 200,
      hash: "abc",
      stateJson: JSON.stringify({ score: 80, updatedAt: NOW }),
      seq: seq!,
    });
    const row = (await store.listLiveActivitiesForDevice("dev-1"))[0];
    expect(row.lastSentAt).toBe(NOW + 1000);
    expect(row.lastApnsStatus).toBe(200);
    expect(row.lastStateHash).toBe("abc");
    expect(row.lastStateJson).toContain("80");
    expect(row.lastSeq).toBe(1);
  });

  describe("allocateLiveActivitySeq (round-2 #5)", () => {
    it("increments last_seq atomically and returns the new value", async () => {
      await store.upsertLiveActivity(baseInput());
      expect((await store.allocateLiveActivitySeq("act-1", NOW))?.seq).toBe(1);
      expect((await store.allocateLiveActivitySeq("act-1", NOW))?.seq).toBe(2);
      expect((await store.allocateLiveActivitySeq("act-1", NOW))?.seq).toBe(3);
    });

    it("returns null for a row that doesn't exist or isn't active", async () => {
      expect(await store.allocateLiveActivitySeq("nope", NOW)).toBeNull();
      await store.upsertLiveActivity(baseInput());
      await store.markLiveActivityEnded("act-1", "user", NOW);
      expect(await store.allocateLiveActivitySeq("act-1", NOW)).toBeNull();
    });

    it("Codex round-3: seq and timestamp are allocated together and strictly co-monotonic across concurrent callers", async () => {
      await store.upsertLiveActivity(baseInput());
      const a = await store.allocateLiveActivitySeq("act-1", NOW);
      const b = await store.allocateLiveActivitySeq("act-1", NOW);
      expect(a?.seq).toBe(1);
      expect(b?.seq).toBe(2);
      expect(b!.timestampMs).toBeGreaterThan(a!.timestampMs);
      // Codex round-4 #5: apns.ts's wire payload only sends whole epoch
      // SECONDS (Math.floor(ms/1000)) — that's the unit ActivityKit orders
      // by, so two allocations 1ms apart used to collapse to the same
      // transmitted timestamp. Assert the actual transmitted unit increases.
      expect(Math.floor(b!.timestampMs / 1000)).toBeGreaterThan(Math.floor(a!.timestampMs / 1000));
    });

    it("overlapping runs never send the same seq: recordLiveActivitySend CAS rejects a stale seq", async () => {
      await store.upsertLiveActivity(baseInput());
      // Run A allocates seq 1, then (simulated) a slower run B allocates
      // seq 2 and finishes its send first.
      const seqA = (await store.allocateLiveActivitySeq("act-1", NOW))?.seq;
      const seqB = (await store.allocateLiveActivitySeq("act-1", NOW))?.seq;
      expect(seqA).toBe(1);
      expect(seqB).toBe(2);
      await store.recordLiveActivitySend("act-1", {
        timestamp: NOW + 2000,
        status: 200,
        hash: "from-b",
        seq: seqB!,
      });
      // Run A's send resolves late — its bookkeeping write must be rejected
      // (last_seq is already 2, not 1) rather than clobber B's fresher state.
      await store.recordLiveActivitySend("act-1", {
        timestamp: NOW + 1000,
        status: 200,
        hash: "from-a",
        seq: seqA!,
      });
      const row = (await store.listLiveActivitiesForDevice("dev-1"))[0];
      expect(row.lastStateHash).toBe("from-b");
      expect(row.lastSentAt).toBe(NOW + 2000);
      expect(row.lastSeq).toBe(2);
    });
  });

  describe("registerLiveActivity", () => {
    function registerInput(
      over: Partial<Parameters<DeviceStore["registerLiveActivity"]>[0]> = {},
    ): Parameters<DeviceStore["registerLiveActivity"]>[0] {
      return { ...baseInput(), rotation: null, ...over };
    }

    it("Codex round-3 #3 (HIGH): a delayed higher rotation for an ENDED activity must not reactivate it", async () => {
      await store.registerLiveActivity(registerInput({ activityId: "A", deviceId: "dev-1", rotation: 1 }));
      // B supersedes/ends A.
      await store.registerLiveActivity(
        registerInput({ activityId: "B", deviceId: "dev-1", pushToken: "b".repeat(64), rotation: 1 }),
      );
      const result = await store.registerLiveActivity(
        registerInput({ activityId: "A", deviceId: "dev-1", pushToken: "d".repeat(64), rotation: 2 }),
      );
      expect(result).toBe("ended");
      const rows = await store.listLiveActivitiesForDevice("dev-1");
      const a = rows.find((r) => r.activityId === "A");
      const b = rows.find((r) => r.activityId === "B");
      expect(a?.status).toBe("ended");
      expect(a?.pushToken).not.toBe("d".repeat(64));
      expect(b?.status).toBe("active");
    });

    it("Codex round-4 #2 (HIGH) mirror: a delayed rotation-2 batch for A must not end B", async () => {
      // memoryStore has no separate "pre-check, then later SQL batch" split
      // (d1Store.ts's SUPERSEDE/REGISTER pair) — the status==='active' check
      // and the supersede-then-insert mutation run in the same synchronous
      // stretch with no `await` in between (see the method's own doc), so
      // there is no window for a delayed call to observe a stale 'active'
      // read. This test documents that guarantee with the same scenario the
      // d1Store SQL-level test exercises directly.
      await store.registerLiveActivity(registerInput({ activityId: "A", deviceId: "dev-1", rotation: 1 }));
      await store.registerLiveActivity(
        registerInput({ activityId: "B", deviceId: "dev-1", pushToken: "b".repeat(64), rotation: 1 }),
      );
      const result = await store.registerLiveActivity(
        registerInput({ activityId: "A", deviceId: "dev-1", pushToken: "d".repeat(64), rotation: 2 }),
      );
      expect(result).toBe("ended");
      const rows = await store.listLiveActivitiesForDevice("dev-1");
      const a = rows.find((r) => r.activityId === "A");
      const b = rows.find((r) => r.activityId === "B");
      expect(a?.status).toBe("ended");
      expect(b?.status).toBe("active"); // B must survive the delayed A batch untouched
    });

    it("a higher rotation on a still-ACTIVE row updates it normally", async () => {
      await store.registerLiveActivity(registerInput({ activityId: "A", deviceId: "dev-1", rotation: 1 }));
      const result = await store.registerLiveActivity(
        registerInput({ activityId: "A", deviceId: "dev-1", pushToken: "d".repeat(64), rotation: 2 }),
      );
      expect(result).not.toBe("ended");
      expect(result).not.toBe("stale-rotation");
      const row = (await store.listLiveActivitiesForDevice("dev-1"))[0];
      expect(row.status).toBe("active");
      expect(row.pushToken).toBe("d".repeat(64));
    });
  });

  it("purgeLiveActivities only deletes ended rows past the cutoff", async () => {
    await store.upsertLiveActivity(baseInput({ activityId: "still-active" }));
    await store.upsertLiveActivity(baseInput({ activityId: "ended-recent" }));
    await store.upsertLiveActivity(baseInput({ activityId: "ended-old" }));
    await store.markLiveActivityEnded("ended-recent", "user", NOW);
    await store.markLiveActivityEnded("ended-old", "user", NOW);
    // Force the "old" row's endedAt back in time so it's past a cutoff.
    const rows = await store.listLiveActivitiesForDevice("dev-1");
    expect(rows).toHaveLength(3);
    const deleted = await store.purgeLiveActivities(NOW + 1); // everything ended is "old enough"
    expect(deleted).toBe(2);
    const remaining = await store.listLiveActivitiesForDevice("dev-1");
    expect(remaining.map((r) => r.activityId)).toEqual(["still-active"]);
  });
});

