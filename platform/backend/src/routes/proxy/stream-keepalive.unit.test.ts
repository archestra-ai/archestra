import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  STREAM_KEEPALIVE_SSE_COMMENT,
  StreamKeepAlive,
} from "./stream-keepalive";

describe("SSE keep-alive lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(intervalMs = 30, sse = true, early = true) {
    const raw = Object.assign(new EventEmitter(), {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      writableNeedDrain: false,
      write: vi.fn(() => true),
    });
    const commit = vi.fn(() => {
      raw.headersSent = true;
    });
    const keepAlive = new StreamKeepAlive(
      raw as unknown as ServerResponse,
      intervalMs,
      sse,
      early ? commit : undefined,
    );
    keepAlive.start();
    if (early) keepAlive.allowCommit();
    return { raw, keepAlive, commit };
  }

  test("commits only at the idle interval and restarts the clock on real output", () => {
    const { raw, keepAlive, commit } = setup();
    vi.advanceTimersByTime(29);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledOnce();
    expect(raw.write).toHaveBeenCalledWith(STREAM_KEEPALIVE_SSE_COMMENT);
    vi.advanceTimersByTime(20);
    keepAlive.touch();
    vi.advanceTimersByTime(29);
    expect(raw.write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(raw.write).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledOnce();
    keepAlive.stop();
  });

  test("preserves uncommitted headers by default", () => {
    const { raw, keepAlive, commit } = setup(30, true, false);
    vi.advanceTimersByTime(90);
    expect(commit).not.toHaveBeenCalled();
    expect(raw.write).not.toHaveBeenCalled();
    raw.headersSent = true;
    vi.advanceTimersByTime(30);
    expect(raw.write).toHaveBeenCalledOnce();
    keepAlive.stop();
  });

  test("a failed attempt cannot commit while its replacement is pending", () => {
    const { raw, keepAlive, commit } = setup();
    vi.advanceTimersByTime(20);
    keepAlive.suspendCommit();
    vi.advanceTimersByTime(100);
    expect(commit).not.toHaveBeenCalled();
    keepAlive.allowCommit();
    vi.advanceTimersByTime(29);
    expect(raw.write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(raw.write).toHaveBeenCalledOnce();
    keepAlive.stop();
  });

  test.each([
    [0, true],
    [30, false],
  ])("stays inert with interval %i and SSE %s", (interval, sse) => {
    const { raw, commit } = setup(interval, sse);
    vi.advanceTimersByTime(300);
    expect(raw.write).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(raw.listenerCount("close")).toBe(0);
  });

  test("skips comments under backpressure and resumes after drain", () => {
    const { raw, keepAlive, commit } = setup();
    raw.writableNeedDrain = true;
    vi.advanceTimersByTime(300);
    expect(raw.write).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    raw.writableNeedDrain = false;
    vi.advanceTimersByTime(30);
    expect(raw.write).toHaveBeenCalledOnce();
    keepAlive.stop();
  });

  test.each([
    "close",
    "finish",
    "stop",
  ])("releases the timer and listeners on %s", (event) => {
    const { raw, keepAlive } = setup();
    if (event === "stop") keepAlive.stop();
    else raw.emit(event);
    vi.advanceTimersByTime(300);
    expect(raw.write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(raw.listenerCount("close")).toBe(0);
    expect(raw.listenerCount("finish")).toBe(0);
  });

  test.each([
    "destroyed",
    "writableEnded",
  ] as const)("stops on a %s socket even without a close event", (state) => {
    const { raw } = setup();
    raw[state] = true;
    vi.advanceTimersByTime(300);
    expect(raw.write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
