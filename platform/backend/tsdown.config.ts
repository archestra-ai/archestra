// biome-ignore-all lint/suspicious/noConsole: we use console.log for logging in this file
import { type ChildProcess, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { defineConfig, type UserConfig } from "tsdown";

/** Max time to wait for the server process to exit gracefully before force killing */
const PROCESS_EXIT_TIMEOUT_MS = 5000;

/** Grace period after SIGKILL so stopServer still resolves if no exit event arrives */
const POST_KILL_DELAY_MS = 100;

/** Delay after process exit to ensure OS releases the ports */
const PORT_RELEASE_DELAY_MS = 250;

let currentServerProcess: ChildProcess | null = null;

/**
 * Serializes server restarts. tsdown does not await onSuccess and debounces
 * rebuilds with a bare setTimeout, so a burst of saves can invoke the handler
 * re-entrantly. Chaining every invocation through one queue keeps kill→spawn
 * atomic, so a later rebuild can never overwrite currentServerProcess while an
 * earlier restart is mid-flight and orphan a server that keeps holding 9000/9050.
 */
let restartQueue: Promise<void> = Promise.resolve();

/**
 * Terminate a server process and resolve once it has exited. Always resolves
 * (via the exit event, or a bounded SIGKILL fallback) so a hung or already-dead
 * child can never wedge restartQueue and strand the dev server.
 */
const stopServer = (proc: ChildProcess): Promise<void> => {
  return new Promise((resolve) => {
    // A child is already gone once exitCode (normal exit) OR signalCode (signal
    // death, e.g. an OOM SIGKILL) is set. Node leaves exitCode null for a
    // signal-terminated child, so checking exitCode alone would miss those and
    // wait on an `exit` event that has already fired — hanging forever.
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const forceKill = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        console.log("Server did not exit after SIGTERM, sending SIGKILL...");
        proc.kill("SIGKILL");
      }
      // Resolve even if the exit event never arrives, so the queue can't wedge.
      setTimeout(resolve, POST_KILL_DELAY_MS);
    }, PROCESS_EXIT_TIMEOUT_MS);
    proc.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    proc.kill("SIGTERM");
  });
};

/**
 * Restart the dev server: stop the previous one, wait for its ports to release,
 * then spawn the freshly built server. Runs one-at-a-time via restartQueue.
 *
 * Set DEBUG=1 to enable Node.js inspector (e.g., DEBUG=1 pnpm dev)
 *
 * @see https://tsdown.dev/advanced/hooks
 */
const onSuccessHandler: UserConfig["onSuccess"] = (_config, signal) => {
  restartQueue = restartQueue.then(async () => {
    if (currentServerProcess) {
      console.log("Stopping previous server...");
      await stopServer(currentServerProcess);
      currentServerProcess = null;
      // Give the OS a moment to release the listen sockets before rebinding.
      await new Promise((resolve) =>
        setTimeout(resolve, PORT_RELEASE_DELAY_MS),
      );
    }

    // tsdown aborts this build's signal when a newer rebuild starts; don't spawn
    // a superseded server (the next queued restart owns the current build).
    if (signal.aborted) {
      return;
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
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
    });
    currentServerProcess = child;

    child.on("error", (err) => {
      console.error("Server process error:", err);
    });

    child.on("exit", (code, exitSignal) => {
      if (exitSignal) {
        console.log(`Server process terminated by signal: ${exitSignal}`);
      } else if (code !== 0) {
        console.error(`Server process exited with code: ${code}`);
      }
    });
  });

  return restartQueue;
};

export default defineConfig((options: UserConfig) => {
  // The MCP-App connector inlines a self-contained ext-apps bundle into the
  // resource for a strict foreign host; generate it into src/static (copied to
  // dist/static below) on every build/watch so it tracks the installed version.
  // Inlined here rather than imported because tsdown's native config loader
  // can't resolve a TS module; the same build runs in vitest global-setup via
  // src/standalone-scripts/build-ext-apps-inline.ts for `pnpm test`.
  buildSync({
    stdin: {
      contents:
        'import * as ExtApps from "@modelcontextprotocol/ext-apps/app-with-deps";\nglobalThis.__ARCHESTRA_EXT_APPS__ = ExtApps;',
      resolveDir: process.cwd(),
      loader: "js",
    },
    bundle: true,
    format: "iife",
    minify: true,
    platform: "browser",
    legalComments: "eof",
    outfile: path.join(process.cwd(), "src/static/ext-apps-app.global.js"),
  });

  // Clean dist directory once at startup in watch mode.
  // This runs here (instead of in package.json) to keep the logic self-contained
  // and avoid platform-specific shell commands.
  if (options.watch) {
    rmSync("dist", { recursive: true, force: true });
  }

  return {
    // Spread CLI options first so our config takes precedence
    ...options,

    // Bundle server and standalone scripts that need to run in production
    entry: [
      "src/server.ts",
      "src/standalone-scripts/reset-user-password.ts",
      "src/standalone-scripts/vault-env-injector.ee.ts",
      "src/standalone-scripts/migrate-byos-to-vault/migrate.ee.ts",
    ],

    // Copy SQL migrations and other assets that need to exist at runtime
    copy: ["src/database/migrations", "src/static"],

    // Only clean if NOT in watch mode, to avoid race conditions during rebuilds where
    // the output directory is deleted while the server process is trying to restart.
    // In watch mode, we clean once at startup (see above) instead of on every rebuild.
    clean: !options.watch,
    format: ["esm" as const],

    // Generate source maps for better stack traces
    sourcemap: true,

    // Don't bundle dependencies - use them from node_modules, except for @archestra/shared (including subpaths)
    noExternal: [/^@archestra\/shared/],
    loader: {
      ".py": "text" as const,
    },
    tsconfig: "./tsconfig.json",

    ignoreWatch: [
      ".turbo",
      "**/.turbo/**",
      "**/*.test.ts",
      "**/*.spec.ts",
      "src/test/**/*",
      "src/standalone-scripts/**/*",
      "src/entrypoints/**/*",
    ],

    // Only set onSuccess handler when in watch mode
    onSuccess: options.watch ? onSuccessHandler : undefined,
  };
});
