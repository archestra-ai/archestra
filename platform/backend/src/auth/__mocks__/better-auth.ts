/**
 * Mock for `@/auth/better-auth`, activated per test file by a bare
 * `vi.mock("@/auth/better-auth");`: the Better Auth instance with stubbed API
 * calls, configured through `vi.mocked(...)` in the test. The factory lives in
 * `@/test/mocks/auth` beside the `@/auth` mock.
 */
import { betterAuthModuleMock } from "@/test/mocks/auth";

export const { auth } = betterAuthModuleMock();
