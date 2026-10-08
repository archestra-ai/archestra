import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postConnected, useConnectedSignal } from "./connect-signal";

/** An in-memory BroadcastChannel: delivers to every other open channel. */
class FakeChannel {
  static open = new Set<FakeChannel>();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) {
    FakeChannel.open.add(this);
  }
  postMessage(data: unknown) {
    for (const other of FakeChannel.open)
      if (other !== this && other.name === this.name)
        other.onmessage?.({ data });
  }
  close() {
    FakeChannel.open.delete(this);
  }
}

beforeEach(() => {
  FakeChannel.open.clear();
  vi.stubGlobal("BroadcastChannel", FakeChannel);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connect signal", () => {
  it("calls back for each broadcast while enabled", () => {
    const onConnected = vi.fn();
    renderHook(() => useConnectedSignal(true, onConnected));
    postConnected();
    postConnected();
    expect(onConnected).toHaveBeenCalledTimes(2);
  });

  it("ignores broadcasts while disabled, and after being disabled", () => {
    const onConnected = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useConnectedSignal(enabled, onConnected),
      { initialProps: { enabled: false } },
    );
    postConnected();
    rerender({ enabled: true });
    rerender({ enabled: false });
    postConnected();
    expect(onConnected).not.toHaveBeenCalled();
    expect(FakeChannel.open.size).toBe(0);
  });

  it("ignores other messages on the channel", () => {
    const onConnected = vi.fn();
    renderHook(() => useConnectedSignal(true, onConnected));
    new FakeChannel("connect-signal").postMessage({ type: "denied" });
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("does nothing in a browser without BroadcastChannel", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const onConnected = vi.fn();
    renderHook(() => useConnectedSignal(true, onConnected));
    expect(() => postConnected()).not.toThrow();
    expect(onConnected).not.toHaveBeenCalled();
  });
});
