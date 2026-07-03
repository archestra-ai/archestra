/**
 * Registry of process-local caches that must be cleared between tests.
 *
 * Process-local caches (e.g. LRU caches on hot lookup paths) outlive the
 * per-test database truncation, so a mapping cached in one test could leak
 * into the next. Caches register themselves here at module load; the shared
 * test setup clears every registered cache in its beforeEach. Clearing is a
 * no-op for modules a test file never loads.
 *
 * This module must stay dependency-free: the test setup imports it at the
 * top level, before test files apply their module mocks, so any transitive
 * import here would be pre-loaded with its real (unmocked) implementation.
 */

type ClearableCache = { clear(): void };

export function registerProcessLocalCache<T extends ClearableCache>(
  cache: T,
): T {
  registeredCaches.add(cache);
  return cache;
}

/** @public — consumed by the test setup (src/test/setup.ts), outside knip's production view */
export function clearRegisteredProcessLocalCaches(): void {
  for (const cache of registeredCaches) {
    cache.clear();
  }
}

const registeredCaches = new Set<ClearableCache>();
