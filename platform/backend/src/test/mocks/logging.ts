import { vi } from "vitest";

/**
 * Canonical module mock for `@/logging`, for tests that ASSERT on logger
 * calls. Activated with a bare `vi.mock("@/logging");` — Vitest resolves the
 * Jest-style `src/logging/__mocks__/index.ts`, which re-exports this factory:
 *
 * ```ts
 * vi.mock("@/logging");
 *
 * import logger from "@/logging";
 * expect(vi.mocked(logger.error)).toHaveBeenCalledWith(...);
 * ```
 *
 * Tests that mock `@/logging` merely to SILENCE it should drop the mock
 * instead: the shared test setup already runs the real logger at level
 * "silent", and dropping the last `vi.mock` moves the file into the
 * non-isolated (fast) vitest project.
 *
 * A module mock is required for assertions because the real export is a
 * Proxy whose `get` returns methods bound to a private pino instance —
 * `vi.spyOn(logger, "error")` cannot intercept it.
 */
export function loggingModuleMock() {
  const logger = {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: "silent",
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { default: logger };
}
