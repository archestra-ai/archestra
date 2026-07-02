/**
 * Jest-style mock for `@/lib/auth/auth.query`, activated per test file by a
 * bare `vi.mock("@/lib/auth/auth.query");`. Every hook is a bare `vi.fn()` —
 * configure per test via `vi.mocked(useHasPermissions).mockReturnValue(...)`.
 * The query-key helpers stay real (pure data, safe everywhere).
 */
import { vi } from "vitest";

const actual = await vi.importActual<typeof import("@/lib/auth/auth.query")>(
  "@/lib/auth/auth.query",
);

export const authQueryKeys = actual.authQueryKeys;
export const useSession = vi.fn();
export const useCurrentOrgMembers = vi.fn();
export const useHasPermissions = vi.fn();
export const useMissingPermissions = vi.fn();
export const useAllPermissions = vi.fn();
export const usePermissionMap = vi.fn();
export const useDefaultCredentialsEnabled = vi.fn();
