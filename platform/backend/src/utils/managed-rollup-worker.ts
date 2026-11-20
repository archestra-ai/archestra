import { spawn } from "node:child_process";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import logger from "@/logging";

// The Rust worker gives an active rollup up to 30 seconds to drain.
export const ROLLUP_SHUTDOWN_BUDGET_MS = 35_000;

export function startManagedRollupWorker(onUnexpectedExit: () => void) {
  const directory = mkdtempSync(join(tmpdir(), "archestra-rollup-"));
  const child = spawn("archestra-worker", [], {
    env: { ...process.env, ARCHESTRA_NATIVE_RUNTIME_DIR: directory },
    stdio: "inherit",
  });
  let stopping = false;
  let closed = false;
  const exit = new Promise<boolean>((resolve) => {
    child.on("error", (err) => {
      logger.error({ err }, "Could not run Rust rollup worker");
    });
    child.once("close", (code, signal) => {
      closed = true;
      try {
        rmSync(join(directory, "worker.ready"), { force: true });
        rmdirSync(directory);
      } catch (err) {
        logger.warn({ err }, "Could not remove Rust rollup runtime directory");
      }
      resolve(code === 0);
      if (!stopping) {
        logger.error(
          { code, signal },
          "Rust rollup worker exited unexpectedly",
        );
        onUnexpectedExit();
      }
    });
  });
  return {
    directory,
    get running() {
      return !stopping && !closed;
    },
    async stop() {
      stopping = true;
      if (!closed && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      if (!(await exit))
        throw new Error("Rust rollup worker did not exit cleanly");
    },
  };
}
