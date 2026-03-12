// biome-ignore-all lint/suspicious/noExplicitAny: test...
import {
  ARCHESTRA_MCP_SERVER_NAME,
  isArchestraMcpServerTool,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import {
  type ArchestraContext,
  executeArchestraTool,
  getArchestraMcpTools,
} from ".";

describe("getArchestraMcpTools", () => {
  test("should return an array of tools with required properties", () => {
    const tools = getArchestraMcpTools();

    // Verify we have tools available (don't hardcode count as it changes)
    expect(tools.length).toBeGreaterThan(0);

    // Verify all tools have required properties
    for (const tool of tools) {
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("title");
      expect(tool).toHaveProperty("description");
      expect(tool).toHaveProperty("inputSchema");
    }
  });

  test("should have correctly formatted tool names with separator", () => {
    const tools = getArchestraMcpTools();

    for (const tool of tools) {
      expect(
        tool.name.startsWith(
          `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}`,
        ),
      ).toBe(true);
    }
  });
});

describe("executeArchestraTool", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent }) => {
    testAgent = await makeAgent({ name: "Test Agent" });
    mockContext = {
      agent: {
        id: testAgent.id,
        name: testAgent.name,
      },
    };
  });

  describe("unknown tool", () => {
    test("should throw error for unknown tool name", async () => {
      await expect(
        executeArchestraTool("unknown_tool", undefined, mockContext),
      ).rejects.toMatchObject({
        code: -32601,
        message: "Tool 'unknown_tool' not found",
      });
    });
  });
});

test("isArchestraMcpServerTool", () => {
  expect(isArchestraMcpServerTool("archestra__whoami")).toBe(true);
  expect(isArchestraMcpServerTool("archestra__create_agent")).toBe(true);
  expect(isArchestraMcpServerTool("mcp_server__tool")).toBe(false);
});
