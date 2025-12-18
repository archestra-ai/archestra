// biome-ignore-all lint/suspicious/noConsole: we use console.log for logging in this file
import { type ChildProcess, spawn } from "node:child_process";
import { defineConfig, type UserConfig } from "tsdown";

/**
 * Track the current server process so we can properly terminate it before starting a new one.
 * This prevents EADDRINUSE errors by ensuring the old process fully exits before the new one starts.
 */
let currentServerProcess: ChildProcess | null = null;

/**
 * Wait for the current server process to exit, with a timeout.
 * Returns a promise that resolves when the process exits or times out.
 */
const waitForProcessExit = (
  proc: ChildProcess,
  timeoutMs = 5000,
): Promise<void> => {
  return new Promise((resolve) => {
    // If process already exited, resolve immediately
    if (proc.exitCode !== null || proc.killed) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      // Force kill if still running after timeout
      if (proc.exitCode === null && !proc.killed) {
        console.log("Server process did not exit in time, force killing...");
        proc.kill("SIGKILL");
      }
      // Give it a moment to die
      setTimeout(resolve, 100);
    }, timeoutMs);

    proc.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
};

/**
 * Properly manage server process lifecycle.
 * Before starting a new server, we terminate and wait for the old one to fully exit.
 * This prevents EADDRINUSE errors on the metrics port (9050) and main port (9000).
 *
 * Set DEBUG=1 to enable Node.js inspector (e.g., DEBUG=1 pnpm dev)
 *
 * @see https://tsdown.dev/advanced/hooks
 */
const onSuccessHandler: UserConfig["onSuccess"] = async () => {
  // Kill and wait for the previous server to fully exit before starting a new one
  if (currentServerProcess && currentServerProcess.exitCode === null) {
    console.log("Stopping previous server...");
    currentServerProcess.kill("SIGTERM");
    await waitForProcessExit(currentServerProcess);

    // Add a small delay to ensure OS releases the ports (EADDRINUSE prevention)
    await new Promise((resolve) => setTimeout(resolve, 250));

    console.log("Previous server stopped");
  }

  const args = ["--enable-source-maps"];

  if (process.env.DEBUG) {
    args.push("--inspect");
  }

  args.push("dist/server.mjs");

  // Use process.execPath (absolute path to Node.js binary) instead of "node" string
  // for cross-platform compatibility. On Windows, spawn("node", ...) can fail if
  // Node.js isn't in PATH or PATH resolution behaves differently. Using the absolute
  // path bypasses PATH resolution entirely.
  // Note: We intentionally avoid shell: true to prevent orphaned processes on Windows
  // (shell creates cmd.exe as parent, making kill() ineffective on the actual server).
  currentServerProcess = spawn(process.execPath, args, {
    stdio: "inherit",
  });

  currentServerProcess.on("error", (err) => {
    console.error("Server process error:", err);
  });

  currentServerProcess.on("exit", (code, signal) => {
    if (signal) {
      console.log(`Server process terminated by signal: ${signal}`);
    } else if (code !== 0) {
      console.error(`Server process exited with code: ${code}`);
    }
  });

  // Return immediately so tsdown can continue watching for changes
  // The server runs in the background
};

export default defineConfig((options: UserConfig) => {
  return {
    // Spread CLI options first so our config takes precedence
    ...options,

    // Only bundle the server entry point
    entry: ["src/server.ts"],

    // Copy SQL migrations and other assets that need to exist at runtime
    copy: ["src/database/migrations"],

    // Only clean if NOT in watch mode, to avoid race conditions during rebuilds where
    // the output directory is deleted while the server process is trying to restart.
    // In dev mode, we handle cleaning explicitly in the package.json script.
    clean: !options.watch,
    format: ["esm" as const],

    // Generate source maps for better stack traces
    sourcemap: true,

    // Don't bundle dependencies - use them from node_modules, except for @shared (including subpaths)
    noExternal: [/^@shared/],
    tsconfig: "./tsconfig.json",

    ignoreWatch: [
      ".turbo",
      "**/.turbo/**",
      "**/*.test.ts",
      "**/*.spec.ts",
      "src/test/**/*",
      "src/standalone-scripts/**/*",
    ],

    // Only set onSuccess handler when in watch mode
    onSuccess: options.watch ? onSuccessHandler : undefined,
  };
});
