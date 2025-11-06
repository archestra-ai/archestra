// biome-ignore-all lint/suspicious/noExplicitAny: test...
import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { AgentModel, InternalMcpCatalogModel } from "@/models";
import type { Agent, InternalMcpCatalogServerType } from "@/types";
import {
  type ArchestraContext,
  executeArchestraTool,
  getArchestraMcpTools,
  MCP_SERVER_NAME,
} from "./archestra-mcp-server";

async function createTestAgent(name?: string): Promise<Agent> {
  return await AgentModel.create({
    name: name || `Test Agent ${crypto.randomUUID().substring(0, 8)}`,
    teams: [],
    labels: [],
  });
}

async function createTestInternalMcpCatalogItem(data: {
  name: string;
  description?: string;
  version?: string;
  serverType: InternalMcpCatalogServerType;
  serverUrl?: string;
  repository?: string;
}) {
  return await InternalMcpCatalogModel.create({
    ...data,
  });
}

describe("getArchestraMcpTools", () => {
  it("should return an array of 2 tools", () => {
    const tools = getArchestraMcpTools();

    expect(tools).toHaveLength(2);
    expect(tools[0]).toHaveProperty("name");
    expect(tools[0]).toHaveProperty("title");
    expect(tools[0]).toHaveProperty("description");
    expect(tools[0]).toHaveProperty("inputSchema");
  });

  it("should have correctly formatted tool names with separator", () => {
    const tools = getArchestraMcpTools();

    expect(tools[0].name).toContain(MCP_SERVER_TOOL_NAME_SEPARATOR);
    expect(tools[1].name).toContain(MCP_SERVER_TOOL_NAME_SEPARATOR);
  });

  it("should have whoami tool", () => {
    const tools = getArchestraMcpTools();
    const whoamiTool = tools.find((t) => t.name.endsWith("whoami"));

    expect(whoamiTool).toBeDefined();
    expect(whoamiTool?.title).toBe("Who Am I");
  });

  it("should have search_private_mcp_registry tool", () => {
    const tools = getArchestraMcpTools();
    const searchTool = tools.find((t) =>
      t.name.endsWith("search_private_mcp_registry"),
    );

    expect(searchTool).toBeDefined();
    expect(searchTool?.title).toBe("Search Private MCP Registry");
  });

  it("should not have create_mcp_server_installation_request tool (disabled)", () => {
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

  beforeEach(async () => {
    testAgent = await createTestAgent("Test Agent");
    mockContext = {
      agent: testAgent,
    };
  });

  describe("whoami tool", () => {
    it("should return agent information", async () => {
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
    it("should return all catalog items when no query provided", async () => {
      await createTestInternalMcpCatalogItem({
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

    it("should return empty message when no items found", async () => {
      // No items created, so search should return empty
      const result = await executeArchestraTool(
        `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
        undefined,
        mockContext,
      );

      expect(result.isError).toBe(false);

      expect((result.content[0] as any).text).toContain("No MCP servers found");
    });

    it("should handle search with query parameter", async () => {
      await createTestInternalMcpCatalogItem({
        name: "Test Server",
        description: "A server for testing",
        serverType: "remote",
      });

      await createTestInternalMcpCatalogItem({
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

    it("should handle errors gracefully", async () => {
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

  // MCP server installation request tool is temporarily disabled
  describe("create_mcp_server_installation_request tool (disabled)", () => {
    it("should throw error for disabled tool", async () => {
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
    it("should throw error for unknown tool name", async () => {
      await expect(
        executeArchestraTool("unknown_tool", undefined, mockContext),
      ).rejects.toMatchObject({
        code: -32601,
        message: "Tool 'unknown_tool' not found",
      });
    });
  });
});
