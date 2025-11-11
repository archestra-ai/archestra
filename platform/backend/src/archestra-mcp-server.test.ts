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
  test("should return an array of 3 tools", () => {
    const tools = getArchestraMcpTools();

    expect(tools).toHaveLength(3);
    expect(tools[0]).toHaveProperty("name");
    expect(tools[0]).toHaveProperty("title");
    expect(tools[0]).toHaveProperty("description");
    expect(tools[0]).toHaveProperty("inputSchema");
  });

  test("should have correctly formatted tool names with separator", () => {
    const tools = getArchestraMcpTools();

    expect(tools[0].name).toContain(MCP_SERVER_TOOL_NAME_SEPARATOR);
    expect(tools[1].name).toContain(MCP_SERVER_TOOL_NAME_SEPARATOR);
    expect(tools[2].name).toContain(MCP_SERVER_TOOL_NAME_SEPARATOR);
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
