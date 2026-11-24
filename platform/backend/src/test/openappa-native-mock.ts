import { vi } from "vitest";

/**
 * Stand-in for `@archestra/openappa-rs` in the proxy-level OpenAPPA tests. The
 * real native + PostgreSQL engine is exercised by openappa-rs/smoke.test.cjs.
 *
 * Each test file registers it itself, since `vi.mock` only hoists in the file
 * that calls it:
 *
 *   vi.mock("@archestra/openappa-rs", async () =>
 *     (await import("@/test/openappa-native-mock")).native);
 */
export const native = {
  collectOpenappaMetrics: vi.fn(() => ""),
  initializeOpenappa: vi.fn<(...args: unknown[]) => Promise<void>>(),
  /** Takes the hook event as JSON and answers with the decision as JSON. */
  dispatchHook:
    vi.fn<(input: string, policy?: unknown, encryption?: unknown) => unknown>(),
  loadChildReturns: vi.fn(
    async (
      _organizationId: string,
      _parentSessionId: string,
    ): Promise<
      Array<{
        childSessionId: string;
        spawnCallId?: string;
        childNativeId?: string;
        value: string;
      }>
    > => [],
  ),
  loadChildAddresses: vi.fn(
    async (
      _organizationId: string,
      _childSessionId: string,
    ): Promise<Array<{ parentSessionId: string; value: string }>> => [],
  ),
  // No batteries declared: the composed policy is the root alone.
  listBundledOpenappaBatteries: vi.fn(async () => []),
  parseOpenappaDeclarations: vi.fn(async () => ({
    include: [],
    serverAliases: [],
    credentials: [],
    routedAnnotators: [],
    runtimeCredentials: [],
    errors: [],
  })),
  validateHostedOpenappaPolicy: vi.fn(async () => []),
  checkOpenappaLines: vi.fn(async () => []),
  composeOpenappaPolicy: vi.fn(async (input: { root: string }) => ({
    content: input.root,
    errors: [],
  })),
};
