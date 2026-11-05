import { beforeEach, vi } from "vitest";
import logger from "@/logging";

/**
 * Spies on the real logger, silenced, so a test can assert what was logged:
 *
 * ```ts
 * import logger from "@/logging";
 * import { spyOnLogger } from "@/test/logging";
 *
 * spyOnLogger();
 * expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(...);
 * ```
 *
 * Call it once at the top of the file. Unlike `vi.mock("@/logging")`, it
 * keeps the file in the shared-worker project. `child()` returns the logger
 * itself, so what a child logs is captured too. The spies are applied again
 * before every test, so a `vi.restoreAllMocks()` in the file does not remove
 * them; Vitest restores them after the file.
 */
export function spyOnLogger(): void {
  installLoggerSpies();
  beforeEach(installLoggerSpies);
}

// ===

function installLoggerSpies(): void {
  for (const level of LEVELS) {
    vi.spyOn(logger, level).mockImplementation(() => {});
  }
  vi.spyOn(logger, "child").mockReturnValue(logger);
}

const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
