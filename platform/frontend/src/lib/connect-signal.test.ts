import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postConnected, useConnectedSignal } from "./connect-signal";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connect signal", () => {
  it("calls back for a broadcast while enabled, and not after", async () => {
    const onConnected = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useConnectedSignal(enabled, onConnected),
      { initialProps: { enabled: true } },
    );
    postConnected();
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));

    rerender({ enabled: false });
    postConnected();
    // Give a stray delivery the time the first one took.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("does nothing in a browser without BroadcastChannel", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const onConnected = vi.fn();
    renderHook(() => useConnectedSignal(true, onConnected));
    expect(() => postConnected()).not.toThrow();
    expect(onConnected).not.toHaveBeenCalled();
  });
});
