// https://testing-library.com/docs/svelte-testing-library/setup/#vitest
import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Disable Sentry for tests - prevent sending test data to Sentry
process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN = "";

const mockCanvasContext = new Proxy(
  {
    canvas: null as HTMLCanvasElement | null,
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
      if (prop in target) {
        return target[prop];
      }

      const stub = vi.fn();
      target[prop as string] = stub;
      return stub;
    },
  },
) as unknown as CanvasRenderingContext2D;

vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
  function getContext() {
    mockCanvasContext.canvas = this;
    return mockCanvasContext;
  },
);
