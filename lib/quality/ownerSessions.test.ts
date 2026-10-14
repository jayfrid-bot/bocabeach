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
    await clearSessionPushToken(h.db, b);
    expect((await sessionsWithPushToken(h.db, 5)).map((s) => s.id)).toEqual([a]);
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
