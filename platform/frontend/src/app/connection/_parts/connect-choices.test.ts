import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_INCLUDED,
  DEFAULT_PICKS,
  readConnectChoices,
  readConnectPicks,
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

  it("reads back the gateway and plugins picked, per client", () => {
    saveConnectChoices("claude-code", ALL_INCLUDED, {
      gatewayId: "gw-1",
      pluginIds: ["p-1"],
    });
    expect(readConnectPicks("claude-code")).toEqual({
      gatewayId: "gw-1",
      pluginIds: ["p-1"],
    });
    expect(readConnectPicks("codex")).toEqual(DEFAULT_PICKS);
  });

  it("ignores choices from an earlier, expired run", () => {
    vi.useFakeTimers();
    saveConnectChoices("codex", { ...ALL_INCLUDED, tools: false });
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(readConnectChoices("codex")).toEqual(ALL_INCLUDED);
  });
});
