// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { tools } from "./limits";

describe("limit tools", () => {
  test("should have create_limit tool", () => {
    const tool = tools.find((t) => t.name.endsWith("create_limit"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Create Limit");
    expect(tool?.inputSchema.required).toContain("entity_type");
  });

  test("should have get_limits tool", () => {
    const tool = tools.find((t) => t.name.endsWith("get_limits"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Get Limits");
  });

  test("should have update_limit tool", () => {
    const tool = tools.find((t) => t.name.endsWith("update_limit"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Update Limit");
  });

  test("should have delete_limit tool", () => {
    const tool = tools.find((t) => t.name.endsWith("delete_limit"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Delete Limit");
  });

  test("should have get_agent_token_usage tool", () => {
    const tool = tools.find((t) => t.name.endsWith("get_agent_token_usage"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Get Agent Token Usage");
  });

  test("should have get_llm_proxy_token_usage tool", () => {
    const tool = tools.find((t) =>
      t.name.endsWith("get_llm_proxy_token_usage"),
    );
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Get LLM Proxy Token Usage");
  });
});

describe("limit tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent }) => {
    testAgent = await makeAgent({ name: "Test Agent" });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
    };
  });

  test("create_limit returns error when required fields are missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "entity_type, entity_id, limit_type, and limit_value are required",
    );
  });

  test("create_limit returns error when token_cost limit missing model", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
      {
        entity_type: "agent",
        entity_id: testAgent.id,
        limit_type: "token_cost",
        limit_value: 1000,
      },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "model array with at least one model is required",
    );
  });

  test("create_limit returns error when mcp_server_calls limit missing mcp_server_name", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
      {
        entity_type: "agent",
        entity_id: testAgent.id,
        limit_type: "mcp_server_calls",
        limit_value: 100,
      },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "mcp_server_name is required for mcp_server_calls",
    );
  });

  test("create_limit returns error when tool_calls limit missing fields", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
      {
        entity_type: "agent",
        entity_id: testAgent.id,
        limit_type: "tool_calls",
        limit_value: 50,
      },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "mcp_server_name and tool_name are required for tool_calls",
    );
  });

  test("get_limits returns empty when no limits exist", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_limits`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain("No limits found");
  });

  test("update_limit returns error when id is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_limit`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("id is required");
  });

  test("update_limit returns error when no fields provided", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_limit`,
      { id: "some-id" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "No fields provided to update",
    );
  });

  test("delete_limit returns error when id is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}delete_limit`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("id is required");
  });

  test("get_agent_token_usage returns usage for current agent", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_agent_token_usage`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain("Token usage for agent");
    expect((result.content[0] as any).text).toContain("Total Input Tokens");
  });
});
