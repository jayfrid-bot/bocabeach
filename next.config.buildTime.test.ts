import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

// Regression guard for the CI-only React #418 of 2026-09-23: `next build`
// evaluates next.config.mjs more than once (server + client compilations), so
// the "last built" stamp must come out identical across evaluations even when
// they happen in different seconds or minutes. We evaluate the config twice in
// separate processes, ~1.1 s apart, and require the same value.
function readBuildTime(): string {
  return execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const m = await import('./next.config.mjs'); console.log(m.default.env.NEXT_PUBLIC_BUILD_TIME);",
    ],
    { cwd: process.cwd(), env: { ...process.env, NODE_ENV: "production", NEXT_PUBLIC_BUILD_TIME: "" }, stdio: ["ignore", "pipe", "ignore"] },
  )
    .toString()
    .trim();
}

describe("NEXT_PUBLIC_BUILD_TIME", () => {
  it("is identical across separate config evaluations (no hydration drift)", async () => {
    const a = readBuildTime();
    await new Promise((r) => setTimeout(r, 1100));
    const b = readBuildTime();
    expect(a).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(b).toBe(a);
  }, 30_000);
});
