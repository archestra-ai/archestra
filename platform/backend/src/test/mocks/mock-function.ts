/**
 * The signature of the module mocks' functions. Named so the declarations
 * emitted for the mocks need no reference to @vitest/spy, which the backend
 * does not depend on.
 */
export type MockFunction = (...args: unknown[]) => unknown;
