import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  executeArchestraTool,
  getArchestraMcpTools,
  type ArchestraUserContext,
} from "./archestra-mcp-server";

// Mock the database
vi.mock("./database", () => ({
  __esModule: true,
  default: {
    select: vi.fn(),
  },
  schema: {
    internalMcpCatalogTable: {
      name: "name",
      description: "description",
    },
    member: {},
  },
}));

// Mock the logger
vi.mock("./logging", () => ({
  __esModule: true,
  default: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock the models
vi.mock("./models", () => ({
  InternalMcpCatalogModel: {
    findAll: vi.fn(),
  },
  McpServerInstallationRequestModel: {
    findPendingByExternalCatalogId: vi.fn(),
    create: vi.fn(),
  },
}));

import { InternalMcpCatalogModel, McpServerInstallationRequestModel } from "@/models";
import db from "@/database";

describe("getArchestraMcpTools", () => {
  it("should return an array of 3 tools", () => {
    const tools = getArchestraMcpTools();

    expect(tools).toHaveLength(3);
    expect(tools[0]).toHaveProperty("name");
    expect(tools[0]).toHaveProperty("title");
    expect(tools[0]).toHaveProperty("description");
    expect(tools[0]).toHaveProperty("inputSchema");
  });

  it("should have correctly formatted tool names with separator", () => {
    const tools = getArchestraMcpTools();

    expect(tools[0].name).toContain(MCP_SERVER_TOOL_NAME_SEPARATOR);
    expect(tools[1].name).toContain(MCP_SERVER_TOOL_NAME_SEPARATOR);
    expect(tools[2].name).toContain(MCP_SERVER_TOOL_NAME_SEPARATOR);
  });

  it("should have whoami tool", () => {
    const tools = getArchestraMcpTools();
    const whoamiTool = tools.find((t) => t.name.endsWith("whoami"));

    expect(whoamiTool).toBeDefined();
    expect(whoamiTool?.title).toBe("Who Am I");
  });

  it("should have search_private_mcp_registry tool", () => {
    const tools = getArchestraMcpTools();
    const searchTool = tools.find((t) => t.name.endsWith("search_private_mcp_registry"));

    expect(searchTool).toBeDefined();
    expect(searchTool?.title).toBe("Search Private MCP Registry");
  });

  it("should have create_mcp_server_installation_request tool", () => {
    const tools = getArchestraMcpTools();
    const createTool = tools.find((t) =>
      t.name.endsWith("create_mcp_server_installation_request")
    );

    expect(createTool).toBeDefined();
    expect(createTool?.title).toBe("Create MCP Server Installation Request");
  });
});

describe("executeArchestraTool", () => {
  const mockUserContext: ArchestraUserContext = {
    userId: "user-123",
    email: "test@example.com",
    organizationId: "org-456",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("whoami tool", () => {
    it("should return user information", async () => {
      const result = await executeArchestraTool(
        `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}whoami`,
        undefined,
        mockUserContext
      );

      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toHaveProperty("type", "text");
      expect((result.content[0] as any).text).toContain("test@example.com");
      expect((result.content[0] as any).text).toContain("user-123");
      expect((result.content[0] as any).text).toContain("org-456");
    });
  });

  describe("search_private_mcp_registry tool", () => {
    it("should return all catalog items when no query provided", async () => {
      const mockCatalogItems = [
        {
          id: "1",
          name: "Test Server",
          version: "1.0.0",
          description: "A test server",
          serverType: "remote",
          serverUrl: "https://example.com",
          repository: "https://github.com/example/repo",
        },
      ];

      vi.mocked(InternalMcpCatalogModel.findAll).mockResolvedValue(mockCatalogItems as any);

      const result = await executeArchestraTool(
        `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
        undefined,
        mockUserContext
      );

      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect((result.content[0] as any).text).toContain("Found 1 MCP server(s)");
      expect((result.content[0] as any).text).toContain("Test Server");
    });

    it("should return empty message when no items found", async () => {
      vi.mocked(InternalMcpCatalogModel.findAll).mockResolvedValue([]);

      const result = await executeArchestraTool(
        `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
        undefined,
        mockUserContext
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain("No MCP servers found");
    });

    it("should handle search with query parameter", async () => {
      const mockWhere = vi.fn().mockResolvedValue([
        {
          id: "2",
          name: "Filtered Server",
          serverType: "remote",
        },
      ]);
      const mockFrom = vi.fn().mockReturnValue({
        where: mockWhere,
      });
      const mockSelect = vi.fn().mockReturnValue({
        from: mockFrom,
      });

      vi.mocked(db).select = mockSelect;

      const result = await executeArchestraTool(
        `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
        { query: "test" },
        mockUserContext
      );

      expect(mockSelect).toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalled();
      expect(mockWhere).toHaveBeenCalled();
      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain("Found 1 MCP server(s)");
      expect((result.content[0] as any).text).toContain("Filtered Server");
    });

    it("should handle errors gracefully", async () => {
      vi.mocked(InternalMcpCatalogModel.findAll).mockRejectedValue(
        new Error("Database error")
      );

      const result = await executeArchestraTool(
        `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
        undefined,
        mockUserContext
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("Error searching private MCP registry");
    });
  });

  describe("create_mcp_server_installation_request tool", () => {
    it("should create installation request with external catalog ID", async () => {
      vi.mocked(McpServerInstallationRequestModel.findPendingByExternalCatalogId).mockResolvedValue(null);
      vi.mocked(McpServerInstallationRequestModel.create).mockResolvedValue({
        id: "request-123",
        status: "pending",
      } as any);

      const result = await executeArchestraTool(
        `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server_installation_request`,
        {
          external_catalog_id: "catalog-123",
          request_reason: "Need this server for testing",
        },
        mockUserContext
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain("Successfully created");
      expect((result.content[0] as any).text).toContain("request-123");
      expect(McpServerInstallationRequestModel.create).toHaveBeenCalledWith({
        externalCatalogId: "catalog-123",
        requestedBy: "user-123",
        requestReason: "Need this server for testing",
        customServerConfig: null,
        status: "pending",
      });
    });

    it("should return error when neither external_catalog_id nor custom_server_config provided", async () => {
      const result = await executeArchestraTool(
        `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server_installation_request`,
        {},
        mockUserContext
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("Either external_catalog_id or custom_server_config must be provided");
    });

    it("should return message when pending request already exists", async () => {
      vi.mocked(McpServerInstallationRequestModel.findPendingByExternalCatalogId).mockResolvedValue({
        id: "existing-request-123",
        status: "pending",
      } as any);

      const result = await executeArchestraTool(
        `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server_installation_request`,
        { external_catalog_id: "catalog-123" },
        mockUserContext
      );

      expect(result.isError).toBe(false);
      expect((result.content[0] as any).text).toContain("pending installation request already exists");
      expect((result.content[0] as any).text).toContain("existing-request-123");
      expect(McpServerInstallationRequestModel.create).not.toHaveBeenCalled();
    });

    it("should handle errors gracefully", async () => {
      vi.mocked(McpServerInstallationRequestModel.findPendingByExternalCatalogId).mockResolvedValue(null);
      vi.mocked(McpServerInstallationRequestModel.create).mockRejectedValue(
        new Error("Database error")
      );

      const result = await executeArchestraTool(
        `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server_installation_request`,
        { external_catalog_id: "catalog-123" },
        mockUserContext
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("Error creating installation request");
    });
  });

  describe("unknown tool", () => {
    it("should throw error for unknown tool name", async () => {
      await expect(
        executeArchestraTool("unknown_tool", undefined, mockUserContext)
      ).rejects.toMatchObject({
        code: -32601,
        message: "Tool 'unknown_tool' not found",
      });
    });
  });
});
