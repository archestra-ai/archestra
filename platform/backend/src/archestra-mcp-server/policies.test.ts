// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { fastifyAuthPlugin, loopbackGateway } from "@/auth";
import autonomyPolicyRoutes from "@/routes/autonomy-policies";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { ARCHESTRA_API_DEPRECATION_NOTE } from "./helpers";

const toolName = (shortName: string) =>
  `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${shortName}`;

const lastText = (result: any) =>
  (result.content[result.content.length - 1] as any).text;

const firstText = (result: any) => (result.content[0] as any).text;

// A syntactically valid v4 UUID that no policy/tool will ever own, so the
// request clears input validation and reaches the REST route (which 404s).
const ABSENT_UUID = "11111111-1111-4111-8111-111111111111";

describe("policy tool execution", () => {
  let app: FastifyInstanceWithZod;
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

    // The deprecated write tools delegate through an in-process loopback REST
    // call, so a real Fastify server with the auth middleware + policy routes
    // must be registered and wired to the loopback gateway.
    app = createFastifyInstance();
    await app.register(fastifyAuthPlugin);
    await app.register(autonomyPolicyRoutes);
    loopbackGateway.setServer(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test("every tool result carries the deprecation note", async () => {
    const result = await executeArchestraTool(
      toolName("get_tool_invocation_policies"),
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(lastText(result)).toContain(ARCHESTRA_API_DEPRECATION_NOTE);
    expect(lastText(result)).toContain(
      "Deprecated: prefer the archestra__api tool",
    );
  });

  test("get_autonomy_policy_operators returns operators", async () => {
    const result = await executeArchestraTool(
      toolName("get_autonomy_policy_operators"),
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      operators: expect.any(Array),
    });
    // First block is the tool payload, last block is the deprecation note.
    const parsed = JSON.parse(firstText(result));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty("value");
    expect(parsed[0]).toHaveProperty("label");
    expect(lastText(result)).toContain(ARCHESTRA_API_DEPRECATION_NOTE);
  });

  test("get_tool_invocation_policies returns empty when none exist", async () => {
    const result = await executeArchestraTool(
      toolName("get_tool_invocation_policies"),
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(firstText(result));
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("get_tool_invocation_policy returns error when id is missing", async () => {
    const result = await executeArchestraTool(
      toolName("get_tool_invocation_policy"),
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain(
      "Validation error in archestra__get_tool_invocation_policy",
    );
    expect(firstText(result)).toContain("id:");
  });

  test("update_tool_invocation_policy returns error when id is missing", async () => {
    const result = await executeArchestraTool(
      toolName("update_tool_invocation_policy"),
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain(
      "Validation error in archestra__update_tool_invocation_policy",
    );
    expect(firstText(result)).toContain("id:");
  });

  test("delete_tool_invocation_policy returns error when id is missing", async () => {
    const result = await executeArchestraTool(
      toolName("delete_tool_invocation_policy"),
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain(
      "Validation error in archestra__delete_tool_invocation_policy",
    );
    expect(firstText(result)).toContain("id:");
  });

  test("create_tool_invocation_policy round-trips through the REST API", async ({
    makeTool,
  }) => {
    const tool = await makeTool();
    const result = await executeArchestraTool(
      toolName("create_tool_invocation_policy"),
      {
        toolId: tool.id,
        conditions: [],
        action: "block_always",
        reason: "test policy",
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.structuredContent as any).status).toBe(200);
    const created = (result.structuredContent as any).body;
    expect(created.toolId).toBe(tool.id);
    expect(created.id).toBeDefined();
    expect(lastText(result)).toContain(ARCHESTRA_API_DEPRECATION_NOTE);

    // Verify the real effect: the created policy is retrievable.
    const getResult = await executeArchestraTool(
      toolName("get_tool_invocation_policy"),
      { id: created.id },
      mockContext,
    );
    expect(getResult.isError).toBe(false);
    expect(getResult.structuredContent).toEqual({
      policy: expect.objectContaining({ id: created.id }),
    });
    const fetched = JSON.parse(firstText(getResult));
    expect(fetched.id).toBe(created.id);
  });

  test("create_tool_invocation_policy reports an API error for an unknown tool", async () => {
    const result = await executeArchestraTool(
      toolName("create_tool_invocation_policy"),
      {
        toolId: ABSENT_UUID,
        conditions: [],
        action: "block_always",
        reason: "no such tool",
      },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).status).toBeGreaterThanOrEqual(
      400,
    );
    expect(lastText(result)).toContain(ARCHESTRA_API_DEPRECATION_NOTE);
  });

  test("get_trusted_data_policies returns empty when none exist", async () => {
    const result = await executeArchestraTool(
      toolName("get_trusted_data_policies"),
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(firstText(result));
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("get_trusted_data_policy returns error when id is missing", async () => {
    const result = await executeArchestraTool(
      toolName("get_trusted_data_policy"),
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain(
      "Validation error in archestra__get_trusted_data_policy",
    );
    expect(firstText(result)).toContain("id:");
  });

  test("delete_trusted_data_policy returns error when id is missing", async () => {
    const result = await executeArchestraTool(
      toolName("delete_trusted_data_policy"),
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain(
      "Validation error in archestra__delete_trusted_data_policy",
    );
    expect(firstText(result)).toContain("id:");
  });

  test("create_trusted_data_policy round-trips through the REST API", async ({
    makeTool,
  }) => {
    const tool = await makeTool();
    const result = await executeArchestraTool(
      toolName("create_trusted_data_policy"),
      {
        toolId: tool.id,
        conditions: [],
        action: "mark_as_trusted",
        description: "test trusted data policy",
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.structuredContent as any).status).toBe(200);
    const created = (result.structuredContent as any).body;
    expect(created.toolId).toBe(tool.id);
    expect(created.id).toBeDefined();
    expect(lastText(result)).toContain(ARCHESTRA_API_DEPRECATION_NOTE);

    // Verify the real effect: the created policy is retrievable.
    const getResult = await executeArchestraTool(
      toolName("get_trusted_data_policy"),
      { id: created.id },
      mockContext,
    );
    expect(getResult.isError).toBe(false);
    const fetched = JSON.parse(firstText(getResult));
    expect(fetched.id).toBe(created.id);
  });

  test("full tool invocation policy CRUD lifecycle", async ({ makeTool }) => {
    const tool = await makeTool();

    // Create
    const createResult = await executeArchestraTool(
      toolName("create_tool_invocation_policy"),
      {
        toolId: tool.id,
        conditions: [{ key: "url", operator: "contains", value: "internal" }],
        action: "block_always",
        reason: "block internal URLs",
      },
      mockContext,
    );
    expect(createResult.isError).toBe(false);
    expect((createResult.structuredContent as any).status).toBe(200);
    const created = (createResult.structuredContent as any).body;
    expect(created.id).toBeDefined();
    expect(created.action).toBe("block_always");

    // Update
    const updateResult = await executeArchestraTool(
      toolName("update_tool_invocation_policy"),
      {
        id: created.id,
        action: "block_when_context_is_untrusted",
        reason: "updated reason",
      },
      mockContext,
    );
    expect(updateResult.isError).toBe(false);
    expect((updateResult.structuredContent as any).status).toBe(200);
    const updated = (updateResult.structuredContent as any).body;
    expect(updated.action).toBe("block_when_context_is_untrusted");

    // Verify in list (read tool, unchanged shape)
    const listResult = await executeArchestraTool(
      toolName("get_tool_invocation_policies"),
      {},
      mockContext,
    );
    expect(listResult.isError).toBe(false);
    const list = JSON.parse(firstText(listResult));
    expect(list.some((p: any) => p.id === created.id)).toBe(true);

    // Delete
    const deleteResult = await executeArchestraTool(
      toolName("delete_tool_invocation_policy"),
      { id: created.id },
      mockContext,
    );
    expect(deleteResult.isError).toBe(false);
    expect((deleteResult.structuredContent as any).status).toBe(200);
    expect((deleteResult.structuredContent as any).body).toEqual({
      success: true,
    });

    // Verify deleted
    const getAfterDelete = await executeArchestraTool(
      toolName("get_tool_invocation_policy"),
      { id: created.id },
      mockContext,
    );
    expect(getAfterDelete.isError).toBe(true);
    expect(firstText(getAfterDelete)).toContain("not found");
  });

  test("delete_tool_invocation_policy on an unknown id reports an API error", async () => {
    const result = await executeArchestraTool(
      toolName("delete_tool_invocation_policy"),
      { id: ABSENT_UUID },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).status).toBe(404);
    expect(lastText(result)).toContain(ARCHESTRA_API_DEPRECATION_NOTE);
  });

  test("full trusted data policy CRUD lifecycle", async ({ makeTool }) => {
    const tool = await makeTool();

    // Create
    const createResult = await executeArchestraTool(
      toolName("create_trusted_data_policy"),
      {
        toolId: tool.id,
        conditions: [{ key: "source", operator: "equal", value: "internal" }],
        action: "mark_as_trusted",
        description: "trust internal sources",
      },
      mockContext,
    );
    expect(createResult.isError).toBe(false);
    expect((createResult.structuredContent as any).status).toBe(200);
    const created = (createResult.structuredContent as any).body;
    expect(created.id).toBeDefined();

    // Update
    const updateResult = await executeArchestraTool(
      toolName("update_trusted_data_policy"),
      {
        id: created.id,
        action: "mark_as_untrusted",
        description: "updated description",
      },
      mockContext,
    );
    expect(updateResult.isError).toBe(false);
    expect((updateResult.structuredContent as any).status).toBe(200);
    const updated = (updateResult.structuredContent as any).body;
    expect(updated.action).toBe("mark_as_untrusted");

    // Verify in list (read tool, unchanged shape)
    const listResult = await executeArchestraTool(
      toolName("get_trusted_data_policies"),
      {},
      mockContext,
    );
    expect(listResult.isError).toBe(false);
    const list = JSON.parse(firstText(listResult));
    expect(list.some((p: any) => p.id === created.id)).toBe(true);

    // Delete
    const deleteResult = await executeArchestraTool(
      toolName("delete_trusted_data_policy"),
      { id: created.id },
      mockContext,
    );
    expect(deleteResult.isError).toBe(false);
    expect((deleteResult.structuredContent as any).status).toBe(200);
    expect((deleteResult.structuredContent as any).body).toEqual({
      success: true,
    });

    // Verify deleted
    const getAfterDelete = await executeArchestraTool(
      toolName("get_trusted_data_policy"),
      { id: created.id },
      mockContext,
    );
    expect(getAfterDelete.isError).toBe(true);
    expect(firstText(getAfterDelete)).toContain("not found");
  });

  test("delete_trusted_data_policy on an unknown id reports an API error", async () => {
    const result = await executeArchestraTool(
      toolName("delete_trusted_data_policy"),
      { id: ABSENT_UUID },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).status).toBe(404);
    expect(lastText(result)).toContain(ARCHESTRA_API_DEPRECATION_NOTE);
  });
});
