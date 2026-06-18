import { describe, expect, test } from "vitest";
import { repairHarmonyToolName } from "./tool-call-repair";

const AVAILABLE = [
  "archestra__run_command",
  "archestra__search_tools",
  "context7__resolve-library-id",
];

describe("repairHarmonyToolName", () => {
  test("strips a harmony channel marker and matches the registered tool", () => {
    expect(
      repairHarmonyToolName(
        "archestra__run_command<|channel|>commentary",
        AVAILABLE,
      ),
    ).toBe("archestra__run_command");
  });

  test("strips any marker variant, not just commentary", () => {
    expect(
      repairHarmonyToolName(
        "archestra__search_tools<|channel|>analysis",
        AVAILABLE,
      ),
    ).toBe("archestra__search_tools");
  });

  test("repairs non-archestra MCP tools too", () => {
    expect(
      repairHarmonyToolName(
        "context7__resolve-library-id<|channel|>final",
        AVAILABLE,
      ),
    ).toBe("context7__resolve-library-id");
  });

  test("returns null for an already-valid name (no marker)", () => {
    expect(
      repairHarmonyToolName("archestra__run_command", AVAILABLE),
    ).toBeNull();
  });

  test("returns null when the cleaned name is not a registered tool", () => {
    expect(
      repairHarmonyToolName(
        "archestra__ghost_tool<|channel|>commentary",
        AVAILABLE,
      ),
    ).toBeNull();
  });

  test("returns null when the marker is at the very start (nothing left)", () => {
    expect(
      repairHarmonyToolName("<|channel|>commentary", AVAILABLE),
    ).toBeNull();
  });

  test("returns null for a genuinely-unknown name without a marker", () => {
    expect(repairHarmonyToolName("totally_made_up", AVAILABLE)).toBeNull();
  });
});
