import { describe, expect, it } from "vitest";
import {
  getCompactToolState,
  getCurrentEnabledToolIds,
  getDefaultEnabledToolIds,
  getToolErrorText,
  isCompactEligible,
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

describe("tool display helpers", () => {
  it("falls back to parsing JSON output errors", () => {
    expect(
      getToolErrorText({
        part: {
          type: "tool-github__create_issue",
          state: "input-available",
          output: JSON.stringify({
            _meta: {
              archestraError: {
                type: "generic",
                message: "output error",
              },
            },
          }),
        } as never,
        toolResultPart: null,
      }),
    ).toBe("output error");
  });

  it("extracts auth errors from structured tool output", () => {
    expect(
      getToolErrorText({
        part: {
          type: "tool-id-jag_test__get-server-info",
          state: "output-available",
          output: {
            _meta: {
              archestraError: {
                type: "auth_expired",
                message:
                  'Expired or invalid authentication for "id-jag test".\n\nYour credentials failed authentication.',
                catalogId: "cat_abc",
                catalogName: "id-jag test",
                serverId: "srv_xyz",
                reauthUrl:
                  "http://localhost:3000/mcp/registry?reauth=cat_abc&server=srv_xyz",
              },
            },
          },
        } as never,
        toolResultPart: null,
      }),
    ).toContain('Expired or invalid authentication for "id-jag test"');
  });

  it("marks generic tool failures as compact-eligible", () => {
    expect(
      isCompactEligible({
        toolName: "github__create_issue",
        part: {
          type: "tool-github__create_issue",
          state: "input-available",
          errorText: "Request failed",
        } as never,
        toolResultPart: null,
      }),
    ).toBe(true);
  });

  it("keeps policy denials as full cards", () => {
    expect(
      isCompactEligible({
        toolName: "linear__create_issue",
        part: {
          type: "tool-linear__create_issue",
          state: "input-available",
          errorText:
            'I tried to invoke the linear__create_issue tool with the following arguments: {"title":"Blocked"}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: untrusted data detected',
        } as never,
        toolResultPart: null,
      }),
    ).toBe(false);
  });

  it("keeps auth-required responses as full cards", () => {
    expect(
      isCompactEligible({
        toolName: "jira__create_issue",
        part: {
          type: "tool-jira__create_issue",
          state: "input-available",
          errorText:
            'Authentication required for "jira-atlassian-remote".\n\nNo credentials found for this MCP server. To continue, visit this URL: http://localhost:3000/mcp/registry?install=cat_demo',
        } as never,
        toolResultPart: null,
      }),
    ).toBe(false);
  });

  it("keeps structured auth-expired responses as full cards", () => {
    expect(
      isCompactEligible({
        toolName: "id-jag_test__get_server_info",
        part: {
          type: "tool-id-jag_test__get_server_info",
          state: "output-available",
          output: {
            isError: true,
            _meta: {
              archestraError: {
                type: "auth_expired",
                message: 'Expired or invalid authentication for "id-jag test".',
                catalogId: "cat_abc",
                catalogName: "id-jag test",
                serverId: "srv_xyz",
                reauthUrl:
                  "http://localhost:3000/mcp/registry?reauth=cat_abc&server=srv_xyz",
              },
            },
          },
        } as never,
        toolResultPart: null,
      }),
    ).toBe(false);
  });

  it("keeps approval-requested tools as full cards", () => {
    expect(
      isCompactEligible({
        toolName: "github__delete_branch",
        part: {
          type: "tool-github__delete_branch",
          state: "approval-requested",
        } as never,
        toolResultPart: null,
      }),
    ).toBe(false);
  });

  it("keeps branded built-in todo-write tools out of compact groups", () => {
    expect(
      isCompactEligible({
        toolName: "sparky__todo_write",
        getToolShortName: (toolName: string) =>
          toolName === "sparky__todo_write" ? "todo_write" : null,
        part: {
          type: "tool-sparky__todo_write",
          state: "output-available",
        } as never,
        toolResultPart: null,
      }),
    ).toBe(false);
  });

  it("reports compact error state for generic tool failures", () => {
    expect(
      getCompactToolState({
        part: {
          type: "tool-notion__create_page",
          state: "input-available",
          errorText: "Notion failed",
        } as never,
        toolResultPart: null,
      }),
    ).toBe("error");
  });
});
