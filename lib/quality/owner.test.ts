import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_SQLITE, makeCamDb, type CamDb } from "@/lib/camFrames/testDb";
import { resetMemoryRateLimit } from "@/lib/plus/rateLimit";
import {
  enrollCodeMatches,
  enrollOwner,
  enrollmentConfigured,
  MAX_OWNER_BODY_BYTES,
  readOwnerBody,
  requireOwner,
} from "@/lib/quality/owner";
import { OWNER_HEADERS } from "@/lib/quality/ownerHeaders";
import { newOwnerToken } from "@/lib/quality/ownerSessions";
import { seedOwnerSession } from "@/lib/quality/testHelpers";

const CODE = "enrol-code-0123456789abcdef";

let h: CamDb;
beforeEach(() => {
  resetMemoryRateLimit();
  process.env.OWNER_ENROLL_CODE = CODE;
  h = makeCamDb({ allMigrations: true }) as CamDb;
});
afterEach(() => {
  delete process.env.OWNER_ENROLL_CODE;
  vi.restoreAllMocks();
  h?.close();
});

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://x/api/quality/owner/x", { method: "POST", headers, body });
const json = (o: unknown) => JSON.stringify(o);

describe("the enrollment code", () => {
  it("must be set, and long enough to be a secret", () => {
    expect(enrollmentConfigured(CODE)).toBe(true);
    expect(enrollmentConfigured(undefined)).toBe(false);
    expect(enrollmentConfigured("")).toBe(false);
    expect(enrollmentConfigured("short")).toBe(false);
  });

  it("matches only itself, whatever the length of the guess", async () => {
    expect(await enrollCodeMatches(CODE)).toBe(true);
    for (const bad of [CODE.slice(0, -1), `${CODE}x`, "", CODE.toUpperCase(), 5, null, undefined, {}]) expect(await enrollCodeMatches(bad)).toBe(false);
    delete process.env.OWNER_ENROLL_CODE;
    expect(await enrollCodeMatches(CODE)).toBe(false);
  });
});

describe.skipIf(!HAS_SQLITE)("enrollOwner", () => {
  it("trades the right code for a token, stored only as a hash", async () => {
    const r = await enrollOwner(post(null), h.db, { code: CODE, deviceId: "dev-1" });
    expect(r).toEqual({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    const token = (r as { token: string }).token;
    const rows = h.all("SELECT device_id, token_hash, revoked FROM owner_sessions");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ device_id: "dev-1", revoked: 0 });
    expect(JSON.stringify(rows)).not.toContain(token);
    // and that token now opens the owner area
    const gate = await requireOwner(post(null, { authorization: `Bearer ${token}` }), h.db);
    expect(gate).not.toBeInstanceOf(Response);
  });

  it("refuses a wrong code with no session made", async () => {
    const r = (await enrollOwner(post(null), h.db, { code: "wrong-code-0123456789abcdef" })) as Response;
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ ok: false, error: "bad-code" });
    expect(h.all("SELECT COUNT(*) AS n FROM owner_sessions")[0].n).toBe(0);
  });

  it("is closed while no code is set", async () => {
    delete process.env.OWNER_ENROLL_CODE;
    const r = (await enrollOwner(post(null), h.db, { code: CODE })) as Response;
    expect(r.status).toBe(503);
  });

  it("slows a guesser down: 5 tries an hour from one address, and the code is never what is rate limited on", async () => {
    const req = () => new Request("http://x", { method: "POST", headers: { "cf-connecting-ip": "9.9.9.9" } });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push(((await enrollOwner(req(), h.db, { code: `guess-${i}-0123456789abcdef` })) as Response).status);
    expect(codes).toEqual([403, 403, 403, 403, 403, 429, 429]);
    // even the RIGHT code is refused while the guesser is locked out: the limit is not a hint
    expect(((await enrollOwner(req(), h.db, { code: CODE })) as Response).status).toBe(429);
    // a different address is not locked out
    const other = new Request("http://x", { method: "POST", headers: { "cf-connecting-ip": "8.8.8.8" } });
    expect(await enrollOwner(other, h.db, { code: CODE })).toEqual({ token: expect.any(String) });
  });

  it("a flood from many addresses is stopped by the overall limit", async () => {
    let last: unknown = null;
    for (let i = 0; i < 21; i++) {
      last = await enrollOwner(new Request("http://x", { method: "POST", headers: { "cf-connecting-ip": `7.7.${i}.1` } }), h.db, { code: `guess-${i}-0123456789abcdef` });
    }
    expect((last as Response).status).toBe(429);
  });

  it("never echoes or logs the code", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const r = (await enrollOwner(post(null), h.db, { code: "wrong-code-0123456789abcdef" })) as Response;
    expect(JSON.stringify(await r.json())).not.toContain("wrong-code");
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain("wrong-code");
  });
});

describe.skipIf(!HAS_SQLITE)("requireOwner", () => {
  const bearer = (t: string) => post(null, { authorization: `Bearer ${t}` });
  const status = async (r: Response | { id: number }) => (r instanceof Response ? { status: r.status, body: await r.json() } : "ok");

  it("lets an enrolled phone through with its token", async () => {
    const { token } = await seedOwnerSession(h.db);
    expect(await status(await requireOwner(bearer(token), h.db))).toBe("ok");
  });

  it("a device id is not a credential: the old gate (an id plus an install token) opens nothing", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const r = await requireOwner(post(json({ deviceId: id }), { "x-install-token": "anything" }), h.db);
    expect(await status(r)).toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
  });

  it("refuses no token, an unknown token, a malformed token, and a revoked session", async () => {
    const { token } = await seedOwnerSession(h.db);
    expect((await status(await requireOwner(post(null), h.db))) as { status: number }).toMatchObject({ status: 401 });
    expect(await status(await requireOwner(bearer(newOwnerToken()), h.db))).toMatchObject({ status: 401 });
    expect(await status(await requireOwner(bearer("nope"), h.db))).toMatchObject({ status: 401 });
    h.exec("UPDATE owner_sessions SET revoked = 1");
    expect(await status(await requireOwner(bearer(token), h.db))).toMatchObject({ status: 401 });
  });

  it("the token is not accepted from the body or a query string", async () => {
    const { token } = await seedOwnerSession(h.db);
    expect(await status(await requireOwner(post(json({ token })), h.db))).toMatchObject({ status: 401 });
    expect(await status(await requireOwner(new Request(`http://x/?token=${token}`, { method: "POST" }), h.db))).toMatchObject({ status: 401 });
  });

  it("every refusal carries the owner headers: private, uncached, never framed", async () => {
    const r = (await requireOwner(post(null), h.db)) as Response;
    for (const [k, v] of Object.entries(OWNER_HEADERS)) expect(r.headers.get(k)).toBe(v);
    expect(r.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
  });

  it("slows down a flood from one address", async () => {
    const flood = () => requireOwner(new Request("http://x", { headers: { "cf-connecting-ip": "9.9.9.9", authorization: `Bearer ${newOwnerToken()}` } }), h.db);
    let last: Response | { id: number } = { id: 0 };
    for (let i = 0; i < 241; i++) last = await flood();
    expect(last instanceof Response && last.status).toBe(429);
  });

  it("answers 500, not a stack trace, when the database fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { token } = await seedOwnerSession(h.db);
    h.exec("DROP TABLE owner_sessions");
    const r = (await requireOwner(bearer(token), h.db)) as Response;
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ ok: false, error: "store-unavailable" });
  });
});

describe("readOwnerBody: a streaming size cap", () => {
  it("reads a small JSON object, and an empty body is {}", async () => {
    expect(await readOwnerBody(post(json({ a: 1 })))).toEqual({ ok: true, body: { a: 1 } });
    expect(await readOwnerBody(post(null))).toEqual({ ok: true, body: {} });
  });

  it("refuses an array, junk, and a non-object", async () => {
    for (const bad of ["[1]", "{nope", "5", '"x"', "null"]) expect(await readOwnerBody(post(bad))).toMatchObject({ ok: false, status: 400 });
  });

  it("stops reading at the cap and never buffers the rest (no Content-Length to trust)", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024).fill(0x61);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 200) return controller.close();
        controller.enqueue(chunk);
      },
    });
    const req = new Request("http://x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(await readOwnerBody(req)).toMatchObject({ ok: false, status: 413, error: "too-large" });
    expect(pulled).toBeLessThanOrEqual(Math.ceil(MAX_OWNER_BODY_BYTES / 1024) + 3);
  });
});
