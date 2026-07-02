/**
 * Jest-style mock for `@/lib/clients/auth/auth-client`, activated per test
 * file by a bare `vi.mock("@/lib/clients/auth/auth-client");`.
 *
 * better-auth's client is a deep tree (authClient.signIn.email,
 * authClient.twoFactor.verifyTotp, ...) that tests mock in different
 * shapes, so `authClient` is a memoized proxy: every property path yields a
 * stable node that is BOTH callable (a `vi.fn()`) and traversable. Configure
 * any leaf with `vi.mocked(authClient.listSessions).mockResolvedValue(...)`;
 * `vi.clearAllMocks()` covers the nodes like any other mock.
 */
import { vi } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: intentionally shapeless test double
function mockNode(): any {
  const fn = vi.fn();
  const children = new Map<string | symbol, unknown>();
  return new Proxy(fn, {
    get(target, prop, receiver) {
      // vi.fn internals (mock, mockReturnValue, ...) and Function.prototype
      if (prop in target) return Reflect.get(target, prop, receiver);
      // Play nice with promise-resolution probes.
      if (prop === "then") return undefined;
      if (!children.has(prop)) children.set(prop, mockNode());
      return children.get(prop);
    },
  });
}

export const authClient = mockNode();
