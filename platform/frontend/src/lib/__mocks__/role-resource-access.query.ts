/**
 * Jest-style mock for `@/lib/role-resource-access.query`, activated per test
 * file by a bare `vi.mock("@/lib/role-resource-access.query");`. Defaults to an
 * unrestricted role — what almost every test wants — and is configured per test
 * via `vi.mocked(useMyResourceAccess).mockReturnValue(...)`.
 */
import { UNRESTRICTED_ROLE_RESOURCE_ACCESS } from "@archestra/shared";
import { vi } from "vitest";

const actual = await vi.importActual<
  typeof import("@/lib/role-resource-access.query")
>("@/lib/role-resource-access.query");

export const roleResourceAccessKeys = actual.roleResourceAccessKeys;

export const useMyResourceAccess = vi.fn(
  () => UNRESTRICTED_ROLE_RESOURCE_ACCESS,
);
