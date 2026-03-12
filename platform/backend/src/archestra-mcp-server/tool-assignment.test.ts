// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { tools } from "./tool-assignment";

describe("tool assignment tools", () => {
  test("should have bulk_assign_tools_to_agents tool", () => {
    const tool = tools.find((t) =>
      t.name.endsWith("bulk_assign_tools_to_agents"),
    );
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Bulk Assign Tools to Agents");
    expect(tool?.inputSchema.required).toContain("assignments");
  });

  test("should have bulk_assign_tools_to_mcp_gateways tool", () => {
    const tool = tools.find((t) =>
      t.name.endsWith("bulk_assign_tools_to_mcp_gateways"),
    );
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Bulk Assign Tools to MCP Gateways");
    expect(tool?.inputSchema.required).toContain("assignments");
  });
});

describe("tool assignment tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent }) => {
    testAgent = await makeAgent({ name: "Test Agent" });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
    };
  });

  test("bulk_assign_tools_to_agents returns error when assignments is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}bulk_assign_tools_to_agents`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "assignments parameter is required",
    );
  });

  test("bulk_assign_tools_to_agents returns error when assignments is not an array", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}bulk_assign_tools_to_agents`,
      { assignments: "not-an-array" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "assignments parameter is required",
    );
  });

  test("bulk_assign_tools_to_mcp_gateways returns error when assignments is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}bulk_assign_tools_to_mcp_gateways`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "assignments parameter is required",
    );
  });

  test("bulk_assign_tools_to_agents handles empty assignments array", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}bulk_assign_tools_to_agents`,
      { assignments: [] },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.succeeded).toEqual([]);
    expect(parsed.failed).toEqual([]);
    expect(parsed.duplicates).toEqual([]);
  });
});
