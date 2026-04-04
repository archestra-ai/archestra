// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const AGENTS_TOOL = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}bulk_assign_tools_to_agents`;
const GATEWAYS_TOOL = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}bulk_assign_tools_to_mcp_gateways`;

describe("tool assignment tool execution", () => {
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

  test("bulk_assign_tools_to_agents returns error when assignments is missing", async () => {
    const result = await executeArchestraTool(AGENTS_TOOL, {}, mockContext);
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Validation error");
  });

  test("bulk_assign_tools_to_agents returns error when assignments is not an array", async () => {
    const result = await executeArchestraTool(
      AGENTS_TOOL,
      { assignments: "not-an-array" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Validation error");
  });

  test("bulk_assign_tools_to_mcp_gateways returns error when assignments is missing", async () => {
    const result = await executeArchestraTool(GATEWAYS_TOOL, {}, mockContext);
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Validation error");
  });

  test("bulk_assign_tools_to_agents handles empty assignments array", async () => {
    const result = await executeArchestraTool(
      AGENTS_TOOL,
      { assignments: [] },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      succeeded: [],
      failed: [],
      duplicates: [],
    });
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.succeeded).toEqual([]);
    expect(parsed.failed).toEqual([]);
    expect(parsed.duplicates).toEqual([]);
  });

  test("bulk_assign_tools_to_agents assigns real tools to real agents", async ({
    makeAgent,
    makeTool,
  }) => {
    const agent1 = await makeAgent({ name: "Agent One" });
    const agent2 = await makeAgent({ name: "Agent Two" });
    const tool1 = await makeTool({ name: "assign_test_tool_1" });
    const tool2 = await makeTool({ name: "assign_test_tool_2" });

    const result = await executeArchestraTool(
      AGENTS_TOOL,
      {
        assignments: [
          { agentId: agent1.id, toolId: tool1.id },
          { agentId: agent1.id, toolId: tool2.id },
          { agentId: agent2.id, toolId: tool1.id },
        ],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.succeeded.length).toBe(3);
    expect(parsed.failed.length).toBe(0);

    const persistedAssignments = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.toolId, tool1.id),
          eq(schema.agentToolsTable.agentId, agent1.id),
        ),
      );
    expect(persistedAssignments).toHaveLength(1);
  });

  test("bulk_assign_tools_to_agents detects duplicates on second assignment", async ({
    makeAgent,
    makeTool,
  }) => {
    const agent = await makeAgent({ name: "Dup Agent" });
    const tool = await makeTool({ name: "dup_test_tool" });

    // First assignment succeeds
    await executeArchestraTool(
      AGENTS_TOOL,
      { assignments: [{ agentId: agent.id, toolId: tool.id }] },
      mockContext,
    );

    // Second assignment should be a duplicate
    const result = await executeArchestraTool(
      AGENTS_TOOL,
      { assignments: [{ agentId: agent.id, toolId: tool.id }] },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.duplicates.length).toBe(1);
    expect(parsed.succeeded.length).toBe(0);
  });

  test("bulk_assign_tools_to_agents enforces target agent modify permission", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const member = await makeUser();
    await makeMember(owner.id, org.id, { role: "admin" });
    await makeMember(member.id, org.id, { role: "member" });

    const protectedAgent = await makeAgent({
      name: "Protected Personal Agent",
      organizationId: org.id,
      authorId: owner.id,
      scope: "personal",
    });
    const tool = await makeTool({ name: "protected_assign_tool" });

    const memberContext: ArchestraContext = {
      agent: { id: protectedAgent.id, name: protectedAgent.name },
      userId: member.id,
      organizationId: org.id,
    };

    const result = await executeArchestraTool(
      AGENTS_TOOL,
      {
        assignments: [{ agentId: protectedAgent.id, toolId: tool.id }],
      },
      memberContext,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.failed).toEqual([
      {
        agentId: protectedAgent.id,
        toolId: tool.id,
        error: "You can only manage your own personal agents",
      },
    ]);
    expect(parsed.succeeded).toEqual([]);
  });

  test("bulk_assign_tools_to_agents preserves structured validation error metadata", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Missing Tool Agent" });

    const result = await executeArchestraTool(
      AGENTS_TOOL,
      {
        assignments: [
          {
            agentId: agent.id,
            toolId: "00000000-0000-4000-8000-000000000099",
          },
        ],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.failed).toEqual([
      {
        agentId: agent.id,
        toolId: "00000000-0000-4000-8000-000000000099",
        error: "Tool with ID 00000000-0000-4000-8000-000000000099 not found",
        errorCode: "not_found",
        errorType: "not_found",
      },
    ]);
  });
});

describe("tool assignment with late-bound resolution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    testAgent = await makeAgent({
      name: "Context Agent",
      organizationId: org.id,
    });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: user.id,
      organizationId: org.id,
    };
  });

  test("assigns remote tool with resolveAtCallTime=true", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent({ name: "Dynamic Cred Agent" });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      name: "remote_dynamic_tool",
      catalogId: catalog.id,
    });

    const result = await executeArchestraTool(
      AGENTS_TOOL,
      {
        assignments: [
          {
            agentId: agent.id,
            toolId: tool.id,
            resolveAtCallTime: true,
          },
        ],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.succeeded.length).toBe(1);
    expect(parsed.failed.length).toBe(0);

    // Verify the flag was persisted in the database
    const [agentTool] = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agent.id),
          eq(schema.agentToolsTable.toolId, tool.id),
        ),
      );
    expect(agentTool.credentialResolutionMode).toBe("dynamic");
    expect(agentTool.mcpServerId).toBeNull();
  });

  test("assigns local tool with resolveAtCallTime=true", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent({ name: "Local Dynamic Agent" });
    const catalog = await makeInternalMcpCatalog({ serverType: "local" });
    const tool = await makeTool({
      name: "local_dynamic_tool",
      catalogId: catalog.id,
    });

    const result = await executeArchestraTool(
      AGENTS_TOOL,
      {
        assignments: [
          {
            agentId: agent.id,
            toolId: tool.id,
            resolveAtCallTime: true,
          },
        ],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.succeeded.length).toBe(1);
    expect(parsed.failed.length).toBe(0);

    // Verify the flag was persisted in the database
    const [agentTool] = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agent.id),
          eq(schema.agentToolsTable.toolId, tool.id),
        ),
      );
    expect(agentTool.credentialResolutionMode).toBe("dynamic");
    expect(agentTool.mcpServerId).toBeNull();
  });

  test("remote tool without credential source or late-bound resolution fails", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent({ name: "No Cred Agent" });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      name: "remote_no_cred_tool",
      catalogId: catalog.id,
    });

    const result = await executeArchestraTool(
      AGENTS_TOOL,
      {
        assignments: [{ agentId: agent.id, toolId: tool.id }],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.failed.length).toBe(1);
    expect(parsed.failed[0].error).toContain(
      "An MCP server installation or non-static credential resolution is required for remote MCP server tools",
    );
  });

  test("local tool without execution source or late-bound resolution fails", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent({ name: "No Exec Agent" });
    const catalog = await makeInternalMcpCatalog({ serverType: "local" });
    const tool = await makeTool({
      name: "local_no_exec_tool",
      catalogId: catalog.id,
    });

    const result = await executeArchestraTool(
      AGENTS_TOOL,
      {
        assignments: [{ agentId: agent.id, toolId: tool.id }],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.failed.length).toBe(1);
    expect(parsed.failed[0].error).toContain(
      "An MCP server installation or non-static credential resolution is required for local MCP server tools",
    );
  });

  test("assigns to MCP gateway with resolveAtCallTime=true", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    // MCP gateways are agents internally — the gateway tool uses mcpGatewayId which maps to agentId
    const gateway = await makeAgent({ name: "Dynamic Cred Gateway" });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      name: "gateway_dynamic_tool",
      catalogId: catalog.id,
    });

    const result = await executeArchestraTool(
      GATEWAYS_TOOL,
      {
        assignments: [
          {
            mcpGatewayId: gateway.id,
            toolId: tool.id,
            resolveAtCallTime: true,
          },
        ],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.succeeded.length).toBe(1);
    expect(parsed.failed.length).toBe(0);

    // Verify the flag was persisted
    const [agentTool] = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, gateway.id),
          eq(schema.agentToolsTable.toolId, tool.id),
        ),
      );
    expect(agentTool.credentialResolutionMode).toBe("dynamic");
  });

  test("reassigning with resolveAtCallTime updates existing assignment", async ({
    makeAgent,
    makeTool,
  }) => {
    const agent = await makeAgent({ name: "Update Cred Agent" });
    // Tool without catalogId so no credential/execution source is required
    const tool = await makeTool({ name: "update_cred_tool" });

    // First assignment without dynamic credential
    const firstResult = await executeArchestraTool(
      AGENTS_TOOL,
      {
        assignments: [{ agentId: agent.id, toolId: tool.id }],
      },
      mockContext,
    );
    expect(firstResult.isError).toBe(false);
    const firstParsed = JSON.parse((firstResult.content[0] as any).text);
    expect(firstParsed.succeeded.length).toBe(1);

    // Verify initial state
    const [initial] = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agent.id),
          eq(schema.agentToolsTable.toolId, tool.id),
        ),
      );
    expect(initial.credentialResolutionMode).toBe("static");

    // Reassign with late-bound resolution
    const result = await executeArchestraTool(
      AGENTS_TOOL,
      {
        assignments: [
          {
            agentId: agent.id,
            toolId: tool.id,
            resolveAtCallTime: true,
          },
        ],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.succeeded.length).toBe(1);

    // Verify the update persisted
    const [updated] = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agent.id),
          eq(schema.agentToolsTable.toolId, tool.id),
        ),
      );
    expect(updated.credentialResolutionMode).toBe("dynamic");
  });
});
