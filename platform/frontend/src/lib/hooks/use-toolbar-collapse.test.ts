import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToolbarCollapse } from "./use-toolbar-collapse";

// Capture the observer callback so tests can drive resize events.
let observerCallback: ResizeObserverCallback | null = null;

beforeEach(() => {
  observerCallback = null;
  global.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      observerCallback = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Inline controls need 400px, trailing controls 72px → required total 472px.
const TOOLS_WIDTH = 400;
const TRAILING_WIDTH = 72;

function setup(availableWidth: number) {
  const available = { clientWidth: availableWidth };
  const content = { scrollWidth: TOOLS_WIDTH };
  const trailing = { offsetWidth: TRAILING_WIDTH };
  const reads = { count: 0 };
  Object.defineProperty(available, "clientWidth", {
    get: () => {
      reads.count += 1;
      return availableWidth;
    },
    set: (width: number) => {
      availableWidth = width;
    },
  });
  const refs = {
    availableRef: { current: available as unknown as HTMLElement },
    contentRef: { current: content as unknown as HTMLElement },
    trailingRef: { current: trailing as unknown as HTMLElement },
  };
  const { result } = renderHook(() => useToolbarCollapse(refs));
  const readsBeforeObserver = reads.count;
  // The observer's initial notification, delivered after layout.
  act(() => {
    observerCallback?.(
      [] as unknown as ResizeObserverEntry[],
      {} as ResizeObserver,
    );
  });
  const resize = (width: number) => {
    available.clientWidth = width;
    act(() => {
      observerCallback?.(
        [] as unknown as ResizeObserverEntry[],
        {} as ResizeObserver,
      );
    });
  };
  return { result, resize, readsBeforeObserver };
}

describe("useToolbarCollapse", () => {
  it("does not read layout while mounting, only from the observer", () => {
    const { result, readsBeforeObserver } = setup(460);
    expect(readsBeforeObserver).toBe(0);
    expect(result.current).toBe(true);
  });

  it("stays expanded when the inline controls fit", () => {
    const { result } = setup(900);
    expect(result.current).toBe(false);
  });

  it("collapses when the inline controls do not fit", () => {
    const { result } = setup(460); // 472 needed > 460
    expect(result.current).toBe(true);
  });

  it("collapses when the container shrinks below what the controls need", () => {
    const { result, resize } = setup(900);
    expect(result.current).toBe(false);

    resize(460);
    expect(result.current).toBe(true);
  });

  it("does not re-expand until there is clearly enough room (hysteresis)", () => {
    const { result, resize } = setup(460);
    expect(result.current).toBe(true);

    // Just past the raw requirement (472) but within the hysteresis band.
    resize(500);
    expect(result.current).toBe(true);

    // Comfortably past requirement + hysteresis (472 + 40 = 512).
    resize(520);
    expect(result.current).toBe(false);
  });

  it("stays expanded when there is no container to measure", () => {
    const refs = {
      availableRef: { current: null },
      contentRef: { current: null },
      trailingRef: { current: null },
    };
    const { result } = renderHook(() => useToolbarCollapse(refs));
    expect(result.current).toBe(false);
  });
});
