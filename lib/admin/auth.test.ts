import { describe, it, expect, afterEach, vi } from "vitest";
import { isValidAdminToken, adminPageAllowed, adminApiAllowed } from "@/lib/admin/auth";

afterEach(() => vi.unstubAllEnvs());

describe("isValidAdminToken", () => {
  it("fails closed when ADMIN_TOKEN is unset", () => {
    vi.stubEnv("ADMIN_TOKEN", "");
    expect(isValidAdminToken("anything")).toBe(false);
    expect(isValidAdminToken("")).toBe(false);
  });
  it("matches only the configured secret", () => {
    vi.stubEnv("ADMIN_TOKEN", "s3cret");
    expect(isValidAdminToken("s3cret")).toBe(true);
    expect(isValidAdminToken("wrong")).toBe(false);
    expect(isValidAdminToken("")).toBe(false);
    expect(isValidAdminToken(null)).toBe(false);
  });
});

describe("admin gates", () => {
  it("are open in non-production (local dev)", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ADMIN_TOKEN", "");
    expect(adminPageAllowed("whatever")).toBe(true);
    expect(adminApiAllowed(new Request("http://x/api"))).toBe(true);
  });
  it("require a valid token in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_TOKEN", "s3cret");
    expect(adminPageAllowed("s3cret")).toBe(true);
    expect(adminPageAllowed("nope")).toBe(false);
    expect(adminApiAllowed(new Request("http://x/api?token=s3cret"))).toBe(true);
    expect(adminApiAllowed(new Request("http://x/api?token=nope"))).toBe(false);
    expect(
      adminApiAllowed(new Request("http://x/api", { headers: { "x-admin-token": "s3cret" } })),
    ).toBe(true);
  });
  it("fail closed in production with no token configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_TOKEN", "");
    expect(adminPageAllowed("anything")).toBe(false);
    expect(adminApiAllowed(new Request("http://x/api?token=anything"))).toBe(false);
  });
});
