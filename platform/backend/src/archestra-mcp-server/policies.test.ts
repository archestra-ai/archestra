// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { tools } from "./policies";

describe("policy tools", () => {
  test("should have get_autonomy_policy_operators tool", () => {
    const tool = tools.find((t) =>
      t.name.endsWith("get_autonomy_policy_operators"),
    );
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Get Autonomy Policy Operators");
  });

  test("should have all tool invocation policy tools", () => {
    const names = [
      "get_tool_invocation_policies",
      "create_tool_invocation_policy",
      "get_tool_invocation_policy",
      "update_tool_invocation_policy",
      "delete_tool_invocation_policy",
    ];
    for (const name of names) {
      expect(tools.find((t) => t.name.endsWith(name))).toBeDefined();
    }
  });

  test("should have all trusted data policy tools", () => {
    const names = [
      "get_trusted_data_policies",
      "create_trusted_data_policy",
      "get_trusted_data_policy",
      "update_trusted_data_policy",
      "delete_trusted_data_policy",
    ];
    for (const name of names) {
      expect(tools.find((t) => t.name.endsWith(name))).toBeDefined();
    }
  });
});

describe("policy tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent }) => {
    testAgent = await makeAgent({ name: "Test Agent" });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
    };
  });

  test("get_autonomy_policy_operators returns operators", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_autonomy_policy_operators`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty("value");
    expect(parsed[0]).toHaveProperty("label");
  });

  test("get_tool_invocation_policies returns empty when none exist", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_tool_invocation_policies`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("get_tool_invocation_policy returns error when id is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_tool_invocation_policy`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "id parameter is required",
    );
  });

  test("update_tool_invocation_policy returns error when id is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_tool_invocation_policy`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "id parameter is required",
    );
  });

  test("delete_tool_invocation_policy returns error when id is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}delete_tool_invocation_policy`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "id parameter is required",
    );
  });

  test("create and get tool invocation policy", async ({ makeTool }) => {
    const tool = await makeTool();
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_tool_invocation_policy`,
      {
        toolId: tool.id,
        conditions: [],
        action: "block_always",
        reason: "test policy",
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const created = JSON.parse((result.content[0] as any).text);
    expect(created).toHaveProperty("id");

    // Get the created policy
    const getResult = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_tool_invocation_policy`,
      { id: created.id },
      mockContext,
    );
    expect(getResult.isError).toBe(false);
    const fetched = JSON.parse((getResult.content[0] as any).text);
    expect(fetched.id).toBe(created.id);
  });

  test("get_trusted_data_policies returns empty when none exist", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_trusted_data_policies`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("get_trusted_data_policy returns error when id is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_trusted_data_policy`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "id parameter is required",
    );
  });

  test("delete_trusted_data_policy returns error when id is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}delete_trusted_data_policy`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "id parameter is required",
    );
  });

  test("create and get trusted data policy", async ({ makeTool }) => {
    const tool = await makeTool();
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_trusted_data_policy`,
      {
        toolId: tool.id,
        conditions: [],
        action: "mark_as_trusted",
        description: "test trusted data policy",
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const created = JSON.parse((result.content[0] as any).text);
    expect(created).toHaveProperty("id");

    // Get the created policy
    const getResult = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_trusted_data_policy`,
      { id: created.id },
      mockContext,
    );
    expect(getResult.isError).toBe(false);
    const fetched = JSON.parse((getResult.content[0] as any).text);
    expect(fetched.id).toBe(created.id);
  });
});
