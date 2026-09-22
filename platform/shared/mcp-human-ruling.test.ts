import { describe, expect, test } from "vitest";
import {
  extractMcpHumanRuling,
  MCP_HUMAN_RULING_META_KEY,
} from "./mcp-human-ruling";

describe("extractMcpHumanRuling", () => {
  test("reads either ruling from a tool result's _meta", () => {
    expect(
      extractMcpHumanRuling({
        content: "[appa] Denied",
        _meta: { [MCP_HUMAN_RULING_META_KEY]: "deny" },
      }),
    ).toBe("deny");
    expect(
      extractMcpHumanRuling({
        _meta: { [MCP_HUMAN_RULING_META_KEY]: "approve" },
      }),
    ).toBe("approve");
  });

  test("returns null for anything but a known ruling in _meta", () => {
    expect(
      extractMcpHumanRuling({
        _meta: { [MCP_HUMAN_RULING_META_KEY]: "cancel" },
      }),
    ).toBeNull();
    // A key outside _meta is result payload, not the platform's marker.
    expect(
      extractMcpHumanRuling({ [MCP_HUMAN_RULING_META_KEY]: "deny" }),
    ).toBeNull();
    expect(extractMcpHumanRuling({ _meta: null })).toBeNull();
    expect(extractMcpHumanRuling("deny")).toBeNull();
    expect(extractMcpHumanRuling(undefined)).toBeNull();
  });
});
