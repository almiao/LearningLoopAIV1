import { defineConfig, devices } from "@playwright/test";

const bffPort = process.env.E2E_BFF_PORT || "14100";
const frontendPort = process.env.E2E_FRONTEND_PORT || "13000";
const bffBaseUrl = `http://127.0.0.1:${bffPort}`;
const frontendBaseUrl = `http://127.0.0.1:${frontendPort}`;
const useExistingServices = process.env.E2E_USE_EXISTING_SERVICES === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.pw\.spec\.js/,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  expect: {
    timeout: 10000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  use: {
    baseURL: frontendBaseUrl,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1200 },
      },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 7"],
      },
    },
  ],
  webServer: useExistingServices
    ? undefined
    : [
        {
          command: "node bff/src/server.js",
          url: `${bffBaseUrl}/api/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          env: {
            ...process.env,
            PORT: bffPort,
          },
        },
        {
          command: "npm run e2e:web:start-frontend",
          url: frontendBaseUrl,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          env: {
            ...process.env,
            PORT: frontendPort,
            NEXT_PUBLIC_API_BASE_URL: bffBaseUrl,
          },
        },
      ],
});
