import { PGlite } from "@electric-sql/pglite";

/**
 * Calls `onAccess` whenever `client` runs SQL or opens a transaction.
 *
 * Patches the prototype rather than shadowing instance methods, because tests
 * spy on `PGlite.prototype.query`. Drizzle transactions use a separate client,
 * so entering any transaction counts as access too, and reads count as well:
 * an extra reset is safer than inferring which SQL writes.
 *
 * The patch is installed once per worker and outlives the file that installs
 * it, so it lives here rather than in setup.ts: a closure defined there keeps
 * that file's whole setup scope alive, including its test database.
 */
export function onDatabaseAccess(client: PGlite, onAccess: () => void): void {
  const prototype = PGlite.prototype as unknown as TrackedPrototype;
  prototype[ACCESS_TRACKERS] ??= installTrackers(prototype);
  prototype[ACCESS_TRACKERS].set(client, onAccess);
}

// ===

const ACCESS_TRACKERS = Symbol.for("archestra.test.pgliteAccessTrackers");

type SqlMethod = (...args: unknown[]) => Promise<unknown>;

type TrackedPrototype = {
  [ACCESS_TRACKERS]?: WeakMap<PGlite, () => void>;
  query: SqlMethod;
  exec: SqlMethod;
  transaction: SqlMethod;
};

function installTrackers(
  prototype: TrackedPrototype,
): WeakMap<PGlite, () => void> {
  const trackers = new WeakMap<PGlite, () => void>();
  for (const method of ["query", "exec", "transaction"] as const) {
    const original = prototype[method];
    prototype[method] = function (this: PGlite, ...args: unknown[]) {
      trackers.get(this)?.();
      return Reflect.apply(original, this, args);
    };
  }
  return trackers;
}
