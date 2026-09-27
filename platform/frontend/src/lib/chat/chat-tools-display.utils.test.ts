// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  getCompactToolState,
  getCurrentEnabledToolIds,
  getDefaultEnabledToolIds,
  getHumanRulingDisplay,
  getToolErrorText,
  getToolNameFromPart,
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
      { id: "a2", name: "archestra__todo_write" },
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
  it("extracts tool names from toolName or type", () => {
    expect(
      getToolNameFromPart({ toolName: "archestra__query_knowledge_sources" }),
    ).toBe("archestra__query_knowledge_sources");
    expect(
      getToolNameFromPart({ type: "tool-archestra__query_knowledge_sources" }),
    ).toBe("archestra__query_knowledge_sources");
  });

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
            'I tried to invoke the linear__create_issue tool with the following arguments: {"title":"Blocked"}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: sensitive data detected',
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

  it("keeps assigned-credential-unavailable responses as full cards", () => {
    expect(
      isCompactEligible({
        toolName: "githubcopilot__remote-mcp__issue_write",
        part: {
          type: "tool-githubcopilot__remote-mcp__issue_write",
          state: "output-available",
          output: {
            isError: true,
            _meta: {
              archestraError: {
                type: "assigned_credential_unavailable",
                message: "Assigned credential unavailable",
                catalogId: "cat_abc",
                catalogName: "githubcopilot__remote-mcp",
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

  it("computes compact tool state from output state", () => {
    expect(
      getCompactToolState({
        part: {
          type: "tool-github__create_issue",
          state: "input-available",
        } as never,
        toolResultPart: null,
      }),
    ).toBe("running");

    expect(
      getCompactToolState({
        part: {
          type: "tool-github__create_issue",
          state: "output-available",
        } as never,
        toolResultPart: null,
      }),
    ).toBe("completed");

    // A declined approval is terminal: it must map to "denied" (orange dot), not
    // fall through to "running" (a blue pulsing dot that never resolves).
    expect(
      getCompactToolState({
        part: {
          type: "tool-github__create_issue",
          state: "output-denied",
        } as never,
        toolResultPart: null,
      }),
    ).toBe("denied");
  });
});

describe("reviewed remedy rulings", () => {
  function remedyPart(output: unknown) {
    return {
      type: "tool-archestra__execute_remedy_plan",
      toolCallId: "call-remedy",
      state: "output-available",
      input: { offer_id: "offer-1" },
      output,
    } as never;
  }

  it("shows a remedy the viewer denied as denied, not completed", () => {
    const part = remedyPart({
      content: "[appa] Denied: the human reviewer refused this call.",
      _meta: { archestraHumanRuling: "deny" },
    });

    expect(getCompactToolState({ part, toolResultPart: null })).toBe("denied");
    expect(getHumanRulingDisplay({ part, toolResultPart: null })).toEqual({
      ruling: "deny",
      label: "Denied by you",
    });
  });

  it("reads the ruling off the result part when the call and result are split", () => {
    const toolResultPart = remedyPart({
      content: "[appa] Denied: the human reviewer refused this call.",
      _meta: { archestraHumanRuling: "deny" },
    });
    const part = {
      type: "tool-archestra__execute_remedy_plan",
      toolCallId: "call-remedy",
      state: "input-available",
      input: { offer_id: "offer-1" },
    } as never;

    expect(getCompactToolState({ part, toolResultPart })).toBe("denied");
  });

  it("keeps an approved remedy completed, labelled as the viewer's approval", () => {
    const part = remedyPart({
      content: "[appa] Authorized.",
      _meta: { archestraHumanRuling: "approve" },
    });

    expect(getCompactToolState({ part, toolResultPart: null })).toBe(
      "completed",
    );
    expect(getHumanRulingDisplay({ part, toolResultPart: null })?.label).toBe(
      "Approved by you",
    );
  });

  it("lets an error outrank the ruling it answered", () => {
    const part = remedyPart({
      content: "[appa] offer invalidated",
      _meta: {
        archestraError: { type: "generic", message: "offer invalidated" },
        archestraHumanRuling: "deny",
      },
    });

    expect(getCompactToolState({ part, toolResultPart: null })).toBe("error");
    expect(getHumanRulingDisplay({ part, toolResultPart: null })).toBeNull();
  });
});

it("keeps structured OpenAPPA denials out of generic compact error details", () => {
  const part = {
    type: "tool-archestra__whoami" as const,
    toolCallId: "blocked-attempt",
    state: "output-available" as const,
    input: {},
    output: {
      isError: true,
      content: [
        { type: "text", text: "Accept the session restriction using offer-1" },
      ],
      _meta: {
        appaBlockedReceipt: "opaque-receipt",
        archestraError: {
          type: "policy_denied",
          toolName: "archestra__whoami",
          input: {},
          reason: "Session trust would fall",
          message: "Accept the session restriction using offer-1",
        },
      },
    },
  };
  expect(
    isCompactEligible({
      part,
      toolResultPart: null,
      toolName: "archestra__whoami",
    }),
  ).toBe(false);
  expect(getToolErrorText({ part, toolResultPart: null })).toContain("offer-1");
});
