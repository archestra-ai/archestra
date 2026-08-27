/**
 * Seed data for the MCP Gateway log list and its detail page.
 *
 * Three shapes, because the detail page reads differently for each: a
 * successful `tools/call` (titled by its tool, with arguments and a result), a
 * failed one (the header's status pill turns destructive), and an `initialize`
 * (no tool name, so the method titles the page and stops being a fact).
 */

const AGENT_ID = "agent-1";

function makeToolCall(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "mcp-call-success",
    agentId: AGENT_ID,
    agentName: "Support Assistant",
    ownerType: "agent",
    appName: null,
    mcpServerName: "confluence",
    method: "tools/call",
    userName: "Dana Okafor",
    authMethod: "user_token",
    createdAt: "2026-08-27T07:55:11.000Z",
    toolCall: {
      name: "confluence__search_pages",
      arguments: { query: "incident runbook", spaceKey: "ENG", limit: 5 },
    },
    toolResult: {
      isError: false,
      content: [
        {
          type: "text",
          text: "Found 5 pages in ENG matching 'incident runbook'.",
        },
      ],
    },
    ...overrides,
  };
}

export const mcpToolCallsSeed = [
  makeToolCall(),
  makeToolCall({
    id: "mcp-call-error",
    mcpServerName: "jira",
    createdAt: "2026-08-27T07:52:03.000Z",
    userName: "Rafael Nunes",
    toolCall: {
      name: "jira__create_issue",
      arguments: { project: "ENG", summary: "Retry queue backs up nightly" },
    },
    toolResult: {
      isError: true,
      error: "403 Forbidden: the account may not create issues in ENG.",
    },
  }),
  makeToolCall({
    id: "mcp-call-initialize",
    method: "initialize",
    mcpServerName: "confluence",
    createdAt: "2026-08-27T07:40:00.000Z",
    toolCall: null,
    toolResult: {
      isError: false,
      content: [{ type: "text", text: "Session established." }],
    },
  }),
];

/** Detail lookups are by id, so the list doubles as the detail source. */
export function findMcpToolCall(id: string): Record<string, unknown> {
  return mcpToolCallsSeed.find((call) => call.id === id) ?? mcpToolCallsSeed[0];
}
