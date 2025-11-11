// biome-ignore-all lint/suspicious/noExplicitAny: test...
import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { InternalMcpCatalogModel } from "@/models";
import { beforeEach, describe, expect, test, vi } from "@/test";
import type { Agent } from "@/types";
import {
  type ArchestraContext,
  executeArchestraTool,
  getArchestraMcpTools,
  MCP_SERVER_NAME,
} from "./archestra-mcp-server";

describe("getArchestraMcpTools", () => {
  test("should return an array of 8 tools", () => {
    const tools = getArchestraMcpTools();

    expect(tools).toHaveLength(8);
    expect(tools[0]).toHaveProperty("name");
    expect(tools[0]).toHaveProperty("title");
    expect(tools[0]).toHaveProperty("description");
    expect(tools[0]).toHaveProperty("inputSchema");
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
    const createAgentTool = tools.find((t) => t.name.endsWith("create_agent"));

    expect(createAgentTool).toBeDefined();
    expect(createAgentTool?.title).toBe("Create Agent");
  });

  test("should not have create_mcp_server_installation_request tool (disabled)", () => {
    const tools = getArchestraMcpTools();
    const createTool = tools.find((t) =>
      t.name.endsWith("create_mcp_server_installation_request"),
    );

    expect(createTool).toBeUndefined();
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
});

describe("executeArchestraTool", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent }) => {
    testAgent = await makeAgent({ name: "Test Agent" });
    mockContext = {
      agent: testAgent,
    };
  });

  describe("whoami tool", () => {
    test("should return agent information", async () => {
      const result = await executeArchestraTool(
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}whoami`,
        undefined,
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toHaveProperty("type", "text");
      expect((result.content[0] as any).text).toContain("Test Agent");
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
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
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

    test("should return empty message when no items found", async () => {
      // No items created, so search should return empty
      const result = await executeArchestraTool(
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
        undefined,
        mockContext,
      );

      expect(result.isError).toBe(false);

      expect((result.content[0] as any).text).toContain("No MCP servers found");
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
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
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
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
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
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
        { name: "New Test Agent" },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain(
        "Successfully created agent",
      );
      expect((result.content[0] as any).text).toContain("New Test Agent");
      expect((result.content[0] as any).text).toContain("Agent ID:");
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
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
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
      expect((result.content[0] as any).text).toContain(team.id);
    });

    test("should return error when name is missing", async () => {
      const result = await executeArchestraTool(
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
        {},
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Agent name is required",
      );
    });

    test("should return error when name is empty string", async () => {
      const result = await executeArchestraTool(
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
        { name: "   " },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Agent name is required",
      );
    });

    test("should handle errors gracefully", async () => {
      // Mock the AgentModel.create method to throw an error
      const { AgentModel } = await import("@/models");
      const originalCreate = AgentModel.create;
      AgentModel.create = vi
        .fn()
        .mockRejectedValue(new Error("Database error"));

      const result = await executeArchestraTool(
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
        { name: "Test Agent" },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("Error creating agent");
      expect((result.content[0] as any).text).toContain("Database error");

      // Restore the original method
      AgentModel.create = originalCreate;
    });
  });

  // MCP server installation request tool is temporarily disabled
  describe("create_mcp_server_installation_request tool (disabled)", () => {
    test("should throw error for disabled tool", async () => {
      await expect(
        executeArchestraTool(
          `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server_installation_request`,
          {
            external_catalog_id: "catalog-123",
            request_reason: "Need this server for testing",
          },
          mockContext,
        ),
      ).rejects.toMatchObject({
        code: -32601,
        message: `Tool '${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server_installation_request' not found`,
      });
    });
  });

  describe("create_limit tool", () => {
    test("should create a token_cost limit", async () => {
      const result = await executeArchestraTool(
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
        {
          entity_type: "agent",
          entity_id: testAgent.id,
          limit_type: "token_cost",
          limit_value: 1000000,
          model: "claude-3-5-sonnet-20241022",
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
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
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
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
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
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
        {
          entity_type: "agent",
          entity_id: testAgent.id,
          limit_type: "token_cost",
          limit_value: 1000000,
          model: "claude-3-5-sonnet-20241022",
        },
        mockContext,
      );

      const result = await executeArchestraTool(
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_limits`,
        undefined,
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain("Found 1 limit(s)");
    });

    test("should filter limits by entity type", async () => {
      await executeArchestraTool(
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
        {
          entity_type: "agent",
          entity_id: testAgent.id,
          limit_type: "token_cost",
          limit_value: 1000000,
          model: "claude-3-5-sonnet-20241022",
        },
        mockContext,
      );

      const result = await executeArchestraTool(
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_limits`,
        { entity_type: "agent" },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain("Found 1 limit(s)");
    });

    test("should return message when no limits found", async () => {
      const result = await executeArchestraTool(
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_limits`,
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
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
        {
          entity_type: "agent",
          entity_id: testAgent.id,
          limit_type: "token_cost",
          limit_value: 1000000,
          model: "claude-3-5-sonnet-20241022",
        },
        mockContext,
      );

      // Extract the limit ID from the response
      const limitId = (createResult.content[0] as any).text.match(
        /Limit ID: ([a-f0-9-]+)/,
      )?.[1];

      const result = await executeArchestraTool(
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_limit`,
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
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_limit`,
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
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}update_limit`,
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
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_limit`,
        {
          entity_type: "agent",
          entity_id: testAgent.id,
          limit_type: "token_cost",
          limit_value: 1000000,
          model: "claude-3-5-sonnet-20241022",
        },
        mockContext,
      );

      // Extract the limit ID from the response
      const limitId = (createResult.content[0] as any).text.match(
        /Limit ID: ([a-f0-9-]+)/,
      )?.[1];

      const result = await executeArchestraTool(
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}delete_limit`,
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
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}delete_limit`,
        {},
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("id is required");
    });

    test("should return error when limit not found", async () => {
      const result = await executeArchestraTool(
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}delete_limit`,
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
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_agent_token_usage`,
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
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_agent_token_usage`,
        { agent_id: otherAgent.id },
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain(
        `Token usage for agent ${otherAgent.id}`,
      );
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
