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

  test("strips any harmony token, not just channel", () => {
    expect(
      repairHarmonyToolName(
        "archestra__run_command<|constrain|>json",
        AVAILABLE,
      ),
    ).toBe("archestra__run_command");
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

  test("returns null for an already-valid name (no token)", () => {
    expect(
      repairHarmonyToolName("archestra__run_command", AVAILABLE),
    ).toBeNull();
  });

  test("returns null when the cleaned prefix is not a registered tool", () => {
    expect(
      repairHarmonyToolName(
        "archestra__ghost_tool<|channel|>commentary",
        AVAILABLE,
      ),
    ).toBeNull();
  });

  test("returns null when the token is at the very start (nothing left)", () => {
    expect(
      repairHarmonyToolName("<|channel|>commentary", AVAILABLE),
    ).toBeNull();
  });

  test("returns null for a genuinely-unknown name without a token", () => {
    expect(repairHarmonyToolName("totally_made_up", AVAILABLE)).toBeNull();
  });

  test("does not strip an unclosed `<|` that is not a harmony token", () => {
    // a partial/garbage marker must not silently re-map to a different tool.
    expect(
      repairHarmonyToolName("archestra__run_command<|garbage", AVAILABLE),
    ).toBeNull();
  });

  test("does not strip a closed sentinel outside the harmony vocabulary", () => {
    // a closed `<|word|>` that is not a real harmony token must not trigger
    // repair — only the registered-tool match would otherwise gate it.
    expect(
      repairHarmonyToolName(
        "archestra__run_command<|garbage|>suffix",
        AVAILABLE,
      ),
    ).toBeNull();
  });

  test("splits on the first harmony token when several are present", () => {
    expect(
      repairHarmonyToolName(
        "archestra__run_command<|constrain|>json<|channel|>commentary",
        AVAILABLE,
      ),
    ).toBe("archestra__run_command");
  });
});
