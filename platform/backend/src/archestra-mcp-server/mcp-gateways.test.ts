// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { AgentModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

describe("mcp gateway tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });
    testAgent = await makeAgent({
      name: "Test Agent",
      organizationId: organization.id,
    });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: user.id,
      organizationId: organization.id,
    };
  });

  test("create_mcp_gateway creates a gateway successfully", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_gateway`,
      { name: "Test MCP Gateway" },
      mockContext,
    );

    expect(result.isError).toBe(false);
    const created = await AgentModel.findById(
      extractCreatedId(result),
      mockContext.userId,
      true,
    );
    expect(created?.accessAllTools).toBe(false);
    expect(created?.toolExposureMode).toBe("search_and_run_only");

    expect((result.content[0] as any).text).toContain(
      "Successfully created mcp gateway",
    );
    // A gateway's edit page lives under /mcp/gateways — the agents list cannot
    // open one.
    expect((result.content[0] as any).text).toContain(
      `/mcp/gateways/${extractCreatedId(result)}/edit`,
    );
  });

  test("create_mcp_gateway attributes the calling user as author", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_gateway`,
      { name: "Attributed Gateway" },
      mockContext,
    );

    expect(result.isError).toBe(false);

    const created = await AgentModel.findById(
      extractCreatedId(result),
      mockContext.userId,
      true,
    );
    expect(created?.authorId).toBe(mockContext.userId);
  });

  test("create_mcp_gateway assigns knowledge bases and connectors", async ({
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const organizationId = mockContext.organizationId;
    if (!organizationId) {
      throw new Error("Expected organizationId in test context");
    }

    const knowledgeBase = await makeKnowledgeBase(organizationId);
    const connector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      organizationId,
    );

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_gateway`,
      {
        name: "Gateway With Knowledge",
        knowledgeBaseIds: [knowledgeBase.id],
        connectorIds: [connector.id],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);

    const createdGatewayId = extractCreatedId(result);
    const created = await AgentModel.findById(
      createdGatewayId,
      mockContext.userId,
      true,
    );

    expect(created).toBeTruthy();
    expect(created?.agentType).toBe("mcp_gateway");
    expect(created?.knowledgeBaseIds).toEqual([knowledgeBase.id]);
    expect(created?.connectorIds).toEqual([connector.id]);
  });

  test.for([
    false,
    true,
  ])("edit_mcp_gateway sets dynamic tool and delegation access to %s", async (enabled, {
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      name: "Gateway Access Settings",
      agentType: "mcp_gateway",
      organizationId: mockContext.organizationId,
      accessAllTools: !enabled,
      accessAllSubagents: !enabled,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_mcp_gateway`,
      {
        id: gateway.id,
        accessAllTools: enabled,
        accessAllSubagents: enabled,
      },
      mockContext,
    );

    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    const updated = await AgentModel.findById(
      gateway.id,
      mockContext.userId,
      true,
    );
    expect(updated?.accessAllTools).toBe(enabled);
    expect(updated?.accessAllSubagents).toBe(enabled);
    expect(updated?.name).toBe("Gateway Access Settings");
  });

  test("edit_mcp_gateway updates an mcp gateway successfully", async ({
    makeAgent,
  }) => {
    const organizationId = mockContext.organizationId;
    if (!organizationId) {
      throw new Error("Expected organizationId in test context");
    }

    const mcpGateway = await makeAgent({
      name: "Original MCP Gateway",
      agentType: "mcp_gateway",
      organizationId,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_mcp_gateway`,
      {
        id: mcpGateway.id,
        name: "Updated MCP Gateway",
        labels: [{ key: "env", value: "prod" }],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully updated mcp gateway",
    );
    expect((result.content[0] as any).text).toContain(
      `/mcp/gateways/${mcpGateway.id}/edit`,
    );

    const updated = await AgentModel.findById(
      mcpGateway.id,
      mockContext.userId,
      true,
    );
    expect(updated?.name).toBe("Updated MCP Gateway");
    expect(updated?.labels).toContainEqual(
      expect.objectContaining({ key: "env", value: "prod" }),
    );
  });

  test("edit_mcp_gateway replaces assigned knowledge bases and connectors", async ({
    makeAgent,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const organizationId = mockContext.organizationId;
    if (!organizationId) {
      throw new Error("Expected organizationId in test context");
    }

    const existingKnowledgeBase = await makeKnowledgeBase(organizationId);
    const existingConnector = await makeKnowledgeBaseConnector(
      existingKnowledgeBase.id,
      organizationId,
    );
    const mcpGateway = await makeAgent({
      name: "Knowledge MCP Gateway",
      agentType: "mcp_gateway",
      organizationId,
      knowledgeBaseIds: [existingKnowledgeBase.id],
      connectorIds: [existingConnector.id],
    });

    const replacementKnowledgeBase = await makeKnowledgeBase(organizationId);
    const replacementConnector = await makeKnowledgeBaseConnector(
      replacementKnowledgeBase.id,
      organizationId,
    );

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_mcp_gateway`,
      {
        id: mcpGateway.id,
        knowledgeBaseIds: [replacementKnowledgeBase.id],
        connectorIds: [replacementConnector.id],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully updated mcp gateway",
    );

    const updated = await AgentModel.findById(
      mcpGateway.id,
      mockContext.userId,
      true,
    );
    expect(updated?.knowledgeBaseIds).toEqual([replacementKnowledgeBase.id]);
    expect(updated?.connectorIds).toEqual([replacementConnector.id]);
  });

  test("create_mcp_gateway and edit_mcp_gateway configure subagent delegations", async ({
    makeAgent,
  }) => {
    const organizationId = mockContext.organizationId;
    if (!organizationId) {
      throw new Error("Expected organizationId in test context");
    }

    const reviewAgent1 = await makeAgent({
      name: "Review Agent 1",
      agentType: "agent",
      organizationId,
    });
    const reviewAgent2 = await makeAgent({
      name: "Review Agent 2",
      agentType: "agent",
      organizationId,
    });

    const createResult = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_gateway`,
      {
        name: "Code Review Gateway",
        accessAllSubagents: false,
        subAgentIds: [reviewAgent1.id],
      },
      mockContext,
    );

    expect(createResult.isError).toBe(false);
    const gatewayId = extractCreatedId(createResult);
    const created = await AgentModel.findById(
      gatewayId,
      mockContext.userId,
      true,
    );
    expect(created?.accessAllSubagents).toBe(false);
    expect(
      created?.tools
        .map((t) => t.delegateToAgentId)
        .filter((id): id is string => Boolean(id)),
    ).toEqual([reviewAgent1.id]);

    const editResult = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_mcp_gateway`,
      {
        id: gatewayId,
        accessAllSubagents: false,
        subAgentIds: [reviewAgent2.id],
      },
      mockContext,
    );
    expect(editResult.isError).toBe(false);
    const updated = await AgentModel.findById(
      gatewayId,
      mockContext.userId,
      true,
    );
    expect(
      updated?.tools
        .map((t) => t.delegateToAgentId)
        .filter((id): id is string => Boolean(id)),
    ).toEqual(expect.arrayContaining([reviewAgent1.id, reviewAgent2.id]));
  });
});

function extractCreatedId(
  result: Awaited<ReturnType<typeof executeArchestraTool>>,
) {
  const createdId = ((result.content[0] as any).text as string)
    .split("\n")
    .find((line) => line.startsWith("ID: "))
    ?.replace("ID: ", "");

  if (!createdId) {
    throw new Error("Expected created resource id in tool output");
  }

  return createdId;
}
