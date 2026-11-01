import { vi } from "vitest";
import type { MockFunction } from "./mock-function";

/**
 * Canonical module mock for `@/auth`.
 *
 * Test files activate it with a bare `vi.mock("@/auth");` — Vitest resolves
 * the Jest-style `src/auth/__mocks__/index.ts`, which re-exports this
 * factory's surface:
 *
 * ```ts
 * vi.mock("@/auth");
 *
 * import { hasPermission } from "@/auth";
 *
 * beforeEach(() => {
 *   vi.mocked(hasPermission).mockResolvedValue({ success: true, error: null });
 * });
 * ```
 *
 * Every export of `@/auth` is a bare `vi.fn()` — configure behavior per test
 * via `vi.mocked(...)` instead of writing a bespoke factory. Keeping one
 * canonical shape avoids the drift of 40+ hand-rolled partial factories and
 * the vitest pitfall of mixing automocks and factory mocks for the same
 * specifier (vitest-dev/vitest#10145).
 */
export function authModuleMock() {
  const getAgentTypePermissionChecker = vi.fn<MockFunction>();
  return {
    // ./agent-type-permissions
    getAgentTypePermissionChecker,
    // A full checker answers every list question, so lists follow whatever
    // checker a test configures unless the test overrides this one.
    getAgentTypeListPermissionChecker: vi.fn<MockFunction>((...args) =>
      getAgentTypePermissionChecker(...args),
    ),
    hasAnyAgentTypeAdminPermission: vi.fn<MockFunction>(),
    hasAnyAgentTypeReadPermission: vi.fn<MockFunction>(),
    isAgentTypeAdmin: vi.fn<MockFunction>(),
    requireAgentModifyPermission: vi.fn<MockFunction>(),
    requireAgentTypePermission: vi.fn<MockFunction>(),
    // ./better-auth — only the API surface tests actually exercise
    betterAuth: {
      api: {
        getSession: vi.fn<MockFunction>(),
        verifyApiKey: vi.fn<MockFunction>(),
        hasPermission: vi.fn<MockFunction>(),
      },
      $context: Promise.resolve({}),
    },
    // ./fastify-plugin
    fastifyAuthPlugin: vi.fn<MockFunction>(),
    // ./utils
    hasPermission: vi.fn<MockFunction>(),
    isGlobalAdmin: vi.fn<MockFunction>(),
    userHasPermission: vi.fn<MockFunction>(),
  };
}
