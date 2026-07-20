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

/**
 * A freshly spawned server must stay up at least this long to count as started.
 * A quicker exit is treated as a startup failure — most often an EADDRINUSE bind
 * race because the previous server hasn't fully released 9000/9050 within
 * PORT_RELEASE_DELAY_MS — which the retry below recovers from.
 */
const SERVER_STARTUP_WINDOW_MS = 750;

/** Re-spawn attempts after a startup failure before giving up (and logging loudly). */
const SERVER_SPAWN_MAX_RETRIES = 3;

/** Fixed delay between re-spawn attempts (a local port frees in well under this). */
const SERVER_SPAWN_RETRY_DELAY_MS = 250;

type DevServerState = {
  /** The running server child, or null when none is up. */
  current: ChildProcess | null;
  /**
   * Serializes restarts. tsdown does not await onSuccess and debounces rebuilds
   * with a bare setTimeout, so a burst of saves can invoke the handler
   * re-entrantly. Chaining every invocation through one queue keeps kill→spawn
   * atomic, so a later rebuild can never overwrite `current` while an earlier
   * restart is mid-flight and orphan a server that keeps holding 9000/9050.
   */
  restartQueue: Promise<void>;
  /**
   * Id of the most recent restart request. A queued restart only spawns while it
   * is still the latest, so a burst of rebuilds collapses to a single spawn.
   * tsdown calls onSuccess only for a build that succeeded, so a failed
   * superseding build never bumps this — the last good build still spawns and
   * the server is never left stranded down.
   */
  latestRestartId: number;
  /**
   * Bumped once per module load. A config self-reload (editing this file /
   * tsconfig / package.json) loads a fresh module and runs rmSync(dist), so a
   * restart still queued under the older generation must bail before it stops
   * the server or spawns against the wiped dist — the fresh module owns it.
   */
  generation: number;
};

/**
 * Restart state is kept on globalThis so it survives a tsdown config self-reload:
 * editing this file, tsconfig, or package.json makes tsdown clear the require
 * cache and load a fresh copy of this module in the same process. A module-local
 * handle would be lost on reload — orphaning the running server, then hitting
 * EADDRINUSE on the next spawn. The process-global handle lets the reloaded
 * module find and replace the server it inherited.
 */
const globalStore = globalThis as typeof globalThis & {
  __archestraDevServer__?: DevServerState;
};
if (!globalStore.__archestraDevServer__) {
  globalStore.__archestraDevServer__ = {
    current: null,
    restartQueue: Promise.resolve(),
    latestRestartId: 0,
    generation: 0,
  };
}
const devServer = globalStore.__archestraDevServer__;

// Identify this module load; a later config self-reload gets a higher generation.
devServer.generation += 1;
const configGeneration = devServer.generation;

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
const onSuccessHandler: UserConfig["onSuccess"] = () => {
  const restartId = ++devServer.latestRestartId;
  devServer.restartQueue = devServer.restartQueue
    .then(async () => {
      // Skip if a newer build already queued its own restart, or a config
      // self-reload superseded this module. Either way, leave the running server
      // up and let the winner own the swap — the old server keeps serving until
      // the winning build is ready to spawn.
      if (
        restartId !== devServer.latestRestartId ||
        configGeneration !== devServer.generation
      ) {
        return;
      }

      if (devServer.current) {
        console.log("Stopping previous server...");
        await stopServer(devServer.current);
        devServer.current = null;
        // Give the OS a moment to release the listen sockets before rebinding.
        await new Promise((resolve) =>
          setTimeout(resolve, PORT_RELEASE_DELAY_MS),
        );
      }

      // Re-check: a newer build or a config reload may have landed while we were
      // stopping the old server. Don't spawn a stale build (or one whose dist the
      // reload wiped) over it.
      if (
        restartId !== devServer.latestRestartId ||
        configGeneration !== devServer.generation
      ) {
        return;
      }

      const spawnServer = () => {
        const args = ["--enable-source-maps"];
        if (process.env.DEBUG) {
          args.push("--inspect");
        }
        args.push("dist/server.mjs");
        // Use process.execPath (absolute path to Node.js binary) instead of the
        // "node" string for cross-platform compatibility. On Windows,
        // spawn("node", ...) can fail if Node.js isn't in PATH or PATH resolution
        // differs. We intentionally avoid shell:true so kill() reaches the actual
        // server rather than a cmd.exe wrapper (Windows orphan avoidance).
        return spawn(process.execPath, args, { stdio: "inherit" });
      };

      const isSuperseded = () =>
        restartId !== devServer.latestRestartId ||
        configGeneration !== devServer.generation;

      // Spawn the server, and if it dies during startup — almost always an
      // EADDRINUSE bind race because the old server hasn't released 9000/9050
      // within PORT_RELEASE_DELAY_MS — re-spawn a bounded number of times with
      // backoff. Without this, a single lost race left the dev server down until
      // the next save. A superseding build/reload still wins and stops the retries.
      let attempt = 0;
      const spawnWithRetry = async (): Promise<void> => {
        if (isSuperseded()) return;

        const child = spawnServer();
        devServer.current = child;
        child.on("error", (err) => {
          console.error("Server process error:", err);
        });

        // Race the child's exit against a startup window: an exit inside the
        // window means it never came up; null means it is running.
        const startupExit = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        } | null>((resolve) => {
          const onExit = (
            code: number | null,
            signal: NodeJS.Signals | null,
          ) => {
            clearTimeout(timer);
            resolve({ code, signal });
          };
          const timer = setTimeout(() => {
            child.off("exit", onExit);
            resolve(null);
          }, SERVER_STARTUP_WINDOW_MS);
          child.once("exit", onExit);
        });

        if (!startupExit) {
          // Came up. Log a later crash but don't restart it — the next
          // successful build owns the next restart.
          child.on("exit", (code, exitSignal) => {
            if (exitSignal) {
              console.log(`Server process terminated by signal: ${exitSignal}`);
            } else if (code !== 0) {
              console.error(`Server process exited with code: ${code}`);
            }
          });
          return;
        }

        // Died during startup. A signal exit means our own stop killed it during
        // a superseding restart — let that restart own the swap.
        if (startupExit.signal || isSuperseded()) {
          if (devServer.current === child) devServer.current = null;
          return;
        }

        attempt += 1;
        if (attempt > SERVER_SPAWN_MAX_RETRIES) {
          console.error(
            `Dev server failed to start after ${attempt} attempts (last exit code ${startupExit.code}); ` +
              "leaving it down until the next successful build. A stale process may be holding 9000/9050.",
          );
          if (devServer.current === child) devServer.current = null;
          return;
        }
        console.log(
          `Dev server exited on startup (code ${startupExit.code}); ports may not be free yet — retry ${attempt}/${SERVER_SPAWN_MAX_RETRIES} in ${SERVER_SPAWN_RETRY_DELAY_MS}ms...`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, SERVER_SPAWN_RETRY_DELAY_MS),
        );
        await spawnWithRetry();
      };

      await spawnWithRetry();
    })
    .catch((error) => {
      // A rejected restartQueue would skip every future rebuild's restart and
      // strand the server, so a failed restart must not poison the chain.
      console.error("Dev server restart failed:", error);
    });

  return devServer.restartQueue;
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
