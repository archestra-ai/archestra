import { describe, expect, it } from "vitest";
import {
  getCurrentEnabledToolIds,
  getDefaultEnabledToolIds,
} from "./chat-tools-display.utils";

function tool(id: string) {
  return { id };
}

describe("getDefaultEnabledToolIds", () => {
  it("returns all profile tool IDs", () => {
    const tools = [tool("1"), tool("2"), tool("3")];
    expect(getDefaultEnabledToolIds(tools)).toEqual(["1", "2", "3"]);
  });

  it("includes archestra tools (they are not filtered out)", () => {
    const tools = [
      { id: "a1", name: "archestra__web_search" },
      { id: "a2", name: "archestra__artifact_write" },
      { id: "a3", name: "archestra__some_custom_tool" },
      { id: "m1", name: "other_server__some_tool" },
    ];
    const result = getDefaultEnabledToolIds(tools);
    expect(result).toEqual(["a1", "a2", "a3", "m1"]);
  });

  it("returns empty array for no tools", () => {
    expect(getDefaultEnabledToolIds([])).toEqual([]);
  });
});

describe("getCurrentEnabledToolIds", () => {
  const defaults = ["t1", "t2", "t3"];

  it("uses custom selection when conversation has one", () => {
    const result = getCurrentEnabledToolIds({
      conversationId: "conv-1",
      hasCustomSelection: true,
      enabledToolIds: ["t1"],
      defaultEnabledToolIds: defaults,
      pendingActions: [],
    });
    expect(result).toEqual(["t1"]);
  });

  it("uses defaults when conversation has no custom selection", () => {
    const result = getCurrentEnabledToolIds({
      conversationId: "conv-1",
      hasCustomSelection: false,
      enabledToolIds: [],
      defaultEnabledToolIds: defaults,
      pendingActions: [],
    });
    expect(result).toEqual(defaults);
  });

  it("uses defaults when there is no conversation and no pending actions", () => {
    const result = getCurrentEnabledToolIds({
      conversationId: undefined,
      hasCustomSelection: false,
      enabledToolIds: [],
      defaultEnabledToolIds: defaults,
      pendingActions: [],
    });
    expect(result).toEqual(defaults);
  });

  it("applies pending disable action on top of defaults when no conversation", () => {
    const result = getCurrentEnabledToolIds({
      conversationId: undefined,
      hasCustomSelection: false,
      enabledToolIds: [],
      defaultEnabledToolIds: defaults,
      pendingActions: [{ type: "disable", toolId: "t2" }],
    });
    expect(result).toEqual(["t1", "t3"]);
  });

  it("applies pending enable action on top of defaults when no conversation", () => {
    const result = getCurrentEnabledToolIds({
      conversationId: undefined,
      hasCustomSelection: false,
      enabledToolIds: [],
      defaultEnabledToolIds: ["t1"],
      pendingActions: [{ type: "enable", toolId: "t2" }],
    });
    expect(result).toEqual(["t1", "t2"]);
  });

  it("applies disableAll pending action", () => {
    const result = getCurrentEnabledToolIds({
      conversationId: undefined,
      hasCustomSelection: false,
      enabledToolIds: [],
      defaultEnabledToolIds: defaults,
      pendingActions: [{ type: "disableAll", toolIds: ["t1", "t3"] }],
    });
    expect(result).toEqual(["t2"]);
  });

  it("applies enableAll pending action", () => {
    const result = getCurrentEnabledToolIds({
      conversationId: undefined,
      hasCustomSelection: false,
      enabledToolIds: [],
      defaultEnabledToolIds: ["t1"],
      pendingActions: [{ type: "enableAll", toolIds: ["t2", "t3"] }],
    });
    expect(result).toEqual(["t1", "t2", "t3"]);
  });

  it("ignores pending actions when conversation exists (even without custom selection)", () => {
    const result = getCurrentEnabledToolIds({
      conversationId: "conv-1",
      hasCustomSelection: false,
      enabledToolIds: [],
      defaultEnabledToolIds: defaults,
      pendingActions: [{ type: "disable", toolId: "t1" }],
    });
    expect(result).toEqual(defaults);
  });

  it("custom selection takes priority over pending actions", () => {
    const result = getCurrentEnabledToolIds({
      conversationId: "conv-1",
      hasCustomSelection: true,
      enabledToolIds: ["t2"],
      defaultEnabledToolIds: defaults,
      pendingActions: [{ type: "enable", toolId: "t3" }],
    });
    expect(result).toEqual(["t2"]);
  });
});
