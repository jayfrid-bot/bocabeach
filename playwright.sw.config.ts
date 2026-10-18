import { defineConfig, devices } from "@playwright/test";

// The service worker only registers in a PRODUCTION build, so this run points at one that is
// already serving (npx opennextjs-cloudflare build && npx wrangler dev --port 8788):
//   PW_SW_BASE_URL=http://localhost:8788 npx playwright test -c playwright.sw.config.ts
// The default e2e config (playwright.config.ts, dev server) skips e2e/service-worker.spec.ts.
export default defineConfig({
  testDir: "e2e",
  testMatch: /service-worker\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: { baseURL: process.env.PW_SW_BASE_URL ?? "http://localhost:8788", serviceWorkers: "allow" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
