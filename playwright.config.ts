import { defineConfig, devices } from "@playwright/test";

// The page fetches live conditions from many external APIs (NDBC, NOAA, GOES,
// city feeds, etc). Local dev compiles + fetches on first hit, and CI has no
// API keys at all — the page must still degrade honestly and render, but
// everything is slower there. Generous timeouts throughout; see e2e/layout.spec.ts
// for how the wait is kept tolerant (footer build stamp, not live data values).
const PORT = 3100;

// CI can't reuse a dev server across jobs and dev-mode compiles pages lazily,
// so CI builds once and runs `next start`, which serves pre-compiled pages
// fast and matches production behavior. Locally we default to `next dev` on
// its own port (3100) so this never fights the owner's `npm run dev` preview
// on 3000. Override with PW_WEB_SERVER_CMD if you need something else.
const webServerCmd =
  process.env.PW_WEB_SERVER_CMD ?? `npm run dev -- -p ${PORT}`;

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: {
    timeout: 60_000,
  },
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "off", // e2e/layout.spec.ts takes its own artifact screenshots
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: webServerCmd,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
