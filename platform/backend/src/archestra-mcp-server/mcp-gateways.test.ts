// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
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
    expect((result.content[0] as any).text).toContain(
      "Successfully created mcp gateway",
    );
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
