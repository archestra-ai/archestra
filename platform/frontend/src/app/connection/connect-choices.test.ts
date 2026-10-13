import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_INCLUDED,
  readConnectChoices,
  saveConnectChoices,
} from "./connect-choices";

describe("connect choices", () => {
  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("includes everything when nothing was saved", () => {
    expect(readConnectChoices("claude-code")).toEqual(ALL_INCLUDED);
  });

  it("reads back what the review step saved, per client", () => {
    saveConnectChoices("claude-code", { ...ALL_INCLUDED, proxy: false });
    expect(readConnectChoices("claude-code")).toEqual({
      ...ALL_INCLUDED,
      proxy: false,
    });
    expect(readConnectChoices("codex")).toEqual(ALL_INCLUDED);
  });

  it("ignores choices from an earlier, expired run", () => {
    vi.useFakeTimers();
    saveConnectChoices("codex", { ...ALL_INCLUDED, tools: false });
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(readConnectChoices("codex")).toEqual(ALL_INCLUDED);
  });
});
