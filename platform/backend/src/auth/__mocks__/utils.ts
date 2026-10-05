/**
 * Jest-style mock for `@/auth/utils`, activated per test file by a bare
 * `vi.mock("@/auth/utils");`. Needed separately from the `@/auth` mock when
 * the code under test imports from "@/auth/utils" directly — module mocks
 * match specifiers, not re-exports.
 */
import { vi } from "vitest";

export const hasPermission = vi.fn();
export const userHasPermission = vi.fn();
export const getPermissionsForUserContext = vi.fn();
