import { defineConfig, devices } from "@playwright/test";
import { DEVICE_MATRIX_TAG } from "./tests/browser/device-matrix";

const deviceMatrix = new RegExp(`${DEVICE_MATRIX_TAG}\\b`);

export default defineConfig({
  testDir: "./tests/browser",
  // Multi-page Webxdc cases share an origin-scoped localStorage transport.
  // Keep tests within each file sequential; app.spec additionally serializes
  // same-test page appends so the browser stub models one durable log.
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    channel: "chromium",
    trace: "retain-on-failure",
  },
  projects: [
    // Desktop is the canonical behavioral suite. Portrait only repeats tests
    // whose assertions intentionally depend on viewport or device rendering.
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "portrait",
      grep: deviceMatrix,
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: true,
  },
});
