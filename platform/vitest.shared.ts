/**
 * Log policy shared by every workspace's Vitest config (backend, frontend,
 * shared) — the single place that decides what test runs print.
 *
 * Tests and the code they exercise emit a lot of *expected* noise — error-path
 * console.error, library warnings, request/JSON log lines — and Vitest echoes
 * each one as a per-test `stdout | … > …` block, burying real failures in
 * local and CI output. `passed-only` mutes console output from passing tests
 * while keeping exactly the output that matters: failing tests still print
 * everything they logged.
 *
 * Set `ARCHESTRA_TEST_VERBOSE_LOGS=true` to print all test console output
 * again while debugging a specific run.
 */
export const vitestLogPolicy: { silent: boolean | "passed-only" } = {
  silent:
    process.env.ARCHESTRA_TEST_VERBOSE_LOGS === "true" ? false : "passed-only",
};
