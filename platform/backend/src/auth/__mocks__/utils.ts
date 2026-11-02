/**
 * Jest-style mock for `@/auth/utils`, activated per test file by a bare
 * `vi.mock("@/auth/utils");`. Needed separately from the `@/auth` mock when
 * the code under test imports from "@/auth/utils" directly — module mocks
 * match specifiers, not re-exports.
 */
import { vi } from "vitest";

import type { MockFunction } from "@/test/mocks/mock-function";

export const hasPermission = vi.fn<MockFunction>();
export const userHasPermission = vi.fn<MockFunction>();
export const getPermissionsForUserContext = vi.fn<MockFunction>();
