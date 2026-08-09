import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { DEVICE_MATRIX_TAG } from "./tests/browser/device-matrix";

const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.platform === "darwin" && existsSync(macChrome)
  ? macChrome
  : undefined;
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
    trace: "retain-on-failure",
    ...(executablePath === undefined ? {} : { launchOptions: { executablePath } }),
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
