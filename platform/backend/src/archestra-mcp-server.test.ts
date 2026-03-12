// biome-ignore-all lint/suspicious/noExplicitAny: test...
import {
  ARCHESTRA_MCP_SERVER_NAME,
  isArchestraMcpServerTool,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { AgentModel, InternalMcpCatalogModel } from "@/models";
import { beforeEach, describe, expect, test, vi } from "@/test";
import type { Agent } from "@/types";
import {
  type ArchestraContext,
  executeArchestraTool,
  getArchestraMcpTools,
} from "./archestra-mcp-server";

describe("getArchestraMcpTools", () => {
  test("should return an array of tools with required properties", () => {
    const tools = getArchestraMcpTools();

    // Verify we have tools available (don't hardcode count as it changes)
    expect(tools.length).toBeGreaterThan(0);

    // Verify all tools have required properties
    for (const tool of tools) {
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("title");
      expect(tool).toHaveProperty("description");
      expect(tool).toHaveProperty("inputSchema");
    }
  });

  test("should have correctly formatted tool names with separator", () => {
    const tools = getArchestraMcpTools();

    for (const tool of tools) {
      expect(tool.name).toContain(MCP_SERVER_TOOL_NAME_SEPARATOR);
    }
  });

  test("should have whoami tool", () => {
    const tools = getArchestraMcpTools();
    const whoamiTool = tools.find((t) => t.name.endsWith("whoami"));

    expect(whoamiTool).toBeDefined();
    expect(whoamiTool?.title).toBe("Who Am I");
  });

  test("should have search_private_mcp_registry tool", () => {
    const tools = getArchestraMcpTools();
    const searchTool = tools.find((t) =>
      t.name.endsWith("search_private_mcp_registry"),
    );

    expect(searchTool).toBeDefined();
    expect(searchTool?.title).toBe("Search Private MCP Registry");
  });

  test("should have create_agent tool", () => {
    const tools = getArchestraMcpTools();
    const tool = tools.find((t) => t.name.endsWith("create_agent"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Create Agent");
  });

  test("should have create_llm_proxy tool", () => {
    const tools = getArchestraMcpTools();
    const tool = tools.find((t) => t.name.endsWith("create_llm_proxy"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Create LLM Proxy");
  });

  test("should have create_mcp_gateway tool", () => {
    const tools = getArchestraMcpTools();
    const tool = tools.find((t) => t.name.endsWith("create_mcp_gateway"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Create MCP Gateway");
  });

  test("should have create_limit tool", () => {
    const tools = getArchestraMcpTools();
    const tool = tools.find((t) => t.name.endsWith("create_limit"));

    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Create Limit");
  });

  test("should have get_limits tool", () => {
    const tools = getArchestraMcpTools();
    const tool = tools.find((t) => t.name.endsWith("get_limits"));

    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Get Limits");
  });

  test("should have update_limit tool", () => {
    const tools = getArchestraMcpTools();
    const tool = tools.find((t) => t.name.endsWith("update_limit"));

    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Update Limit");
  });

  test("should have delete_limit tool", () => {
    const tools = getArchestraMcpTools();
    const tool = tools.find((t) => t.name.endsWith("delete_limit"));

    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Delete Limit");
  });

  test("should have get_agent_token_usage tool", () => {
    const tools = getArchestraMcpTools();
    const tool = tools.find((t) => t.name.endsWith("get_agent_token_usage"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Get Agent Token Usage");
  });

  test("should have get_llm_proxy_token_usage tool", () => {
    const tools = getArchestraMcpTools();
    const tool = tools.find((t) =>
      t.name.endsWith("get_llm_proxy_token_usage"),
    );
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Get LLM Proxy Token Usage");
  });

  test("should have swap_agent tool", () => {
    const tools = getArchestraMcpTools();
    const tool = tools.find((t) => t.name.endsWith("swap_agent"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Swap Agent");
    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "The name of the agent to switch to.",
        },
      },
      required: ["agent_name"],
    });
  });

  test("should have query_knowledge_sources tool", () => {
    const tools = getArchestraMcpTools();
    const tool = tools.find((t) => t.name.endsWith("query_knowledge_sources"));

    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Query Knowledge Sources");
    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "A natural language query about the content you are looking for. Ask about topics, concepts, or information rather than about source systems.",
        },
      },
      required: ["query"],
    });
  });
});

describe("executeArchestraTool", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent }) => {
    testAgent = await makeAgent({ name: "Test Agent" });
    mockContext = {
      agent: {
        id: testAgent.id,
        name: testAgent.name,
      },
    };
  });

  describe("whoami tool", () => {
    test("should return agent information", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}whoami`,
        undefined,
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toHaveProperty("type", "text");
      expect((result.content[0] as any).text).toContain("Agent Name:");
      expect((result.content[0] as any).text).toContain("Test Agent");
      expect((result.content[0] as any).text).toContain("Agent ID:");
      expect((result.content[0] as any).text).toContain(testAgent.id);
    });
  });

  describe("search_private_mcp_registry tool", () => {
    test("should return all catalog items when no query provided", async ({
      makeInternalMcpCatalog,
    }) => {
      await makeInternalMcpCatalog({
        name: "Test Server",
        version: "1.0.0",
        description: "A test server",
        serverType: "remote",
        serverUrl: "https://example.com",
        repository: "https://github.com/example/repo",
      });

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
        undefined,
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain(
        "Found 1 MCP server(s)",
      );
      expect((result.content[0] as any).text).toContain("Test Server");
    });

    test("should return empty result when no catalog items exist", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
        undefined,
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain("No MCP servers found");
    });

    test("should include Archestra catalog when seeded", async ({
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      // Seed Archestra catalog
      const agent = await makeAgent();
      await seedAndAssignArchestraTools(agent.id);

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
        undefined,
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain("Archestra");
      expect((result.content[0] as any).text).toContain("builtin");
    });

    test("should handle search with query parameter", async ({
      makeInternalMcpCatalog,
    }) => {
      await makeInternalMcpCatalog({
        name: "Test Server",
        description: "A server for testing",
        serverType: "remote",
      });

      await makeInternalMcpCatalog({
        name: "Other Server",
        description: "A different server",
        serverType: "remote",
      });

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
        { query: "Test" },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain(
        "Found 1 MCP server(s)",
      );
      expect((result.content[0] as any).text).toContain("Test Server");
      expect((result.content[0] as any).text).not.toContain("Other Server");
    });

    test("should handle errors gracefully", async () => {
      // Mock the InternalMcpCatalogModel.findAll method to throw an error
      const originalFindAll = InternalMcpCatalogModel.findAll;
      InternalMcpCatalogModel.findAll = vi
        .fn()
        .mockRejectedValue(new Error("Database error"));

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
        undefined,
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Error searching private MCP registry",
      );

      // Restore the original method
      InternalMcpCatalogModel.findAll = originalFindAll;
    });
  });

  describe("create_agent tool", () => {
    test("should create a new agent with required fields only", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
        { name: "New Test Agent" },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain(
        "Successfully created agent",
      );
      expect((result.content[0] as any).text).toContain("New Test Agent");
      expect((result.content[0] as any).text).toContain("ID:");
    });

    test("should create a new agent with all optional fields", async ({
      makeTeam,
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const organization = await makeOrganization();
      const team = await makeTeam(organization.id, user.id, {
        name: "Test Team",
      });

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
        {
          name: "Full Featured Agent",
          teams: [team.id],
          labels: [{ key: "environment", value: "production" }],
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain(
        "Successfully created agent",
      );
      expect((result.content[0] as any).text).toContain("Full Featured Agent");
      expect((result.content[0] as any).text).toContain(team.name);
    });

    test("should return error when name is missing", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
        {},
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("name is required");
    });

    test("should return error when name is empty string", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
        { name: "   " },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("name is required");
    });

    test("should handle errors gracefully", async () => {
      const originalCreate = AgentModel.create;
      AgentModel.create = vi
        .fn()
        .mockRejectedValue(new Error("Database error"));

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
        { name: "Test Agent" },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("Error creating agent");
      expect((result.content[0] as any).text).toContain("Database error");

      AgentModel.create = originalCreate;
    });
  });

  describe("create_llm_proxy tool", () => {
    test("should create a new LLM proxy", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_llm_proxy`,
        { name: "New LLM Proxy" },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain(
        "Successfully created llm proxy",
      );
      expect((result.content[0] as any).text).toContain("New LLM Proxy");
    });
  });

  describe("create_mcp_gateway tool", () => {
    test("should create a new MCP gateway", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_gateway`,
        { name: "New MCP Gateway" },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain(
        "Successfully created mcp gateway",
      );
      expect((result.content[0] as any).text).toContain("New MCP Gateway");
    });
  });

  describe("create_mcp_server_installation_request tool", () => {
    test("should return instructions for completing the dialog", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server_installation_request`,
        {
          external_catalog_id: "catalog-123",
          request_reason: "Need this server for testing",
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toMatchObject({ type: "text" });
      expect((result.content[0] as any).text).toContain(
        "A dialog for adding or requesting an MCP",
      );
    });
  });

  describe("create_limit tool", () => {
    test("should create a token_cost limit", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
        {
          entity_type: "agent",
          entity_id: testAgent.id,
          limit_type: "token_cost",
          limit_value: 1000000,
          model: ["claude-3-5-sonnet-20241022"],
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain(
        "Successfully created limit",
      );
      expect((result.content[0] as any).text).toContain("Limit ID:");
      expect((result.content[0] as any).text).toContain("token_cost");
    });

    test("should return error when required fields are missing", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
        {
          entity_type: "agent",
        },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("required fields");
    });

    test("should return error when model is missing for token_cost limit", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
        {
          entity_type: "agent",
          entity_id: testAgent.id,
          limit_type: "token_cost",
          limit_value: 1000000,
        },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("model is required");
    });
  });

  describe("get_limits tool", () => {
    test("should return all limits", async () => {
      // Create a limit first
      await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
        {
          entity_type: "agent",
          entity_id: testAgent.id,
          limit_type: "token_cost",
          limit_value: 1000000,
          model: ["claude-3-5-sonnet-20241022"],
        },
        mockContext,
      );

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_limits`,
        undefined,
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain("Found 1 limit(s)");
    });

    test("should filter limits by entity type", async () => {
      await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
        {
          entity_type: "agent",
          entity_id: testAgent.id,
          limit_type: "token_cost",
          limit_value: 1000000,
          model: ["claude-3-5-sonnet-20241022"],
        },
        mockContext,
      );

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_limits`,
        { entity_type: "agent" },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain("Found 1 limit(s)");
    });

    test("should return message when no limits found", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_limits`,
        undefined,
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain("No limits found");
    });
  });

  describe("update_limit tool", () => {
    test("should update a limit value", async () => {
      const createResult = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
        {
          entity_type: "agent",
          entity_id: testAgent.id,
          limit_type: "token_cost",
          limit_value: 1000000,
          model: ["claude-3-5-sonnet-20241022"],
        },
        mockContext,
      );

      // Extract the limit ID from the response
      const limitId = (createResult.content[0] as any).text.match(
        /Limit ID: ([a-f0-9-]+)/,
      )?.[1];

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_limit`,
        {
          id: limitId,
          limit_value: 2000000,
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain(
        "Successfully updated limit",
      );
      expect((result.content[0] as any).text).toContain("2000000");
    });

    test("should return error when id is missing", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_limit`,
        {
          limit_value: 2000000,
        },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("id is required");
    });

    test("should return error when limit not found", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_limit`,
        {
          id: "00000000-0000-0000-0000-000000000000",
          limit_value: 2000000,
        },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not found");
    });
  });

  describe("delete_limit tool", () => {
    test("should delete a limit", async () => {
      const createResult = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
        {
          entity_type: "agent",
          entity_id: testAgent.id,
          limit_type: "token_cost",
          limit_value: 1000000,
          model: ["claude-3-5-sonnet-20241022"],
        },
        mockContext,
      );

      // Extract the limit ID from the response
      const limitId = (createResult.content[0] as any).text.match(
        /Limit ID: ([a-f0-9-]+)/,
      )?.[1];

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}delete_limit`,
        {
          id: limitId,
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain(
        "Successfully deleted limit",
      );
    });

    test("should return error when id is missing", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}delete_limit`,
        {},
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("id is required");
    });

    test("should return error when limit not found", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}delete_limit`,
        {
          id: "00000000-0000-0000-0000-000000000000",
        },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not found");
    });
  });

  describe("get_agent_token_usage tool", () => {
    test("should return token usage for current agent", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_agent_token_usage`,
        undefined,
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain(
        "Token usage for agent",
      );
      expect((result.content[0] as any).text).toContain("Total Input Tokens:");
      expect((result.content[0] as any).text).toContain("Total Output Tokens:");
      expect((result.content[0] as any).text).toContain("Total Tokens:");
    });

    test("should return token usage for specified agent", async ({
      makeAgent,
    }) => {
      const otherAgent = await makeAgent({ name: "Other Agent" });

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_agent_token_usage`,
        { id: otherAgent.id },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain(
        `Token usage for agent ${otherAgent.id}`,
      );
    });
  });

  describe("get_llm_proxy_token_usage tool", () => {
    test("should return token usage for current agent context", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_llm_proxy_token_usage`,
        undefined,
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain(
        "Token usage for llm proxy",
      );
      expect((result.content[0] as any).text).toContain("Total Input Tokens:");
      expect((result.content[0] as any).text).toContain("Total Output Tokens:");
      expect((result.content[0] as any).text).toContain("Total Tokens:");
    });
  });

  describe("query_knowledge_sources tool", () => {
    const toolName = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}query_knowledge_sources`;

    test("should return error when query param is missing", async () => {
      const result = await executeArchestraTool(toolName, {}, mockContext);

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "query parameter is required",
      );
    });

    test("should return error when no knowledge base or connector is assigned", async () => {
      const result = await executeArchestraTool(
        toolName,
        { query: "test query" },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "No knowledge base or connector assigned",
      );
    });

    test("should return error when assigned knowledge base is deleted (cascade removes assignment)", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);

      // Assign KB to agent, then delete it — CASCADE removes the junction entry too
      await AgentModel.update(testAgent.id, { knowledgeBaseIds: [kb.id] });

      await db
        .delete(schema.knowledgeBasesTable)
        .where(eq(schema.knowledgeBasesTable.id, kb.id));

      const result = await executeArchestraTool(
        toolName,
        { query: "test query" },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "No knowledge base or connector assigned",
      );
    });

    test("should call query service and return results when KB is assigned", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const { queryService } = await import("@/knowledge-base/query");
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await makeKnowledgeBaseConnector(kb.id, org.id);
      await AgentModel.update(testAgent.id, { knowledgeBaseIds: [kb.id] });

      const mockResults = [
        {
          content: "Test chunk content",
          score: 0.95,
          chunkIndex: 0,
          citation: {
            title: "Test Document",
            sourceUrl: "https://example.com/doc",
            documentId: "doc-123",
            connectorType: "github",
          },
        },
      ];
      const querySpy = vi
        .spyOn(queryService, "query")
        .mockResolvedValueOnce(mockResults);

      const result = await executeArchestraTool(
        toolName,
        { query: "test query" },
        { ...mockContext, organizationId: org.id },
      );

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.totalChunks).toBe(1);
      expect(parsed.results[0].citation.title).toBe("Test Document");

      querySpy.mockRestore();
    });

    test("should return error when query service throws", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const { queryService } = await import("@/knowledge-base/query");
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      await makeKnowledgeBaseConnector(kb.id, org.id);
      await AgentModel.update(testAgent.id, { knowledgeBaseIds: [kb.id] });

      const querySpy = vi
        .spyOn(queryService, "query")
        .mockRejectedValueOnce(new Error("Embedding API unavailable"));

      const result = await executeArchestraTool(
        toolName,
        { query: "test query" },
        { ...mockContext, organizationId: org.id },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Embedding API unavailable",
      );

      querySpy.mockRestore();
    });
  });

  describe("create_tool_invocation_policy tool", () => {
    test("should create a policy with correct fields", async ({ makeTool }) => {
      const tool = await makeTool();

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_tool_invocation_policy`,
        {
          toolId: tool.id,
          conditions: [
            { key: "url", operator: "contains", value: "example.com" },
          ],
          action: "block_always",
          reason: "Test reason",
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      const policy = JSON.parse((result.content[0] as any).text);
      expect(policy.toolId).toBe(tool.id);
      expect(policy.conditions).toEqual([
        { key: "url", operator: "contains", value: "example.com" },
      ]);
      expect(policy.action).toBe("block_always");
      expect(policy.reason).toBe("Test reason");
      expect(policy.id).toBeDefined();
    });

    test("should create a policy with empty conditions", async ({
      makeTool,
    }) => {
      const tool = await makeTool();

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_tool_invocation_policy`,
        {
          toolId: tool.id,
          conditions: [],
          action: "block_when_context_is_untrusted",
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      const policy = JSON.parse((result.content[0] as any).text);
      expect(policy.toolId).toBe(tool.id);
      expect(policy.conditions).toEqual([]);
      expect(policy.action).toBe("block_when_context_is_untrusted");
    });

    test("should create a policy with allow_when_context_is_untrusted action", async ({
      makeTool,
    }) => {
      const tool = await makeTool();

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_tool_invocation_policy`,
        {
          toolId: tool.id,
          conditions: [
            { key: "context.externalAgentId", operator: "equal", value: "abc" },
          ],
          action: "allow_when_context_is_untrusted",
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      const policy = JSON.parse((result.content[0] as any).text);
      expect(policy.action).toBe("allow_when_context_is_untrusted");
    });
  });

  describe("get_tool_invocation_policy tool", () => {
    test("should retrieve a policy by id", async ({ makeTool }) => {
      const tool = await makeTool();

      const createResult = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_tool_invocation_policy`,
        {
          toolId: tool.id,
          conditions: [
            { key: "url", operator: "startsWith", value: "https://" },
          ],
          action: "block_always",
        },
        mockContext,
      );

      const created = JSON.parse((createResult.content[0] as any).text);

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_tool_invocation_policy`,
        { id: created.id },
        mockContext,
      );

      expect(result.isError).toBe(false);
      const fetched = JSON.parse((result.content[0] as any).text);
      expect(fetched.id).toBe(created.id);
      expect(fetched.toolId).toBe(tool.id);
    });

    test("should return error when id is missing", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_tool_invocation_policy`,
        {},
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "id parameter is required",
      );
    });

    test("should return error when policy not found", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_tool_invocation_policy`,
        { id: "00000000-0000-0000-0000-000000000000" },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not found");
    });
  });

  describe("update_tool_invocation_policy tool", () => {
    test("should update policy fields", async ({ makeTool }) => {
      const tool = await makeTool();

      const createResult = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_tool_invocation_policy`,
        {
          toolId: tool.id,
          conditions: [],
          action: "block_always",
          reason: "Original reason",
        },
        mockContext,
      );

      const created = JSON.parse((createResult.content[0] as any).text);

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_tool_invocation_policy`,
        {
          id: created.id,
          conditions: [{ key: "source", operator: "equal", value: "external" }],
          action: "block_when_context_is_untrusted",
          reason: "Updated reason",
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      const updated = JSON.parse((result.content[0] as any).text);
      expect(updated.id).toBe(created.id);
      expect(updated.conditions).toEqual([
        { key: "source", operator: "equal", value: "external" },
      ]);
      expect(updated.action).toBe("block_when_context_is_untrusted");
      expect(updated.reason).toBe("Updated reason");
    });

    test("should return error when id is missing", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_tool_invocation_policy`,
        { action: "block_always" },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "id parameter is required",
      );
    });

    test("should return error when policy not found", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_tool_invocation_policy`,
        {
          id: "00000000-0000-0000-0000-000000000000",
          action: "block_always",
        },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not found");
    });
  });

  describe("delete_tool_invocation_policy tool", () => {
    test("should return error when id is missing", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}delete_tool_invocation_policy`,
        {},
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "id parameter is required",
      );
    });

    test("should return error when policy not found", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}delete_tool_invocation_policy`,
        { id: "00000000-0000-0000-0000-000000000000" },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not found");
    });
  });

  describe("get_tool_invocation_policies tool", () => {
    test("should return all policies", async ({ makeTool }) => {
      const tool = await makeTool();

      await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_tool_invocation_policy`,
        {
          toolId: tool.id,
          conditions: [],
          action: "block_always",
        },
        mockContext,
      );

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_tool_invocation_policies`,
        undefined,
        mockContext,
      );

      expect(result.isError).toBe(false);
      const policies = JSON.parse((result.content[0] as any).text);
      expect(policies.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("create_trusted_data_policy tool", () => {
    test("should create a policy with correct fields", async ({ makeTool }) => {
      const tool = await makeTool();

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_trusted_data_policy`,
        {
          toolId: tool.id,
          conditions: [
            {
              key: "emails[*].from",
              operator: "contains",
              value: "@trusted.com",
            },
          ],
          action: "mark_as_trusted",
          description: "Trust emails from trusted.com",
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      const policy = JSON.parse((result.content[0] as any).text);
      expect(policy.toolId).toBe(tool.id);
      expect(policy.conditions).toEqual([
        {
          key: "emails[*].from",
          operator: "contains",
          value: "@trusted.com",
        },
      ]);
      expect(policy.action).toBe("mark_as_trusted");
      expect(policy.description).toBe("Trust emails from trusted.com");
      expect(policy.id).toBeDefined();
    });

    test("should create a policy with mark_as_untrusted action", async ({
      makeTool,
    }) => {
      const tool = await makeTool();

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_trusted_data_policy`,
        {
          toolId: tool.id,
          conditions: [],
          action: "mark_as_untrusted",
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      const policy = JSON.parse((result.content[0] as any).text);
      expect(policy.action).toBe("mark_as_untrusted");
    });

    test("should create a policy with sanitize_with_dual_llm action", async ({
      makeTool,
    }) => {
      const tool = await makeTool();

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_trusted_data_policy`,
        {
          toolId: tool.id,
          conditions: [
            { key: "source", operator: "equal", value: "untrusted" },
          ],
          action: "sanitize_with_dual_llm",
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      const policy = JSON.parse((result.content[0] as any).text);
      expect(policy.action).toBe("sanitize_with_dual_llm");
    });
  });

  describe("get_trusted_data_policy tool", () => {
    test("should retrieve a policy by id", async ({ makeTool }) => {
      const tool = await makeTool();

      const createResult = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_trusted_data_policy`,
        {
          toolId: tool.id,
          conditions: [{ key: "source", operator: "equal", value: "internal" }],
          action: "mark_as_trusted",
        },
        mockContext,
      );

      const created = JSON.parse((createResult.content[0] as any).text);

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_trusted_data_policy`,
        { id: created.id },
        mockContext,
      );

      expect(result.isError).toBe(false);
      const fetched = JSON.parse((result.content[0] as any).text);
      expect(fetched.id).toBe(created.id);
      expect(fetched.toolId).toBe(tool.id);
    });

    test("should return error when id is missing", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_trusted_data_policy`,
        {},
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "id parameter is required",
      );
    });

    test("should return error when policy not found", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_trusted_data_policy`,
        { id: "00000000-0000-0000-0000-000000000000" },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not found");
    });
  });

  describe("update_trusted_data_policy tool", () => {
    test("should update policy fields", async ({ makeTool }) => {
      const tool = await makeTool();

      const createResult = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_trusted_data_policy`,
        {
          toolId: tool.id,
          conditions: [],
          action: "mark_as_trusted",
          description: "Original description",
        },
        mockContext,
      );

      const created = JSON.parse((createResult.content[0] as any).text);

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_trusted_data_policy`,
        {
          id: created.id,
          conditions: [
            { key: "data.type", operator: "notEqual", value: "sensitive" },
          ],
          action: "sanitize_with_dual_llm",
          description: "Updated description",
        },
        mockContext,
      );

      expect(result.isError).toBe(false);
      const updated = JSON.parse((result.content[0] as any).text);
      expect(updated.id).toBe(created.id);
      expect(updated.conditions).toEqual([
        { key: "data.type", operator: "notEqual", value: "sensitive" },
      ]);
      expect(updated.action).toBe("sanitize_with_dual_llm");
      expect(updated.description).toBe("Updated description");
    });

    test("should return error when id is missing", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_trusted_data_policy`,
        { action: "block_always" },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "id parameter is required",
      );
    });

    test("should return error when policy not found", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_trusted_data_policy`,
        {
          id: "00000000-0000-0000-0000-000000000000",
          action: "block_always",
        },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not found");
    });
  });

  describe("delete_trusted_data_policy tool", () => {
    test("should return error when id is missing", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}delete_trusted_data_policy`,
        {},
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "id parameter is required",
      );
    });

    test("should return error when policy not found", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}delete_trusted_data_policy`,
        { id: "00000000-0000-0000-0000-000000000000" },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("not found");
    });
  });

  describe("get_trusted_data_policies tool", () => {
    test("should return all policies", async ({ makeTool }) => {
      const tool = await makeTool();

      await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_trusted_data_policy`,
        {
          toolId: tool.id,
          conditions: [],
          action: "block_always",
        },
        mockContext,
      );

      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_trusted_data_policies`,
        undefined,
        mockContext,
      );

      expect(result.isError).toBe(false);
      const policies = JSON.parse((result.content[0] as any).text);
      expect(policies.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("swap_agent tool", () => {
    const swapToolName = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_agent`;

    test("should return error when agent_name is missing", async () => {
      const result = await executeArchestraTool(swapToolName, {}, mockContext);

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "agent_name parameter is required",
      );
    });

    test("should return error without conversation context", async () => {
      const result = await executeArchestraTool(
        swapToolName,
        { agent_name: "Some Agent" },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("conversation context");
    });

    test("should return error when swapping to current agent", async ({
      makeUser,
      makeOrganization,
      makeAgent,
      makeTeam,
      makeConversation,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);
      const currentAgent = await makeAgent({
        name: "Current Agent",
        agentType: "agent",
        organizationId: org.id,
        teams: [team.id],
      });
      const conversation = await makeConversation(currentAgent.id, {
        userId: user.id,
        organizationId: org.id,
      });

      const result = await executeArchestraTool(
        swapToolName,
        { agent_name: "Current Agent" },
        {
          agent: { id: currentAgent.id, name: currentAgent.name },
          conversationId: conversation.id,
          userId: user.id,
          organizationId: org.id,
        },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("Already using agent");
    });

    test("should return error when agent not found", async ({
      makeUser,
      makeOrganization,
      makeConversation,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const conversation = await makeConversation(testAgent.id, {
        userId: user.id,
        organizationId: org.id,
      });

      const result = await executeArchestraTool(
        swapToolName,
        { agent_name: "Nonexistent Agent 12345" },
        {
          ...mockContext,
          conversationId: conversation.id,
          userId: user.id,
          organizationId: org.id,
        },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("No agent found");
    });

    test("should swap agent successfully", async ({
      makeUser,
      makeOrganization,
      makeAgent,
      makeTeam,
      makeConversation,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);
      const targetAgent = await makeAgent({
        name: "Target Agent",
        agentType: "agent",
        organizationId: org.id,
        teams: [team.id],
      });
      const conversation = await makeConversation(testAgent.id, {
        userId: user.id,
        organizationId: org.id,
      });

      const result = await executeArchestraTool(
        swapToolName,
        { agent_name: "Target Agent" },
        {
          ...mockContext,
          conversationId: conversation.id,
          userId: user.id,
          organizationId: org.id,
        },
      );

      expect(result.isError).toBe(false);
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.success).toBe(true);
      expect(parsed.agent_name).toBe("Target Agent");
      expect(parsed.agent_id).toBe(targetAgent.id);
    });
  });

  describe("unknown tool", () => {
    test("should throw error for unknown tool name", async () => {
      await expect(
        executeArchestraTool("unknown_tool", undefined, mockContext),
      ).rejects.toMatchObject({
        code: -32601,
        message: "Tool 'unknown_tool' not found",
      });
    });
  });
});

test("isArchestraMcpServerTool", () => {
  expect(isArchestraMcpServerTool("archestra__whoami")).toBe(true);
  expect(isArchestraMcpServerTool("archestra__create_agent")).toBe(true);
  expect(isArchestraMcpServerTool("mcp_server__tool")).toBe(false);
});
