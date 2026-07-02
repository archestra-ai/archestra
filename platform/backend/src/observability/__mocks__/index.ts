/**
 * Jest-style mock for `@/observability`, activated per test file by a bare
 * `vi.mock("@/observability");`.
 *
 * The real module exposes eight `export * as ...` metric namespaces whose
 * function lists grow over time. Instead of hand-mirroring that surface (and
 * silently drifting), `metrics` and `tracing` are memoized proxies: the first
 * access to any `metrics.<ns>.<fn>` creates a stable `vi.fn()` and returns
 * the same instance afterwards, so both the code under test and
 * `vi.mocked(metrics.llm.someFn)` assertions in tests see one shared spy.
 * `vi.clearAllMocks()` covers these like any other mock.
 */
import { vi } from "vitest";

export const initializeObservabilityMetrics = vi.fn();
export const metrics = inertNamespace(2);
export const tracing = inertNamespace(1);

/** Proxy tree of the given depth: leaves are memoized vi.fn()s. */
function inertNamespace(depth: number): Record<string, never> {
  const children = new Map<string | symbol, unknown>();
  return new Proxy(Object.create(null), {
    get(_target, prop) {
      // Play nice with promise-resolution and module interop probes.
      if (prop === "then" || prop === Symbol.toStringTag) return undefined;
      if (!children.has(prop)) {
        children.set(prop, depth > 1 ? inertNamespace(depth - 1) : vi.fn());
      }
      return children.get(prop);
    },
  });
}
