// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { fastifyAuthPlugin, loopbackGateway } from "@/auth";
import { LimitModel } from "@/models";
import limitsRoutes from "@/routes/limits";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { ARCHESTRA_API_DEPRECATION_NOTE } from "./helpers";

function toolName(shortName: string): string {
  return `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${shortName}`;
}

function lastText(result: { content: unknown[] }): string {
  return (result.content[result.content.length - 1] as any).text;
}

describe("limit tool execution", () => {
  let app: FastifyInstanceWithZod;
  let testAgent: Agent;
  let mockContext: ArchestraContext & {
    virtualApiKeyId: string;
  };

  beforeEach(
    async ({
      makeAgent,
      makeAdmin,
      makeVirtualApiKey,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeAdmin();
      const virtualApiKey = await makeVirtualApiKey(org.id);
      await makeMember(user.id, org.id, { role: "admin" });
      testAgent = await makeAgent({
        name: "Test Agent",
        organizationId: org.id,
      });
      mockContext = {
        agent: { id: testAgent.id, name: testAgent.name },
        userId: user.id,
        organizationId: org.id,
        virtualApiKeyId: virtualApiKey.id,
      };

      // The create/update/delete tools delegate through an in-process loopback
      // REST call, so a real Fastify server with the auth middleware + limits
      // routes must back the loopback gateway.
      app = createFastifyInstance();
      await app.register(fastifyAuthPlugin);
      await app.register(limitsRoutes);
      loopbackGateway.setServer(app);
      await app.ready();
    },
  );

  afterEach(async () => {
    await app.close();
  });

  test("create_limit returns error when required fields are missing", async () => {
    const result = await executeArchestraTool(
      toolName("create_limit"),
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

  test("create_limit succeeds with omitted model (all models)", async () => {
    const result = await executeArchestraTool(
      toolName("create_limit"),
      {
        entity_type: "agent",
        entity_id: testAgent.id,
        limit_type: "token_cost",
        limit_value: 1000,
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.status).toBe(200);

    const created = (result.structuredContent?.body as any).id as string;
    const stored = await LimitModel.findById(created);
    expect(stored?.model).toBeNull();
    expect(lastText(result)).toBe(ARCHESTRA_API_DEPRECATION_NOTE);
  });

  test("create_limit succeeds with null model (all models)", async () => {
    const result = await executeArchestraTool(
      toolName("create_limit"),
      {
        entity_type: "agent",
        entity_id: testAgent.id,
        limit_type: "token_cost",
        limit_value: 1000,
        model: null,
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.status).toBe(200);
    expect((result.structuredContent?.body as any).model).toBeNull();
    expect(lastText(result)).toBe(ARCHESTRA_API_DEPRECATION_NOTE);
  });

  test("create_limit succeeds with empty model array (all models)", async () => {
    const result = await executeArchestraTool(
      toolName("create_limit"),
      {
        entity_type: "agent",
        entity_id: testAgent.id,
        limit_type: "token_cost",
        limit_value: 1000,
        model: [],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.status).toBe(200);
    expect((result.structuredContent?.body as any).model).toBeNull();
    expect(lastText(result)).toBe(ARCHESTRA_API_DEPRECATION_NOTE);
  });

  test("create_limit returns error when mcp_server_calls limit missing mcp_server_name", async () => {
    const result = await executeArchestraTool(
      toolName("create_limit"),
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
      toolName("create_limit"),
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
      toolName("get_limits"),
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ limits: [] });
    expect((result.content[0] as any).text).toContain("No limits found");
    // get_limits is still a deprecated platform tool, so it carries the note.
    expect(lastText(result)).toBe(ARCHESTRA_API_DEPRECATION_NOTE);
  });

  test("update_limit returns error when id is missing", async () => {
    const result = await executeArchestraTool(
      toolName("update_limit"),
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
      toolName("update_limit"),
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
      toolName("delete_limit"),
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
      toolName("get_agent_token_usage"),
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
    expect(lastText(result)).toBe(ARCHESTRA_API_DEPRECATION_NOTE);
  });

  test("full limit CRUD lifecycle through the loopback API", async () => {
    // Create a token_cost limit via the loopback POST /api/limits.
    const createResult = await executeArchestraTool(
      toolName("create_limit"),
      {
        entity_type: "agent",
        entity_id: testAgent.id,
        limit_type: "token_cost",
        limit_value: 1000,
        model: ["gpt-4o"],
        cleanup_interval: "12h",
      },
      mockContext,
    );
    expect(createResult.isError).toBe(false);
    expect(createResult.structuredContent?.status).toBe(200);
    expect(lastText(createResult)).toBe(ARCHESTRA_API_DEPRECATION_NOTE);

    const createdBody = createResult.structuredContent?.body as any;
    const limitId = createdBody.id as string;
    expect(createdBody).toMatchObject({
      limitType: "token_cost",
      limitValue: 1000,
      cleanupInterval: "12h",
      model: ["gpt-4o"],
    });

    // Verify the real effect: the limit exists in the database.
    const afterCreate = await LimitModel.findById(limitId);
    expect(afterCreate).toMatchObject({
      limitType: "token_cost",
      limitValue: 1000,
      cleanupInterval: "12h",
    });

    // Get limits and verify the created limit appears (unchanged tool path).
    const getResult = await executeArchestraTool(
      toolName("get_limits"),
      { entity_type: "agent", entity_id: testAgent.id },
      mockContext,
    );
    expect(getResult.isError).toBe(false);
    const getText = (getResult.content[0] as any).text;
    expect(getText).toContain("Found 1 limit(s)");
    expect(getText).toContain(limitId);
    expect(getText).toContain("token_cost");

    // Update the limit value via the loopback PATCH /api/limits/:id.
    const updateResult = await executeArchestraTool(
      toolName("update_limit"),
      { id: limitId, limit_value: 2000, cleanup_interval: "1w" },
      mockContext,
    );
    expect(updateResult.isError).toBe(false);
    expect(updateResult.structuredContent?.status).toBe(200);
    expect(updateResult.structuredContent?.body as any).toMatchObject({
      limitValue: 2000,
      cleanupInterval: "1w",
    });
    expect(lastText(updateResult)).toBe(ARCHESTRA_API_DEPRECATION_NOTE);

    const afterUpdate = await LimitModel.findById(limitId);
    expect(afterUpdate?.limitValue).toBe(2000);
    expect(afterUpdate?.cleanupInterval).toBe("1w");

    // Delete the limit via the loopback DELETE /api/limits/:id.
    const deleteResult = await executeArchestraTool(
      toolName("delete_limit"),
      { id: limitId },
      mockContext,
    );
    expect(deleteResult.isError).toBe(false);
    expect(deleteResult.structuredContent?.status).toBe(200);
    expect(lastText(deleteResult)).toBe(ARCHESTRA_API_DEPRECATION_NOTE);

    // Verify the real effect: the limit is gone.
    expect(await LimitModel.findById(limitId)).toBeNull();

    const verifyResult = await executeArchestraTool(
      toolName("get_limits"),
      { entity_type: "agent", entity_id: testAgent.id },
      mockContext,
    );
    expect(verifyResult.isError).toBe(false);
    expect((verifyResult.content[0] as any).text).toContain("No limits found");
  });

  test("create_limit succeeds for mcp_server_calls type", async () => {
    const result = await executeArchestraTool(
      toolName("create_limit"),
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
    expect(result.structuredContent?.status).toBe(200);
    expect((result.structuredContent?.body as any).mcpServerName).toBe(
      "test-server",
    );
    expect(lastText(result)).toBe(ARCHESTRA_API_DEPRECATION_NOTE);
  });

  test("create_limit succeeds for tool_calls type", async () => {
    const result = await executeArchestraTool(
      toolName("create_limit"),
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
    expect(result.structuredContent?.status).toBe(200);
    expect(result.structuredContent?.body as any).toMatchObject({
      mcpServerName: "test-server",
      toolName: "test-tool",
    });
    expect(lastText(result)).toBe(ARCHESTRA_API_DEPRECATION_NOTE);
  });

  test("create_limit succeeds for user entity type", async () => {
    const result = await executeArchestraTool(
      toolName("create_limit"),
      {
        entity_type: "user",
        entity_id: mockContext.userId,
        limit_type: "token_cost",
        limit_value: 1000,
        model: ["gpt-4o"],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.status).toBe(200);
    expect((result.structuredContent?.body as any).entityType).toBe("user");
    expect(lastText(result)).toBe(ARCHESTRA_API_DEPRECATION_NOTE);
  });

  test("create_limit succeeds for virtual_key entity type", async () => {
    const result = await executeArchestraTool(
      toolName("create_limit"),
      {
        entity_type: "virtual_key",
        entity_id: mockContext.virtualApiKeyId,
        limit_type: "token_cost",
        limit_value: 1000,
        model: ["gpt-4o"],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.status).toBe(200);
    expect((result.structuredContent?.body as any).entityType).toBe(
      "virtual_key",
    );
    expect(lastText(result)).toBe(ARCHESTRA_API_DEPRECATION_NOTE);
  });

  test("update_limit returns error for nonexistent limit", async () => {
    const result = await executeArchestraTool(
      toolName("update_limit"),
      { id: crypto.randomUUID(), limit_value: 999 },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.status).toBe(404);
    expect(lastText(result)).toBe(ARCHESTRA_API_DEPRECATION_NOTE);
  });

  test("delete_limit returns error for nonexistent limit", async () => {
    const result = await executeArchestraTool(
      toolName("delete_limit"),
      { id: crypto.randomUUID() },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.status).toBe(404);
    expect(lastText(result)).toBe(ARCHESTRA_API_DEPRECATION_NOTE);
  });
});
