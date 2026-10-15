import { describe, it, expect, afterEach } from "vitest";
import { guardAllows, guardFromHeader, guardIsActive, hashOfToken, installTokenEnforced, NO_GUARD } from "@/lib/db/installGuard";

const H = hashOfToken("tok");
const OTHER = hashOfToken("other");

describe("guardAllows (the JS twin of the SQL guard)", () => {
  it("enforcing: needs a hash on the row AND a matching token", () => {
    const g = { hash: H, enforce: true };
    expect(guardAllows(H, g)).toBe(true);
    expect(guardAllows(OTHER, g)).toBe(false);
    expect(guardAllows(null, g)).toBe(false);
    expect(guardAllows(undefined, g)).toBe(false);
    expect(guardAllows(H, { hash: null, enforce: true })).toBe(false);
    expect(guardAllows(null, { hash: null, enforce: true })).toBe(false);
  });

  it("not enforcing: no token passes; a token that is sent must not contradict the row", () => {
    expect(guardAllows(H, NO_GUARD)).toBe(true);
    expect(guardAllows(null, NO_GUARD)).toBe(true);
    const g = { hash: H, enforce: false };
    expect(guardAllows(H, g)).toBe(true);
    expect(guardAllows(null, g)).toBe(true); // row has none yet: nothing to contradict
    expect(guardAllows(OTHER, g)).toBe(false); // a wrong token is refused even now
  });

  it("guardIsActive: only a guard that can refuse something", () => {
    expect(guardIsActive(undefined)).toBe(false);
    expect(guardIsActive(NO_GUARD)).toBe(false);
    expect(guardIsActive({ hash: H, enforce: false })).toBe(true);
    expect(guardIsActive({ hash: null, enforce: true })).toBe(true);
  });
});

describe("INSTALL_TOKEN_ENFORCE", () => {
  const OLD = process.env.INSTALL_TOKEN_ENFORCE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.INSTALL_TOKEN_ENFORCE;
    else process.env.INSTALL_TOKEN_ENFORCE = OLD;
  });

  it("is off unless the flag is exactly 'on'", () => {
    delete process.env.INSTALL_TOKEN_ENFORCE;
    expect(installTokenEnforced()).toBe(false);
    process.env.INSTALL_TOKEN_ENFORCE = "true";
    expect(installTokenEnforced()).toBe(false);
    process.env.INSTALL_TOKEN_ENFORCE = "on";
    expect(installTokenEnforced()).toBe(true);
  });

  it("guardFromHeader follows it", () => {
    process.env.INSTALL_TOKEN_ENFORCE = "on";
    expect(guardFromHeader("tok")).toEqual({ hash: H, enforce: true });
    expect(guardFromHeader(null)).toEqual({ hash: null, enforce: true });
    delete process.env.INSTALL_TOKEN_ENFORCE;
    expect(guardFromHeader("tok")).toEqual({ hash: H, enforce: false });
  });
});
