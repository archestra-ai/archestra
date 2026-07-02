import { vi } from "vitest";

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
  return {
    // ./agent-type-permissions
    getAgentTypePermissionChecker: vi.fn(),
    hasAnyAgentTypeAdminPermission: vi.fn(),
    hasAnyAgentTypeReadPermission: vi.fn(),
    isAgentTypeAdmin: vi.fn(),
    requireAgentModifyPermission: vi.fn(),
    requireAgentTypePermission: vi.fn(),
    // ./better-auth — only the API surface tests actually exercise
    betterAuth: {
      api: {
        getSession: vi.fn(),
        verifyApiKey: vi.fn(),
        hasPermission: vi.fn(),
      },
      $context: Promise.resolve({}),
    },
    // ./fastify-plugin
    fastifyAuthPlugin: vi.fn(),
    // ./utils
    hasPermission: vi.fn(),
    userHasPermission: vi.fn(),
  };
}
