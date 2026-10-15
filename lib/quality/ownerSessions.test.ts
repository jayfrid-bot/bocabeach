import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import {
  clearSessionPushToken,
  createSession,
  findSession,
  hashOwnerToken,
  looksLikeOwnerToken,
  newOwnerToken,
  sessionsWithPushToken,
  setSessionPushToken,
  touchSession,
  TOUCH_EVERY_MS,
} from "@/lib/quality/ownerSessions";

let h: CamDb;
beforeEach(() => {
  h = makeCamDb({ allMigrations: true }) as CamDb;
});
afterEach(() => h?.close());

describe("owner tokens", () => {
  it("are 32 random bytes as 43 base64url characters, and never repeat", () => {
    const a = newOwnerToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(looksLikeOwnerToken(a)).toBe(true);
    expect(newOwnerToken()).not.toBe(a);
  });

  it("looksLikeOwnerToken refuses anything else", () => {
    for (const bad of ["", "short", "a".repeat(44), `${"a".repeat(42)}!`, 5, null, undefined]) expect(looksLikeOwnerToken(bad)).toBe(false);
  });

  it("hash to a SHA-256 hex, so the stored value is not the token", async () => {
    const t = newOwnerToken();
    const hash = await hashOwnerToken(t);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(t);
    expect(await hashOwnerToken(t)).toBe(hash);
    expect(await hashOwnerToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe.skipIf(!HAS_SQLITE)("sessions", () => {
  const NOW = Date.parse("2026-10-14T16:00:00.000Z");

  it("stores only the hash, and finds the live session by its token", async () => {
    const token = newOwnerToken();
    const id = await createSession(h.db, { deviceId: "dev-1", token, nowMs: NOW });
    expect(id).toBeGreaterThan(0);
    const row = h.all("SELECT * FROM owner_sessions")[0];
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row).toMatchObject({ device_id: "dev-1", revoked: 0, push_token: null, created_at: new Date(NOW).toISOString() });
    expect(await findSession(h.db, token)).toMatchObject({ id, device_id: "dev-1" });
  });

  it("does not find an unknown token, a malformed one, or a revoked session", async () => {
    const token = newOwnerToken();
    await createSession(h.db, { deviceId: "d", token, nowMs: NOW });
    expect(await findSession(h.db, newOwnerToken())).toBeNull();
    expect(await findSession(h.db, "short")).toBeNull();
    h.exec("UPDATE owner_sessions SET revoked = 1");
    expect(await findSession(h.db, token)).toBeNull();
  });

  it("touchSession refreshes last_seen at most every 10 minutes", async () => {
    const token = newOwnerToken();
    await createSession(h.db, { deviceId: "d", token, nowMs: NOW });
    const s = (await findSession(h.db, token))!;
    await touchSession(h.db, s, NOW + TOUCH_EVERY_MS - 1);
    expect(h.all("SELECT last_seen FROM owner_sessions")[0].last_seen).toBe(new Date(NOW).toISOString());
    await touchSession(h.db, s, NOW + TOUCH_EVERY_MS);
    expect(h.all("SELECT last_seen FROM owner_sessions")[0].last_seen).toBe(new Date(NOW + TOUCH_EVERY_MS).toISOString());
  });

  it("keeps the phone's push token on the session, newest first, and clears a dead one", async () => {
    const a = await createSession(h.db, { deviceId: "a", token: newOwnerToken(), nowMs: NOW });
    const b = await createSession(h.db, { deviceId: "b", token: newOwnerToken(), nowMs: NOW });
    await createSession(h.db, { deviceId: "c", token: newOwnerToken(), nowMs: NOW }); // no push token
    await setSessionPushToken(h.db, a, "aa".repeat(32), NOW);
    await setSessionPushToken(h.db, b, "bb".repeat(32), NOW + 1000);
    expect((await sessionsWithPushToken(h.db, 5)).map((s) => s.id)).toEqual([b, a]);
    expect(await sessionsWithPushToken(h.db, 1)).toHaveLength(1);
    expect(await clearSessionPushToken(h.db, b, "bb".repeat(32))).toBe(true);
    expect((await sessionsWithPushToken(h.db, 5)).map((s) => s.id)).toEqual([a]);
  });

  it("clearing a dead token is compare-and-set: a refreshed token survives a late 'dead' answer", async () => {
    const a = await createSession(h.db, { deviceId: "a", token: newOwnerToken(), nowMs: NOW });
    await setSessionPushToken(h.db, a, "old".repeat(20), NOW);
    await setSessionPushToken(h.db, a, "new".repeat(20), NOW + 1000); // the phone sent a fresh token meanwhile
    expect(await clearSessionPushToken(h.db, a, "old".repeat(20))).toBe(false);
    expect(h.all("SELECT push_token FROM owner_sessions")[0].push_token).toBe("new".repeat(20));
    expect(await clearSessionPushToken(h.db, a, "new".repeat(20))).toBe(true);
    expect(h.all("SELECT push_token FROM owner_sessions")[0].push_token).toBeNull();
  });

  it("enrolling again from the same device revokes the old session: one active session per device", async () => {
    const t1 = newOwnerToken();
    const t2 = newOwnerToken();
    const first = await createSession(h.db, { deviceId: "phone", token: t1, nowMs: NOW });
    await setSessionPushToken(h.db, first, "aa".repeat(32), NOW);
    const second = await createSession(h.db, { deviceId: "phone", token: t2, nowMs: NOW + 1000 });
    expect(second).not.toBe(first);
    expect(await findSession(h.db, t1)).toBeNull();
    expect(await findSession(h.db, t2)).toMatchObject({ id: second });
    expect(h.all("SELECT COUNT(*) AS n FROM owner_sessions WHERE device_id = 'phone' AND revoked = 0")[0].n).toBe(1);
    // the revoked session no longer receives pushes
    expect(await sessionsWithPushToken(h.db, 5)).toEqual([]);
  });

  it("two enrollments at once from one device still leave exactly one active session", async () => {
    await Promise.all([1, 2, 3].map((i) => createSession(h.db, { deviceId: "phone", token: newOwnerToken(), nowMs: NOW + i })));
    expect(h.all("SELECT COUNT(*) AS n FROM owner_sessions WHERE device_id = 'phone' AND revoked = 0")[0].n).toBe(1);
  });

  it("a push token moves to the newest session that sets it: one phone is never pushed twice", async () => {
    const a = await createSession(h.db, { deviceId: "a", token: newOwnerToken(), nowMs: NOW });
    const b = await createSession(h.db, { deviceId: "b", token: newOwnerToken(), nowMs: NOW });
    await setSessionPushToken(h.db, a, "tt".repeat(32), NOW);
    await setSessionPushToken(h.db, b, "tt".repeat(32), NOW + 1000);
    expect((await sessionsWithPushToken(h.db, 5)).map((s) => s.id)).toEqual([b]);
    expect(h.all("SELECT push_token FROM owner_sessions WHERE id = ?", a)[0].push_token).toBeNull();
  });

  it("the revoked-session race: an old request cannot strip the replacement session's token", async () => {
    // The old session authenticated, then waited while the phone enrolled again (which revoked it).
    const old = await createSession(h.db, { deviceId: "phone", token: newOwnerToken(), nowMs: NOW });
    const fresh = await createSession(h.db, { deviceId: "phone", token: newOwnerToken(), nowMs: NOW + 1000 });
    expect(await setSessionPushToken(h.db, fresh, "tt".repeat(32), NOW + 2000)).toBe(true);
    // ...and now the late request from the OLD session tries to set the same token.
    expect(await setSessionPushToken(h.db, old, "tt".repeat(32), NOW + 3000)).toBe(false);
    expect(h.all("SELECT id, push_token FROM owner_sessions WHERE revoked = 0")).toEqual([{ id: fresh, push_token: "tt".repeat(32) }]);
    expect(h.all("SELECT push_token FROM owner_sessions WHERE id = ?", old)[0].push_token).toBeNull();
  });

  it("setting a token reports success only when the session took it", async () => {
    const a = await createSession(h.db, { deviceId: "a", token: newOwnerToken(), nowMs: NOW });
    expect(await setSessionPushToken(h.db, a, "aa".repeat(32), NOW)).toBe(true);
    expect(await setSessionPushToken(h.db, 99999, "aa".repeat(32), NOW)).toBe(false); // no such session: the holder keeps it
    expect(h.all("SELECT push_token FROM owner_sessions WHERE id = ?", a)[0].push_token).toBe("aa".repeat(32));
  });

  it("a revoked session neither keeps nor receives a push token", async () => {
    const id = await createSession(h.db, { deviceId: "a", token: newOwnerToken(), nowMs: NOW });
    h.exec("UPDATE owner_sessions SET revoked = 1");
    await setSessionPushToken(h.db, id, "aa".repeat(32), NOW);
    expect(h.all("SELECT push_token FROM owner_sessions")[0].push_token).toBeNull();
    h.exec("UPDATE owner_sessions SET push_token = 'x'");
    expect(await sessionsWithPushToken(h.db, 5)).toEqual([]);
  });
});
