// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { EnvironmentModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const AGENTS_TOOL = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}bulk_assign_tools_to_agents`;
const GATEWAYS_TOOL = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}bulk_assign_tools_to_mcp_gateways`;
const REMOVE_TOOL = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}bulk_remove_tools_from_agents`;

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

  test("binding a personal connection fails with a validation entry", async ({
    makeAgent,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const org = await makeOrganization();
    // Editors hold agent/tool management permissions, so credential scope is
    // the only thing blocking this assignment.
    const editor = await makeUser();
    await makeMember(editor.id, org.id, { role: "editor" });
    const colleague = await makeUser();
    await makeMember(colleague.id, org.id, { role: "member" });

    // The editor's own personal agent, so every agent-modify check passes and
    // the credential gate is the only thing the assignment can trip on.
    const agent = await makeAgent({
      name: "Editor Agent",
      organizationId: org.id,
      scope: "personal",
      authorId: editor.id,
    });
    const tool = await makeTool({ name: "forbidden-test-tool" });
    const theirConnection = await makeMcpServer({
      scope: "personal",
      ownerId: colleague.id,
      serverType: "remote",
    });

    const result = await executeArchestraTool(
      AGENTS_TOOL,
      {
        assignments: [
          {
            agentId: agent.id,
            toolId: tool.id,
            mcpServerId: theirConnection.id,
          },
        ],
      },
      {
        agent: { id: agent.id, name: agent.name },
        userId: editor.id,
        organizationId: org.id,
      },
    );

    // isError false means the structured failure passed output validation.
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.failed).toMatchObject([
      {
        agentId: agent.id,
        toolId: tool.id,
        errorCode: "validation_error",
        errorType: "validation_error",
      },
    ]);
    expect(parsed.failed[0].error).toContain("dynamic credential resolution");
  });
});

describe("bulk_remove_tools_from_agents tool execution", () => {
  let orgId: string;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    orgId = org.id;
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const ctxAgent = await makeAgent({
      name: "Ctx Agent",
      organizationId: org.id,
    });
    mockContext = {
      agent: { id: ctxAgent.id, name: ctxAgent.name },
      userId: user.id,
      organizationId: org.id,
    };
  });

  test("removes an assigned tool from a Custom-mode agent (deletes the junction row)", async ({
    makeAgent,
    makeAgentTool,
    makeTool,
  }) => {
    const agent = await makeAgent({
      name: "Custom Agent",
      organizationId: orgId,
      accessAllTools: false,
    });
    const tool = await makeTool({ name: "remove_me" });
    await makeAgentTool(agent.id, tool.id);

    const result = await executeArchestraTool(
      REMOVE_TOOL,
      { removals: [{ agentId: agent.id, toolId: tool.id }] },
      mockContext,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.succeeded).toEqual([{ agentId: agent.id, toolId: tool.id }]);
  });

  test("reports notAssigned when the tool was not assigned (Custom mode)", async ({
    makeAgent,
    makeTool,
  }) => {
    const agent = await makeAgent({
      name: "Empty Agent",
      organizationId: orgId,
      accessAllTools: false,
    });
    const tool = await makeTool({ name: "never_assigned" });

    const result = await executeArchestraTool(
      REMOVE_TOOL,
      { removals: [{ agentId: agent.id, toolId: tool.id }] },
      mockContext,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.notAssigned).toEqual([
      { agentId: agent.id, toolId: tool.id },
    ]);
    expect(parsed.succeeded).toEqual([]);
  });

  test("excludes the tool for an Auto-tool (accessAllTools) agent instead of deleting", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent({
      name: "Auto Agent",
      organizationId: orgId,
      accessAllTools: true,
    });
    const catalog = await makeInternalMcpCatalog({ organizationId: orgId });
    const tool = await makeTool({
      name: "github__excluded",
      catalogId: catalog.id,
    });

    const result = await executeArchestraTool(
      REMOVE_TOOL,
      { removals: [{ agentId: agent.id, toolId: tool.id }] },
      mockContext,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.succeeded).toEqual([{ agentId: agent.id, toolId: tool.id }]);

    const exclusions = await db
      .select()
      .from(schema.agentExcludedToolsTable)
      .where(
        and(
          eq(schema.agentExcludedToolsTable.agentId, agent.id),
          eq(schema.agentExcludedToolsTable.toolId, tool.id),
        ),
      );
    expect(exclusions).toHaveLength(1);
  });

  test("enforces target agent modify permission", async ({
    makeAgent,
    makeMember,
    makeTool,
    makeUser,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, orgId, { role: "member" });
    const owner = await makeUser();
    await makeMember(owner.id, orgId, { role: "admin" });
    const protectedAgent = await makeAgent({
      name: "Protected Personal Agent",
      organizationId: orgId,
      authorId: owner.id,
      scope: "personal",
    });
    const tool = await makeTool({ name: "protected_remove_tool" });

    const memberContext: ArchestraContext = {
      agent: mockContext.agent,
      userId: member.id,
      organizationId: orgId,
    };

    const result = await executeArchestraTool(
      REMOVE_TOOL,
      { removals: [{ agentId: protectedAgent.id, toolId: tool.id }] },
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

/**
 * Environment isolation on the assignment writes: assigning or removing a tool
 * is a configuration change on the target, so it must stay inside the calling
 * agent's environment. Otherwise an agent in one environment rewrites another
 * environment's toolset — and unlike a cross-environment tool, that assignment
 * is fully effective, because the target and the tool then agree.
 */
describe("tool assignment respects the agent's environment", () => {
  let orgId: string;
  let userId: string;
  let stagingEnvId: string;
  let prodEnvId: string;
  let stagingContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    orgId = org.id;
    const user = await makeUser();
    userId = user.id;
    await makeMember(user.id, org.id, { role: "admin" });

    const staging = await EnvironmentModel.create({
      organizationId: org.id,
      name: "staging",
    });
    const prod = await EnvironmentModel.create({
      organizationId: org.id,
      name: "production",
    });
    stagingEnvId = staging.id;
    prodEnvId = prod.id;

    const caller = await makeAgent({
      name: "Staging Caller",
      organizationId: org.id,
      environmentId: staging.id,
    });
    stagingContext = {
      agent: { id: caller.id, name: caller.name },
      userId: user.id,
      organizationId: org.id,
    };
  });

  test("bulk_assign_tools_to_agents refuses a target in another environment", async ({
    makeAgent,
    makeTool,
  }) => {
    const prodAgent = await makeAgent({
      name: "Production Target",
      organizationId: orgId,
      environmentId: prodEnvId,
    });
    const tool = await makeTool({ name: "prod_target_tool" });

    const result = await executeArchestraTool(
      AGENTS_TOOL,
      { assignments: [{ agentId: prodAgent.id, toolId: tool.id }] },
      stagingContext,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.succeeded).toEqual([]);
    expect(parsed.failed[0].error).toContain("different environment");

    // The write must not have landed.
    const rows = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, prodAgent.id),
          eq(schema.agentToolsTable.toolId, tool.id),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  test("bulk_assign_tools_to_agents allows a target in the same environment", async ({
    makeAgent,
    makeTool,
  }) => {
    const peer = await makeAgent({
      name: "Staging Peer",
      organizationId: orgId,
      environmentId: stagingEnvId,
    });
    const tool = await makeTool({ name: "staging_peer_tool" });

    const result = await executeArchestraTool(
      AGENTS_TOOL,
      { assignments: [{ agentId: peer.id, toolId: tool.id }] },
      stagingContext,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.failed).toEqual([]);
    expect(parsed.succeeded).toEqual([{ agentId: peer.id, toolId: tool.id }]);
  });

  test("bulk_remove_tools_from_agents refuses a target in another environment", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const prodAgent = await makeAgent({
      name: "Production Removal Target",
      organizationId: orgId,
      environmentId: prodEnvId,
    });
    const tool = await makeTool({ name: "prod_removal_tool" });
    await makeAgentTool(prodAgent.id, tool.id);

    const result = await executeArchestraTool(
      REMOVE_TOOL,
      { removals: [{ agentId: prodAgent.id, toolId: tool.id }] },
      stagingContext,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.succeeded).toEqual([]);
    expect(parsed.failed[0].error).toContain("different environment");

    // The existing assignment must survive.
    const rows = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, prodAgent.id),
          eq(schema.agentToolsTable.toolId, tool.id),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  test("bulk_assign_tools_to_mcp_gateways refuses a gateway in another environment", async ({
    makeAgent,
    makeTool,
  }) => {
    const prodGateway = await makeAgent({
      name: "Production Gateway",
      organizationId: orgId,
      environmentId: prodEnvId,
      agentType: "mcp_gateway",
    });
    const tool = await makeTool({ name: "prod_gateway_tool" });

    const result = await executeArchestraTool(
      GATEWAYS_TOOL,
      { assignments: [{ mcpGatewayId: prodGateway.id, toolId: tool.id }] },
      stagingContext,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.succeeded).toEqual([]);
    expect(parsed.failed[0].error).toContain("different environment");
  });

  test("a Default-environment agent cannot assign into a named environment", async ({
    makeAgent,
    makeTool,
  }) => {
    const defaultAgent = await makeAgent({
      name: "Default Caller",
      organizationId: orgId,
      environmentId: null,
    });
    const prodAgent = await makeAgent({
      name: "Production Peer",
      organizationId: orgId,
      environmentId: prodEnvId,
    });
    const tool = await makeTool({ name: "default_caller_tool" });

    const result = await executeArchestraTool(
      AGENTS_TOOL,
      { assignments: [{ agentId: prodAgent.id, toolId: tool.id }] },
      {
        agent: { id: defaultAgent.id, name: defaultAgent.name },
        userId,
        organizationId: orgId,
      },
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.succeeded).toEqual([]);
    expect(parsed.failed[0].error).toContain("different environment");
  });
});
