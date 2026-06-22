// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { vi } from "vitest";
import { fastifyAuthPlugin, loopbackGateway } from "@/auth";
import { AgentModel } from "@/models";
import agentRoutes from "@/routes/agent";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { ARCHESTRA_API_DEPRECATION_NOTE } from "./helpers";

// The loopback PUT /api/agents/:id route touches Prometheus exemplar counters,
// which require an OpenMetrics registry the test process does not provide. Stub
// the metrics process boundary the same way the canonical agent route test does
// (src/routes/agent.test.ts) — the tool → loopback → route → DB path stays real.
vi.mock("@/observability", () => ({
  initializeObservabilityMetrics: vi.fn(),
  metrics: {
    llm: { initializeMetrics: vi.fn() },
    mcp: { initializeMcpMetrics: vi.fn() },
    agentExecution: { initializeAgentExecutionMetrics: vi.fn() },
  },
}));

describe("mcp gateway tool execution", () => {
  let app: FastifyInstanceWithZod;
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

    app = createFastifyInstance();
    await app.register(fastifyAuthPlugin);
    await app.register(agentRoutes);
    loopbackGateway.setServer(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
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
    // create_mcp_gateway is a deprecated platform tool, so the note is appended.
    expect((result.content.at(-1) as any).text).toContain(
      "Deprecated: prefer the archestra__api tool",
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
    expect(result.structuredContent?.status).toBe(200);

    const updated = await AgentModel.findById(
      mcpGateway.id,
      mockContext.userId,
      true,
    );
    expect(updated?.name).toBe("Updated MCP Gateway");
    expect(updated?.labels).toContainEqual(
      expect.objectContaining({ key: "env", value: "prod" }),
    );

    expect((result.content.at(-1) as any).text).toBe(
      ARCHESTRA_API_DEPRECATION_NOTE,
    );
    expect(ARCHESTRA_API_DEPRECATION_NOTE).toContain(
      "Deprecated: prefer the archestra__api tool",
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
    expect(result.structuredContent?.status).toBe(200);

    const updated = await AgentModel.findById(
      mcpGateway.id,
      mockContext.userId,
      true,
    );
    expect(updated?.knowledgeBaseIds).toEqual([replacementKnowledgeBase.id]);
    expect(updated?.connectorIds).toEqual([replacementConnector.id]);
  });

  test("edit_mcp_gateway on a non-existent id returns a 404 error result", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_mcp_gateway`,
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Does Not Matter",
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.status).toBe(404);
    expect((result.content.at(-1) as any).text).toBe(
      ARCHESTRA_API_DEPRECATION_NOTE,
    );
  });

  test("edit_mcp_gateway refuses to edit a non-gateway agent", async ({
    makeAgent,
  }) => {
    const organizationId = mockContext.organizationId;
    if (!organizationId) {
      throw new Error("Expected organizationId in test context");
    }

    const proxy = await makeAgent({
      name: "A Proxy",
      agentType: "llm_proxy",
      organizationId,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_mcp_gateway`,
      { id: proxy.id, name: "Should Not Apply" },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("not a mcp gateway");

    const unchanged = await AgentModel.findById(
      proxy.id,
      mockContext.userId,
      true,
    );
    expect(unchanged?.name).toBe("A Proxy");
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
