import { test, vi } from "vitest";

/**
 * Resets what one test file can leave behind for the next in a shared worker
 * (`isolate: false`): it puts the worker's original fetch, timer, clock and
 * `process` globals back, and forgets the previous file's mocks and fixtures.
 *
 * Projects with `isolate: false` run many files in one worker, so a global a
 * file leaves replaced is what the next file's modules capture when they load.
 * Per-test restores cannot prevent this: after each file, Vitest calls
 * `vi.restoreAllMocks()`, which runs the restore of every `vi.spyOn` again,
 * including spies a test already restored (`mockRestore()` keeps them
 * registered). A spy made on `setTimeout` while fake timers were on, or on
 * `fetch` while an MSW server was listening, therefore puts the fake clock or
 * the stale MSW interceptor back after the file has finished, and every later
 * file in the worker inherits it: timeouts never fire, or requests fail as
 * unhandled.
 *
 * The originals are captured once per worker, before the first file changes
 * anything, and kept on `globalThis` because this module is evaluated again
 * for every file.
 */
type PristineGlobals = {
  global: Record<string, unknown>;
  process: Record<string, unknown>;
};

const PRISTINE_GLOBALS = Symbol.for("archestra.test.pristineGlobals");

const GLOBAL_NAMES = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "queueMicrotask",
  "Date",
  "performance",
] as const;

const PROCESS_NAMES = ["nextTick", "hrtime"] as const;

const MOCK_REGISTRY = Symbol.for("archestra.test.mockRegistry");
const FIXTURE_BASELINE = Symbol.for("archestra.test.fixtureBaseline");

const pristine = getPristineGlobals();
restoreGlobals(pristine);
forgetFinishedMocks();
forgetFinishedFixtures();

/** The worker's original `fetch`, for setups that restore it after each test. */
export const pristineFetch = pristine.global.fetch as typeof fetch;

// ===

function getPristineGlobals(): PristineGlobals {
  const store = globalThis as typeof globalThis & {
    [PRISTINE_GLOBALS]?: PristineGlobals;
  };
  store[PRISTINE_GLOBALS] ??= {
    global: pick(globalThis, GLOBAL_NAMES),
    process: pick(process, PROCESS_NAMES),
  };
  return store[PRISTINE_GLOBALS];
}

function restoreGlobals(globals: PristineGlobals): void {
  restore(globalThis, globals.global);
  restore(process, globals.process);
}

function pick(
  target: object,
  names: readonly string[],
): Record<string, unknown> {
  const record = target as Record<string, unknown>;
  return Object.fromEntries(names.map((name) => [name, record[name]]));
}

function restore(target: object, values: Record<string, unknown>): void {
  const record = target as Record<string, unknown>;
  for (const [name, value] of Object.entries(values)) {
    if (record[name] !== value) record[name] = value;
  }
}

/**
 * Vitest keeps every mock a worker has created in a registry it never
 * empties, so that clearAllMocks() can reach them. Each mock holds its
 * implementation and the original it replaced, and through them the modules
 * of the file that created it: a spy on a file's `db.transaction` keeps that
 * file's PGlite (about 265 MB) alive until the worker exits. The registry is
 * not exported; clearAllMocks() walks it with Set.prototype.forEach, which
 * hands it over once per worker. Every file creates its own mocks again, and
 * Vitest has already restored the previous file's spies.
 */
function forgetFinishedMocks(): void {
  const store = globalThis as { [MOCK_REGISTRY]?: Set<unknown> };
  if (!store[MOCK_REGISTRY]) {
    const forEach = Set.prototype.forEach;
    const probe = vi.fn();
    let registry: Set<unknown> | undefined;
    Set.prototype.forEach = function (this: Set<unknown>, ...args) {
      if (!registry && this.has(probe)) registry = this;
      return forEach.apply(this, args as Parameters<typeof forEach>);
    };
    try {
      vi.clearAllMocks();
    } finally {
      Set.prototype.forEach = forEach;
    }
    // A Vitest that keeps its mocks some other way: leave them be.
    if (!registry) return;
    Object.defineProperty(store, MOCK_REGISTRY, { value: registry });
  }
  store[MOCK_REGISTRY]?.clear();
}

/**
 * Vitest records every `test.extend()` a worker has seen in a static list
 * that it empties only when the worker exits, so it can tear down worker
 * fixtures. Each file evaluates `@/test` again and extends `test` again, and
 * every entry keeps that file's run reachable: Vitest stores an Error with
 * each fixture function, whose stack trace holds the file's tasks, hooks and
 * PGlite. Entries the previous files added are dropped unless they define a
 * worker or file fixture, which still needs its teardown; the entries
 * registered before the first file are kept.
 */
function forgetFinishedFixtures(): void {
  const definitions = fixtureDefinitions();
  if (!definitions) return;
  const store = globalThis as { [FIXTURE_BASELINE]?: number };
  store[FIXTURE_BASELINE] ??= definitions.length;
  const finished = definitions.splice(store[FIXTURE_BASELINE]);
  definitions.push(...finished.filter(hasLongLivedFixture));
}

type FixtureDefinition = {
  _registrations?: Map<string, { scope?: string }>;
};

function fixtureDefinitions(): FixtureDefinition[] | undefined {
  const key = Object.getOwnPropertySymbols(test).find(
    (symbol) => symbol.description === "kChainableContext",
  );
  const context = key
    ? (test as unknown as Record<symbol, { getFixtures?: () => object }>)[key]
    : undefined;
  const definitions = (
    context?.getFixtures?.().constructor as { _definitions?: unknown }
  )?._definitions;
  return Array.isArray(definitions) ? definitions : undefined;
}

function hasLongLivedFixture(definition: FixtureDefinition): boolean {
  return [...(definition._registrations?.values() ?? [])].some(
    (fixture) => fixture.scope !== undefined && fixture.scope !== "test",
  );
}
