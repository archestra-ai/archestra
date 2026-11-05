// https://testing-library.com/docs/svelte-testing-library/setup/#vitest
import "@testing-library/jest-dom/vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, vi } from "vitest";

// Files in the jsdom-shared project (see vitest.config.ts) run one after
// another in a worker that keeps its modules and its jsdom window. This file
// runs before each of them, so it puts back what one file can leave for the
// next. Testing Library registers its own cleanup only when it is first
// imported, which such a worker does once, so it is registered here too.
afterEach(() => {
  if (typeof document === "undefined") return;
  cleanup();
  // What a Radix overlay leaves on <body> (portals, `pointer-events: none`,
  // scroll locks), and a text selection.
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
  window.getSelection()?.removeAllRanges();
});
const WINDOW_BASELINE = Symbol.for("archestra.vitest.windowBaseline");
const FILE_TIMERS = Symbol.for("archestra.vitest.fileTimers");
// Next's server modules expect the AsyncLocalStorage global that its server
// entry installs, and otherwise throw from deferred work (often after the
// test that started it). Installed here as Next installs it, it is part of
// the baseline below.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??=
  AsyncLocalStorage;
if (process.env.ARCHESTRA_VITEST_SHARED_WINDOW === "true") trackFileTimers();
const windowBaseline =
  process.env.ARCHESTRA_VITEST_SHARED_WINDOW === "true"
    ? captureWindowBaseline()
    : null;
// JSDOM has no layout engine or ResizeObserver. Components can subscribe to
// size changes; tests that exercise resizing supply their own observer callback.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Radix focus scopes dispatch an event on a zero-delay timer after a dialog
// unmounts. When a file's last test closes one, that timer can fire after the
// jsdom environment is torn down and fail the run with an unhandled
// "dispatchEvent ... not of type 'Event'". One real tick after the file's
// tests lets those timers run while jsdom is still alive; the reference is
// captured here so a test's fake timers cannot stall it.
const realSetTimeout = globalThis.setTimeout;
afterAll(async () => {
  await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
  // A lazy import this file started must finish before the module reset;
  // finishing later, it would leave a half-evaluated module for the next
  // file's automocks to copy.
  await vi.dynamicImportSettled();
  if (process.env.ARCHESTRA_VITEST_SHARED_WINDOW === "true") clearFileTimers();
  try {
    if (windowBaseline) restoreWindowBaseline(windowBaseline);
  } finally {
    if (process.env.ARCHESTRA_VITEST_RESET_MODULES === "true") {
      resetModuleGraph();
    }
  }
});

// Disable Sentry for tests - prevent sending test data to Sentry
process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN = "";

function createTestStorage(): Storage {
  const entries = new Map<string, string>();

  return {
    get length() {
      return entries.size;
    },
    clear: vi.fn(() => entries.clear()),
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(entries.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => entries.delete(key)),
    setItem: vi.fn((key: string, value: string) =>
      entries.set(key, String(value)),
    ),
  };
}

if (
  typeof window !== "undefined" &&
  typeof window.localStorage?.getItem !== "function"
) {
  const localStorage = createTestStorage();
  const sessionStorage = createTestStorage();

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorage,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: sessionStorage,
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: localStorage,
  });
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: sessionStorage,
  });
}

const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
// biome-ignore lint/suspicious/noConsole: test setup intentionally intercepts console output.
const originalConsoleLog = console.log;

function shouldSuppressTestConsole(message: string) {
  return (
    message.includes("Failed to extract citations from tool result") ||
    message.includes("not wrapped in act(...)")
  );
}

console.error = (...args: unknown[]) => {
  const message = args.map(String).join(" ");

  if (shouldSuppressTestConsole(message)) {
    return;
  }

  originalConsoleError(...args);
};

console.warn = (...args: unknown[]) => {
  const message = args.map(String).join(" ");

  if (shouldSuppressTestConsole(message)) {
    return;
  }

  originalConsoleWarn(...args);
};

console.log = (...args: unknown[]) => {
  const message = args.map(String).join(" ");

  if (shouldSuppressTestConsole(message)) {
    return;
  }

  originalConsoleLog(...args);
};

const mockCanvasContext = new Proxy(
  {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    getImageData: vi.fn(() => ({
      data: new Uint8ClampedArray(4),
      height: 1,
      width: 1,
    })),
    measureText: vi.fn(() => ({ width: 0 })),
    putImageData: vi.fn(),
    resetTransform: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(),
    strokeRect: vi.fn(),
    translate: vi.fn(),
  } as Record<string, unknown>,
  {
    get(target, prop) {
      if (typeof prop !== "string") {
        return undefined;
      }

      if (prop in target) {
        return target[prop];
      }

      const stub = vi.fn();
      target[prop] = stub;
      return stub;
    },
  },
) as unknown as CanvasRenderingContext2D;

if (typeof HTMLCanvasElement !== "undefined") {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function getContext(this: HTMLCanvasElement) {
      return Object.assign(Object.create(mockCanvasContext), { canvas: this });
    },
  );
}

// ===== Shared-worker reset =====

interface WindowBaseline {
  href: string;
  env: Record<string, string | undefined>;
  targets: {
    target: object;
    descriptors: Map<PropertyKey, PropertyDescriptor>;
  }[];
}

/**
 * The globals and DOM prototypes as the worker's first file found them, kept
 * on the shared window so later files compare against the same snapshot.
 * Tests assign globals directly (`global.ResizeObserver = ...`,
 * `Object.defineProperty(window, "matchMedia", ...)`) rather than through
 * vi.stubGlobal, so these are restored by descriptor.
 */
function captureWindowBaseline(): WindowBaseline {
  const store = globalThis as { [WINDOW_BASELINE]?: WindowBaseline };
  if (store[WINDOW_BASELINE]) return store[WINDOW_BASELINE];
  const baseline: WindowBaseline = {
    href: typeof window === "undefined" ? "" : window.location.href,
    env: { ...process.env },
    targets: baselineTargets().map((target) => ({
      target,
      descriptors: new Map(
        Reflect.ownKeys(target).map((key) => [
          key,
          Object.getOwnPropertyDescriptor(target, key) as PropertyDescriptor,
        ]),
      ),
    })),
  };
  Object.defineProperty(store, WINDOW_BASELINE, { value: baseline });
  return baseline;
}

function restoreWindowBaseline(baseline: WindowBaseline): void {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // Tests assign process.env directly as well as through vi.stubEnv.
  for (const key of Object.keys(process.env)) {
    if (!(key in baseline.env)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(baseline.env)) {
    if (process.env[key] !== value) process.env[key] = value;
  }
  for (const { target, descriptors } of baseline.targets) {
    for (const key of Reflect.ownKeys(target)) {
      if (key === WINDOW_BASELINE || descriptors.has(key)) continue;
      // Symbols are runtime internals (Node defines undici's dispatcher on
      // first fetch); only a test's own named global is worth failing on.
      if (!Reflect.deleteProperty(target, key) && typeof key === "string") {
        // Fail only the file that leaked it: later files compare against a
        // baseline that now includes it.
        descriptors.set(
          key,
          Object.getOwnPropertyDescriptor(target, key) as PropertyDescriptor,
        );
        throw new Error(
          `This file defined ${String(key)} without \`configurable: true\`, so the next file in this worker would inherit it. Add \`configurable: true\` to that Object.defineProperty call.`,
        );
      }
    }
    for (const [key, descriptor] of descriptors) {
      const current = Object.getOwnPropertyDescriptor(target, key);
      if (current && sameDescriptor(current, descriptor)) continue;
      try {
        Object.defineProperty(target, key, descriptor);
      } catch {
        // Non-configurable properties cannot have been replaced either.
      }
    }
  }
  if (typeof window === "undefined") return;
  window.localStorage?.clear();
  window.sessionStorage?.clear();
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim();
    if (name)
      // biome-ignore lint/suspicious/noDocumentCookie: expiring jsdom's cookies is the reset
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
  if (window.location.href !== baseline.href) {
    window.history.replaceState(null, "", baseline.href);
  }
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("style");
}

function baselineTargets(): object[] {
  if (typeof window === "undefined") return [globalThis];
  return [
    ...new Set<object>([globalThis, window]),
    window.navigator,
    window.document,
    window.Node.prototype,
    window.Element.prototype,
    window.HTMLElement.prototype,
  ];
}

function sameDescriptor(a: PropertyDescriptor, b: PropertyDescriptor): boolean {
  return (
    a.value === b.value &&
    a.get === b.get &&
    a.set === b.set &&
    a.writable === b.writable &&
    a.enumerable === b.enumerable &&
    a.configurable === b.configurable
  );
}

/**
 * What `isolate: true` does before each file, without the fresh worker:
 * forget this file's module mocks and evaluated source modules, so the next
 * file imports the app again under its own mocks. Externalized packages
 * (React, Testing Library, Radix) stay in Node's import cache, and the jsdom
 * window stays up; re-creating those per file was most of the cost.
 */
function resetModuleGraph(): void {
  const vitest = globalThis as {
    __vitest_mocker__?: { reset(): void };
    __vitest_worker__?: { evaluatedModules: EvaluatedModules };
  };
  const mocker = vitest.__vitest_mocker__;
  mocker?.reset();
  // vi.mock() calls wait in a list shared by every file until the next
  // import resolves them; one left over would register for the next file.
  const pending = (
    mocker?.constructor as { pendingIds?: unknown[] } | undefined
  )?.pendingIds;
  if (pending) pending.length = 0;
  // vi.resetModules() keeps evaluated mock modules and each module's fetched
  // code. Both carry one file's mocks into the next: a factory-mocked
  // module's original is fetched as empty code, and an automock caches its
  // exports on the node. This drops them like a fresh worker would; the
  // transformed code stays cached in the main process.
  const modules = vitest.__vitest_worker__?.evaluatedModules;
  modules?.idToModuleMap.forEach((node, id) => {
    if (/\/vitest\/dist\/|vitest-virtual-\w+\/dist|@vitest\/dist/.test(id)) {
      return;
    }
    modules.invalidateModule(node);
    node.mockedExports = undefined;
    node.importers.clear();
  });
}

interface EvaluatedModules {
  invalidateModule(node: EvaluatedModuleNode): void;
  idToModuleMap: Map<string, EvaluatedModuleNode>;
}

interface EvaluatedModuleNode {
  mockedExports?: unknown;
  importers: Set<string>;
}

/**
 * A timer a file left pending (a query retry or refetch, a debounce) would
 * otherwise fire during the next file, running the previous file's modules
 * and starting imports under the next file's mocks. The real timer
 * functions are wrapped once per worker; each file's pending handles are
 * cleared when it ends. Fake timers sit above this and are unaffected.
 */
function trackFileTimers(): void {
  const store = globalThis as { [FILE_TIMERS]?: Set<unknown> };
  if (store[FILE_TIMERS]) {
    store[FILE_TIMERS].clear();
    return;
  }
  const pending = new Set<unknown>();
  Object.defineProperty(store, FILE_TIMERS, { value: pending });
  const { setTimeout, setInterval, clearTimeout, clearInterval } = globalThis;
  globalThis.setTimeout = ((handler: TimerHandler, ...rest: unknown[]) => {
    const handle: unknown = setTimeout(
      (...args: unknown[]) => {
        pending.delete(handle);
        if (typeof handler === "function") handler(...args);
      },
      ...(rest as [number?]),
    );
    pending.add(handle);
    return handle;
  }) as typeof globalThis.setTimeout;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = setInterval(...args);
    pending.add(handle);
    return handle;
  }) as typeof globalThis.setInterval;
  globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
    pending.delete(handle);
    clearTimeout(handle);
  }) as typeof globalThis.clearTimeout;
  globalThis.clearInterval = ((
    handle?: Parameters<typeof clearInterval>[0],
  ) => {
    pending.delete(handle);
    clearInterval(handle);
  }) as typeof globalThis.clearInterval;
}

function clearFileTimers(): void {
  const pending = (globalThis as { [FILE_TIMERS]?: Set<unknown> })[FILE_TIMERS];
  if (!pending) return;
  for (const handle of pending) {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
    clearInterval(handle as Parameters<typeof clearInterval>[0]);
  }
  pending.clear();
}
