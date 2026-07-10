import { describe, expect, test } from "vitest";
import { resolveEnabledToolIds } from "./enabled-tools-selection";
import type { PendingToolAction } from "./pending-tool-state";

const disablePlaywright: PendingToolAction = {
  type: "disableAll",
  toolIds: ["playwright"],
};

describe("resolveEnabledToolIds", () => {
  // Declining a subset on a fresh (non-custom) conversation must keep every
  // other tool enabled, not collapse to an empty allowlist.
  test("disabling a subset on a non-custom conversation keeps the other tools", () => {
    expect(
      resolveEnabledToolIds({
        hasCustomSelection: false,
        enabledToolIds: [],
        allToolIds: ["a", "b", "playwright"],
        pendingActions: [disablePlaywright],
      }),
    ).toEqual(["a", "b"]);
  });

  // A real custom selection is authoritative — its stored ids are the base,
  // not the agent's full set.
  test("a custom selection uses its stored ids as the base", () => {
    expect(
      resolveEnabledToolIds({
        hasCustomSelection: true,
        enabledToolIds: ["a"],
        allToolIds: ["a", "b", "playwright"],
        pendingActions: [],
      }),
    ).toEqual(["a"]);
  });

  // No pending actions + non-custom → the default is every tool enabled.
  test("no custom selection and no pending actions enables all tools", () => {
    expect(
      resolveEnabledToolIds({
        hasCustomSelection: false,
        enabledToolIds: [],
        allToolIds: ["a", "b", "playwright"],
      }),
    ).toEqual(["a", "b", "playwright"]);
  });

  // A custom selection that genuinely enabled zero tools stays empty — a real
  // empty allowlist must not be inflated back into "all tools".
  test("a custom selection of zero tools stays empty", () => {
    expect(
      resolveEnabledToolIds({
        hasCustomSelection: true,
        enabledToolIds: [],
        allToolIds: ["a", "b"],
        pendingActions: [],
      }),
    ).toEqual([]);
  });

  // An unresolved base (agent has no tools yet, or the tool fetch fell back to
  // []) resolves to empty even with a disable action — which is exactly why the
  // replay caller guards on a non-empty base and skips persisting this.
  test("a disable action on an empty base stays empty", () => {
    expect(
      resolveEnabledToolIds({
        hasCustomSelection: false,
        enabledToolIds: [],
        allToolIds: [],
        pendingActions: [disablePlaywright],
      }),
    ).toEqual([]);
  });

  // enable and disable actions both thread through, applied in order on the base.
  test("enable and disable actions apply in order on top of the base", () => {
    expect(
      resolveEnabledToolIds({
        hasCustomSelection: false,
        enabledToolIds: [],
        allToolIds: ["a", "b", "c"],
        pendingActions: [
          { type: "disableAll", toolIds: ["b", "c"] },
          { type: "enable", toolId: "c" },
        ],
      }),
    ).toEqual(["a", "c"]);
  });
});
