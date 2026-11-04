// https://testing-library.com/docs/svelte-testing-library/setup/#vitest
import "@testing-library/jest-dom/vitest";
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
  if (windowBaseline) restoreWindowBaseline(windowBaseline);
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
  for (const { target, descriptors } of baseline.targets) {
    for (const key of Reflect.ownKeys(target)) {
      if (key === WINDOW_BASELINE || descriptors.has(key)) continue;
      // Symbols are runtime internals (Node defines undici's dispatcher on
      // first fetch); only a test's own named global is worth failing on.
      if (!Reflect.deleteProperty(target, key) && typeof key === "string") {
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
