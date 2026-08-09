import type { ChildProcess } from "node:child_process";

export function terminateSubagentProcess(process: ChildProcess, gracePeriodMs = 5_000): void {
  process.kill("SIGTERM");
  const forceKillTimer = setTimeout(() => {
    if (process.exitCode === null && process.signalCode === null) {
      process.kill("SIGKILL");
    }
  }, gracePeriodMs);
  forceKillTimer.unref();
  process.once("close", () => clearTimeout(forceKillTimer));
}
