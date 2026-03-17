// biome-ignore-all lint/suspicious/noExplicitAny: test...
import {
  ARCHESTRA_MCP_SERVER_NAME,
  isArchestraMcpServerTool,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import {
  __test,
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

  test("includes outputSchema for structured-output tools", () => {
    const tools = getArchestraMcpTools();
    const tool = tools.find((item) => item.name.endsWith("whoami"));

    expect(tool).toBeDefined();
    expect(tool?.outputSchema).toBeDefined();
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

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    testAgent = await makeAgent({ name: "Test Agent", organizationId: org.id });
    mockContext = {
      agent: {
        id: testAgent.id,
        name: testAgent.name,
      },
      userId: user.id,
      organizationId: org.id,
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

  describe("router validation", () => {
    test("rejects invalid tool args centrally with nested paths", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}bulk_assign_tools_to_agents`,
        {
          assignments: [
            {
              agentId: testAgent.id,
              toolId: "not-a-uuid",
            },
          ],
        },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Validation error in archestra__bulk_assign_tools_to_agents",
      );
      expect((result.content[0] as any).text).toContain(
        "assignments[0].toolId:",
      );
    });

    test("catches schema errors in one spot and reports the exact nested field", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}todo_write`,
        {
          todos: [
            {
              id: 1,
              content: "bad status todo",
              status: "blocked",
            },
          ],
        },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Validation error in archestra__todo_write",
      );
      expect((result.content[0] as any).text).toContain("todos[0].status:");
      expect((result.content[0] as any).text).toContain(
        'expected one of "pending"|"in_progress"|"completed"',
      );
    });

    test("returns structuredContent for tools with outputSchema", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}whoami`,
        {},
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        agentId: testAgent.id,
        agentName: testAgent.name,
      });
    });

    test("catches output schema errors in one spot", () => {
      const result = __test.validateToolResult(
        {
          safeParse: (value: unknown) =>
            value && typeof value === "object" && "requiredField" in value
              ? ({ success: true, data: value } as const)
              : ({
                  success: false,
                  error: {
                    issues: [
                      {
                        code: "custom",
                        path: ["requiredField"],
                        message: "Missing required field",
                      },
                    ],
                  },
                } as const),
        } as any,
        {
          content: [{ type: "text", text: "bad output" }],
          structuredContent: {},
          isError: false,
        },
        "archestra__test_tool",
      );

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect((result.error.content[0] as any).text).toContain(
          "Internal output validation error in archestra__test_tool",
        );
        expect((result.error.content[0] as any).text).toContain(
          "requiredField:",
        );
      }
    });
  });
});

test("isArchestraMcpServerTool", () => {
  expect(isArchestraMcpServerTool("archestra__whoami")).toBe(true);
  expect(isArchestraMcpServerTool("archestra__create_agent")).toBe(true);
  expect(isArchestraMcpServerTool("mcp_server__tool")).toBe(false);
});
