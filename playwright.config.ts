import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.platform === "darwin" && existsSync(macChrome)
  ? macChrome
  : undefined;

export default defineConfig({
  testDir: "./tests/browser",
  // Multi-page Webxdc cases share an origin-scoped localStorage transport.
  // Keep tests within each file sequential so concurrent read/append cycles
  // cannot overwrite the browser stub's update log.
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    ...(executablePath === undefined ? {} : { launchOptions: { executablePath } }),
  },
  projects: [
    { name: "portrait", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: true,
  },
});
