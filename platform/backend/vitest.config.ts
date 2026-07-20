import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

const isCI = process.env.CI === "true";

/**
 * Partition test files by whether they use Vitest module mocking.
 *
 * `vi.mock`/`vi.doMock` registrations live in the worker's shared module/mock
 * registry, which Vitest does NOT reset between files when `isolate: false`
 * (see https://vitest.dev/guide/improving-performance and
 * vitest-dev/vitest#4894, #10145) — so mock-using files must keep isolation,
 * while everything else can share each worker's module cache and skip
 * re-importing the whole backend graph per file (~6s/file saved).
 *
 * Routing is computed from file CONTENT at config-load time, so a new test
 * that adds `vi.mock` is automatically placed in the isolated project — no
 * manual list to maintain.
 */
function partitionTestFiles(): { mocked: string[]; clean: string[] } {
  const root = path.resolve(__dirname, "./src");
  const usesModuleMocks = /\bvi\.(mock|doMock|unmock|doUnmock|hoisted)\(/;
  const mocked: string[] = [];
  const clean: string[] = [];

  for (const entry of readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const relative = `./${path.relative(__dirname, absolute)}`;
    if (usesModuleMocks.test(readFileSync(absolute, "utf-8"))) {
      mocked.push(relative);
    } else {
      clean.push(relative);
    }
  }

  if (mocked.length === 0 || clean.length === 0) {
    throw new Error(
      `Test partition looks wrong (mocked=${mocked.length}, clean=${clean.length}); ` +
        "check partitionTestFiles() in vitest.config.ts",
    );
  }

  return { mocked, clean };
}

const testFiles = partitionTestFiles();

export default defineConfig({
  plugins: [rawPythonPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@archestra/shared/access-control": path.resolve(
        __dirname,
        "../shared/access-control.ts",
      ),
      "@archestra/shared": path.resolve(__dirname, "../shared/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    // Build the migrated schema once and snapshot it (see global-setup.ts); each test
    // file's beforeAll then loads the snapshot instead of replaying all migrations.
    // Root-level only: it must run ONCE per run, not once per project below.
    globalSetup: ["./src/test/global-setup.ts"],
    setupFiles: ["./src/test/setup.ts"],

    /**
     * Performance Optimizations
     *
     * Based on:
     * - https://vitest.dev/guide/improving-performance
     * - https://vitest.dev/guide/profiling-test-performance
     *
     * Isolation is per-project (see `projects` below): files that never touch
     * the module-mock registry run with `isolate: false`, sharing each
     * worker's module cache instead of re-importing the whole backend graph
     * per file — the dominant cost of the suite. Files using vi.mock keep
     * isolation because Vitest's mock registry is not reset between files in
     * a shared worker (vitest-dev/vitest#4894).
     *
     * DB state stays per-file either way (setup.ts):
     * - beforeAll: creates PGlite from the migrated snapshot ONCE per file
     * - beforeEach: truncates tables (fast) instead of recreating DB
     */

    // Forks (child processes), not threads. PGlite is a WASM module; running
    // it across worker threads sharing one process-global V8 JIT-page registry
    // intermittently aborts the whole process with a fatal
    // "Check failed: jit_page.has_value()" (and its sibling on unregister).
    // Forks give each worker its own V8, so the registry can't be raced. This
    // is Vitest's default pool, recommended for native modules that misbehave
    // across threads (https://vitest.dev/config/pool); pinned explicitly so a
    // switch back to threads for speed can't silently reintroduce the crash.
    pool: "forks",

    // Auto-restore vi.stubGlobal/vi.stubEnv after every test. Without this, a
    // stub left behind by one test file poisons later files sharing the worker.
    unstubGlobals: true,
    unstubEnvs: true,

    // Bound the fork count by BOTH cores and memory. CPU half: 50% of cores
    // locally (leaves the other half for the human); CI runs all cores because
    // the memory cap below is the real limit there. Memory half: with the forks
    // pool each worker loads the full module graph + its own PGlite (WASM)
    // independently — up to ~3 GB RSS per fork, not shared like the threads
    // pool's single address space — so cap at ~5 GB/fork or a shard OOM-kills
    // the runner (cgroup OOM aborts a worker abruptly, not with a clean Vitest
    // error). Yields 12 forks on the 16-vCPU / 64-GB CI runner, and half-cores
    // (memory permitting) locally. The memory cap trusts os.totalmem() to report
    // real available RAM — valid on the bare-VM CI runner, but it would
    // over-report (and stop protecting) inside a cgroup-limited container.
    maxWorkers: Math.min(
      isCI
        ? os.availableParallelism()
        : Math.max(1, Math.floor(os.availableParallelism() * 0.5)),
      Math.max(1, Math.floor(os.totalmem() / (5 * 1024 ** 3))),
    ),

    // Increase concurrency on CI for faster test execution
    maxConcurrency: isCI ? 12 : 6,

    // Sequence settings
    sequence: {
      // Shuffle test files to balance load across workers
      shuffle: true,
    },

    // Increase test timeout for database operations
    testTimeout: 30000,

    // Hook timeout for beforeAll/afterAll (migrations can take time)
    hookTimeout: 60000,

    projects: [
      {
        extends: true,
        test: {
          name: "clean",
          include: testFiles.clean,
          isolate: false,
          // Workers are shared in this project, so the test setup restores
          // shared mutable state (the config object) between tests. The
          // isolated project skips that — its per-file registries can't leak,
          // and exotic config mocks (getter-only properties) would break it.
          env: { ARCHESTRA_TEST_SHARED_WORKERS: "true" },
          // Inherit everything else from root, but globalSetup must not be
          // re-run per project — the snapshot is built once at the root.
          globalSetup: [],
        },
      },
      {
        extends: true,
        test: {
          name: "mocked",
          include: testFiles.mocked,
          isolate: true,
          globalSetup: [],
        },
      },
    ],
  },
});

function rawPythonPlugin() {
  return {
    name: "raw-python",
    enforce: "pre" as const,
    async load(id: string) {
      if (!id.endsWith(".py")) return null;
      const source = await readFile(id, "utf-8");
      return `export default ${JSON.stringify(source)};`;
    },
  };
}
