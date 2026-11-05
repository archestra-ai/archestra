import { vi } from "vitest";
import type { MockFunction } from "./mock-function";

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
 * Tests that only assert on logger calls should prefer `spyOnLogger()` from
 * `@/test/logging`, which spies on the real logger and keeps the file in the
 * fast project. This mock remains for files that already need module mocks.
 */
export function loggingModuleMock() {
  const logger = {
    fatal: vi.fn<MockFunction>(),
    error: vi.fn<MockFunction>(),
    warn: vi.fn<MockFunction>(),
    info: vi.fn<MockFunction>(),
    debug: vi.fn<MockFunction>(),
    trace: vi.fn<MockFunction>(),
    silent: vi.fn<MockFunction>(),
    level: "silent",
    child: vi.fn<MockFunction>(),
  };
  logger.child.mockReturnValue(logger);
  return { default: logger };
}
