// https://testing-library.com/docs/svelte-testing-library/setup/#vitest
import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

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

vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
  function getContext(this: HTMLCanvasElement) {
    return Object.assign(Object.create(mockCanvasContext), { canvas: this });
  },
);
