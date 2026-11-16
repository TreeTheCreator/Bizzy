import { defineConfig, devices } from "@playwright/test";

// End-to-end browser tests. They need the local Supabase stack running
// (npm run db:start, npm run db:env). Locally they reuse a dev server that is
// already up; in CI they run against the production build.
const ci = !!process.env.CI;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: ci ? 1 : 0,
  reporter: ci ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: ci ? "npm run start" : "npm run dev",
    url: "http://localhost:3000/sign-in",
    reuseExistingServer: !ci,
    timeout: 120_000,
  },
});
