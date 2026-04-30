import db, { schema } from "@/database";
import { AgentModel } from "@/models";
import { describe, expect, test } from "@/test";
import { serializeAgentForExport } from "./agent-export";

describe("serializeAgentForExport", () => {
  test("serializes a basic agent without associations correctly", async ({
    makeAgent,
    makeUser,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent({
      name: "Basic Export Agent",
      authorId: user.id,
      systemPrompt: "You are a helpful assistant",
      scope: "personal",
    });

    const fullAgent = await AgentModel.findById(agent.id, user.id, true);
    expect(fullAgent).not.toBeNull();
    if (!fullAgent) throw new Error("fullAgent should not be null");

    const serialized = await serializeAgentForExport(fullAgent);

    expect(serialized.version).toBe("1");
    expect(serialized.agent.name).toBe("Basic Export Agent");
    expect(serialized.agent.agentType).toBe("agent");
    expect(serialized.agent.systemPrompt).toBe("You are a helpful assistant");
    expect(serialized.agent.scope).toBe("personal");
    expect(serialized.tools).toEqual([]);
    expect(serialized.knowledgeBases).toEqual([]);
    expect(serialized.connectors).toEqual([]);
    expect(serialized.delegations).toEqual([]);
  });

  test("serializes an agent with tools, knowledge bases, and connectors", async ({
    makeAgent,
    makeUser,
    makeTool,
    makeInternalMcpCatalog,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    // Create dependencies
    const catalog = await makeInternalMcpCatalog({ name: "Jira Catalog" });
    const tool = await makeTool({
      name: "jira_get_issue",
      catalogId: catalog.id,
    });
    const kb = await makeKnowledgeBase(org.id, { name: "Company Wiki" });
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      name: "Confluence",
      connectorType: "confluence",
    });

    // Create target agent for delegation
    const targetAgent = await makeAgent({
      name: "Database Expert",
      organizationId: org.id,
      authorId: user.id,
    });

    // Create the delegation tool manually, since makeTool doesn't support delegateToAgentId in its override type
    const [delegationTool] = await db
      .insert(schema.toolsTable)
      .values({
        name: "ask_database_expert",
        delegateToAgentId: targetAgent.id,
      })
      .returning();

    // Create an agent that uses the KB and connector (exercises association paths)
    await makeAgent({
      name: "Support Agent",
      organizationId: org.id,
      authorId: user.id,
      knowledgeBaseIds: [kb.id],
      connectorIds: [connector.id],
    });

    // We can use seedAndAssignArchestraTools to add tools if we want, or do it manually,
    // but the simplest is just AgentModel.create handles associations.
    // Let's create an agent with full associations via AgentModel.create since that's the real flow
    const createdFullAgent = await makeAgent({
      name: "Complex Support Agent",
      agentType: "agent",
      organizationId: org.id,
      authorId: user.id,
      scope: "personal",
      knowledgeBaseIds: [kb.id],
      connectorIds: [connector.id],
      teams: [],
      labels: [{ key: "env", value: "prod" }],
    });

    await db.insert(schema.agentToolsTable).values([
      {
        agentId: createdFullAgent.id,
        toolId: tool.id,
        credentialResolutionMode: "dynamic" as const,
      },
      {
        agentId: createdFullAgent.id,
        toolId: delegationTool.id,
        credentialResolutionMode: "static" as const,
      },
    ]);

    const fullAgent = await AgentModel.findById(
      createdFullAgent.id,
      user.id,
      true,
    );
    expect(fullAgent).not.toBeNull();
    if (!fullAgent) throw new Error("fullAgent should not be null");

    const serialized = await serializeAgentForExport(fullAgent);

    // Verify Agent fields
    expect(serialized.agent.name).toBe("Complex Support Agent");

    // Verify Labels
    expect(serialized.labels).toEqual([{ key: "env", value: "prod" }]);

    // Verify Tools (should resolve the catalog name "Jira Catalog")
    expect(serialized.tools).toHaveLength(1);
    expect(serialized.tools[0].toolName).toBe("jira_get_issue");
    expect(serialized.tools[0].catalogName).toBe("Jira Catalog");
    expect(serialized.tools[0].credentialResolutionMode).toBe("dynamic");

    // Verify Delegations (should resolve the target agent name "Database Expert")
    expect(serialized.delegations).toHaveLength(1);
    expect(serialized.delegations[0].targetAgentName).toBe("Database Expert");

    // Verify Knowledge Bases
    expect(serialized.knowledgeBases).toHaveLength(1);
    expect(serialized.knowledgeBases[0].name).toBe("Company Wiki");

    // Verify Connectors
    expect(serialized.connectors).toHaveLength(1);
    expect(serialized.connectors[0].name).toBe("Confluence");
    expect(serialized.connectors[0].connectorType).toBe("confluence");
  });
});
