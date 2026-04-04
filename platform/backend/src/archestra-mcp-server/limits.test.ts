// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

describe("limit tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    testAgent = await makeAgent({ name: "Test Agent", organizationId: org.id });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: user.id,
      organizationId: org.id,
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
      "Validation error in archestra__create_limit",
    );
    expect((result.content[0] as any).text).toContain("entity_type:");
    expect((result.content[0] as any).text).toContain("entity_id:");
    expect((result.content[0] as any).text).toContain("limit_type:");
    expect((result.content[0] as any).text).toContain("limit_value:");
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
    expect((result.content[0] as any).text).toContain("model:");
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
    expect((result.content[0] as any).text).toContain("mcp_server_name:");
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
    expect((result.content[0] as any).text).toContain("tool_name:");
  });

  test("get_limits returns empty when no limits exist", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_limits`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ limits: [] });
    expect((result.content[0] as any).text).toContain("No limits found");
  });

  test("update_limit returns error when id is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_limit`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__update_limit",
    );
    expect((result.content[0] as any).text).toContain("id:");
  });

  test("update_limit returns error when no fields provided", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_limit`,
      { id: "00000000-0000-4000-8000-000000000001" },
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
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__delete_limit",
    );
    expect((result.content[0] as any).text).toContain("id:");
  });

  test("get_agent_token_usage returns usage for current agent", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_agent_token_usage`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      id: testAgent.id,
      totalInputTokens: expect.any(Number),
      totalOutputTokens: expect.any(Number),
      totalTokens: expect.any(Number),
    });
    expect((result.content[0] as any).text).toContain("Token usage for agent");
    expect((result.content[0] as any).text).toContain("Total Input Tokens");
  });

  test("full limit CRUD lifecycle", async () => {
    // Create a token_cost limit
    const createResult = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
      {
        entity_type: "agent",
        entity_id: testAgent.id,
        limit_type: "token_cost",
        limit_value: 1000,
        model: ["gpt-4o"],
      },
      mockContext,
    );
    expect(createResult.isError).toBe(false);
    const createText = (createResult.content[0] as any).text;
    expect(createText).toContain("Successfully created limit");
    expect(createText).toContain("Limit Type: token_cost");
    expect(createText).toContain("Limit Value: 1000");

    // Extract the limit ID
    const idMatch = createText.match(/Limit ID: (.+)/);
    expect(idMatch).toBeTruthy();
    const limitId = idMatch?.[1].trim();

    // Get limits and verify the created limit appears
    const getResult = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_limits`,
      { entity_type: "agent", entity_id: testAgent.id },
      mockContext,
    );
    expect(getResult.isError).toBe(false);
    const getText = (getResult.content[0] as any).text;
    expect(getText).toContain("Found 1 limit(s)");
    expect(getText).toContain(limitId);
    expect(getText).toContain("token_cost");

    // Update the limit value
    const updateResult = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_limit`,
      { id: limitId, limit_value: 2000 },
      mockContext,
    );
    expect(updateResult.isError).toBe(false);
    expect((updateResult.content[0] as any).text).toContain(
      "Successfully updated limit",
    );
    expect((updateResult.content[0] as any).text).toContain(
      "Limit Value: 2000",
    );

    // Delete the limit
    const deleteResult = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}delete_limit`,
      { id: limitId },
      mockContext,
    );
    expect(deleteResult.isError).toBe(false);
    expect((deleteResult.content[0] as any).text).toContain(
      "Successfully deleted limit",
    );

    // Verify the limit is gone
    const verifyResult = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_limits`,
      { entity_type: "agent", entity_id: testAgent.id },
      mockContext,
    );
    expect(verifyResult.isError).toBe(false);
    expect((verifyResult.content[0] as any).text).toContain("No limits found");
  });

  test("create_limit succeeds for mcp_server_calls type", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
      {
        entity_type: "agent",
        entity_id: testAgent.id,
        limit_type: "mcp_server_calls",
        limit_value: 100,
        mcp_server_name: "test-server",
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully created limit",
    );
    expect((result.content[0] as any).text).toContain(
      "MCP Server: test-server",
    );
  });

  test("create_limit succeeds for tool_calls type", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
      {
        entity_type: "agent",
        entity_id: testAgent.id,
        limit_type: "tool_calls",
        limit_value: 50,
        mcp_server_name: "test-server",
        tool_name: "test-tool",
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully created limit",
    );
    expect((result.content[0] as any).text).toContain(
      "MCP Server: test-server",
    );
    expect((result.content[0] as any).text).toContain("Tool: test-tool");
  });

  test("update_limit returns error for nonexistent limit", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_limit`,
      { id: crypto.randomUUID(), limit_value: 999 },
      mockContext,
    );
    expect(result.isError).toBe(true);
  });

  test("delete_limit returns error for nonexistent limit", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}delete_limit`,
      { id: crypto.randomUUID() },
      mockContext,
    );
    expect(result.isError).toBe(true);
  });
});
