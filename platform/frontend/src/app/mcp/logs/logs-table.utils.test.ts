import { describe, expect, test } from "vitest";
import { enrichMcpToolCallRows } from "./logs-table.utils";

describe("enrichMcpToolCallRows", () => {
  test("precomputes agent names, server display names, tool display names, and argument text", () => {
    const rows = enrichMcpToolCallRows({
      toolCalls: [
        {
          id: "call-1",
          agentId: "agent-1",
          method: "tools/call",
          mcpServerName: "server-a",
          toolCall: { name: "server-a__tool-name", arguments: { count: 2 } },
        },
      ],
      agents: [{ id: "agent-1", name: "Gateway One" }],
      serverNameToCatalogName: new Map([["server-a", "Server A"]]),
    });

    expect(rows[0]).toMatchObject({
      agentName: "Gateway One",
      serverDisplayName: "Server A",
      toolDisplayName: "tool-name",
      argumentsText: '{"count":2}',
    });
  });
});
