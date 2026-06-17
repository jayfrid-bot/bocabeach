import { describe, it, expect, afterEach } from "vitest";
import { readPemEnv } from "@/lib/push/pemEnv";

const PEM = "-----BEGIN PRIVATE KEY-----\nMIGabc\n-----END PRIVATE KEY-----\n";

afterEach(() => {
  delete process.env.TESTKEY;
  delete process.env.TESTKEY_B64;
});

describe("readPemEnv", () => {
  it("decodes the base64 form (CLI-safe) when present", () => {
    process.env.TESTKEY_B64 = Buffer.from(PEM).toString("base64");
    process.env.TESTKEY = "ignored";
    expect(readPemEnv("TESTKEY")).toBe(PEM);
  });

  it("unescapes literal \\n in the raw form", () => {
    process.env.TESTKEY = "-----BEGIN PRIVATE KEY-----\\nMIGabc\\n-----END PRIVATE KEY-----";
    expect(readPemEnv("TESTKEY")).toBe(
      "-----BEGIN PRIVATE KEY-----\nMIGabc\n-----END PRIVATE KEY-----",
    );
  });

  it("returns '' when neither var is set", () => {
    expect(readPemEnv("TESTKEY")).toBe("");
  });
});
