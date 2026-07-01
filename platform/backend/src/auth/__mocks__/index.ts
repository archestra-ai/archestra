/**
 * Jest-style mock for `@/auth`, activated per test file by a bare
 * `vi.mock("@/auth");` — Vitest resolves this `__mocks__` sibling instead of
 * the real module. Delegates to the canonical factory so the mock surface
 * lives in one place; configure behavior via `vi.mocked(...)` in the test.
 *
 * NOTE: this resolution works because the `@` alias is defined with an
 * absolute path in vitest.config.ts `resolve.alias`. If the file here is ever
 * renamed/moved, bare `vi.mock("@/auth")` silently degrades to an automock of
 * the real module and dependent tests fail loudly.
 */
import { authModuleMock } from "@/test/mocks/auth";

const mock = authModuleMock();
export const {
  getAgentTypePermissionChecker,
  hasAnyAgentTypeAdminPermission,
  hasAnyAgentTypeReadPermission,
  isAgentTypeAdmin,
  requireAgentModifyPermission,
  requireAgentTypePermission,
  betterAuth,
  fastifyAuthPlugin,
  hasPermission,
  userHasPermission,
} = mock;
