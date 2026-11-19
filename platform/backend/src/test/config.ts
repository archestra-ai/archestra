import { beforeEach } from "vitest";
import config from "@/config";
import { type DeepPartial, deepMerge } from "@/test/mocks/config";

/**
 * Applies overrides to the real config before every test:
 *
 * ```ts
 * overrideConfig({ kb: { taskWorkerPollIntervalSeconds: 1 } });
 * ```
 *
 * Replaces `vi.mock("@/config", () => configModuleMock(overrides))` for code
 * that reads the config when it runs rather than when it is imported, and
 * keeps the file in the shared-worker project. The database-backed setup
 * puts the original config back before and after every test, so the
 * overrides need no cleanup and must be applied again per test.
 */
export function overrideConfig(overrides: DeepPartial<typeof config>): void {
  beforeEach(() => {
    deepMerge(config, overrides);
  });
}
