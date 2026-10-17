import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("useIdleEnabled", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("holds a request until the page is first idle, then lets later mounts through at once", async () => {
    const idleCallbacks: Array<() => void> = [];
    vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    vi.stubGlobal("cancelIdleCallback", () => {});
    const { useIdleEnabled } = await import("./use-idle-enabled");

    const first = renderHook(() => useIdleEnabled(true));
    expect(first.result.current).toBe(false);

    act(() => {
      for (const callback of idleCallbacks) callback();
    });
    expect(first.result.current).toBe(true);

    const later = renderHook(() => useIdleEnabled(true));
    expect(later.result.current).toBe(true);
  });

  it("stays off while the caller keeps it off", async () => {
    vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
      callback();
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", () => {});
    const { useIdleEnabled } = await import("./use-idle-enabled");

    const { result } = renderHook(() => useIdleEnabled(false));

    expect(result.current).toBe(false);
  });
});
