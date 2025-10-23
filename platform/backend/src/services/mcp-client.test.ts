import { beforeEach, describe, expect, test, vi } from "vitest";
import { AgentModel, ToolModel } from "@/models";
import { createTestUser } from "@/test-utils";
import mcpClientService from "./mcp-client";

// Mock the MCP SDK
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    callTool: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

describe("McpClientService", () => {
  let userId: string;
  let agentId: string;

  beforeEach(async () => {
    // Create test user and agent
    userId = await createTestUser();
    const agent = await AgentModel.create(
      { name: "Test Agent", usersWithAccess: [] },
      userId,
    );
    agentId = agent.id;

    // Reset all mocks
    vi.clearAllMocks();
  });

  describe("executeToolCalls", () => {
    test("returns empty array when no tool calls provided", async () => {
      const result = await mcpClientService.executeToolCalls([], agentId);
      expect(result).toEqual([]);
    });

    test("returns empty array when no MCP tools found for agent", async () => {
      const toolCalls = [
        {
          id: "call_123",
          name: "non_mcp_tool",
          arguments: { param: "value" },
        },
      ];

      const result = await mcpClientService.executeToolCalls(
        toolCalls,
        agentId,
      );
      expect(result).toEqual([]);
    });

    test("skips non-MCP tools and only executes MCP tools", async () => {
      // Create a proxy-sniffed tool (no mcpServerId)
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "proxy_tool",
        description: "Proxy tool",
        parameters: {},
      });

      // Create an MCP tool but don't set it up properly for this test
      const toolCalls = [
        {
          id: "call_1",
          name: "proxy_tool",
          arguments: { param: "value" },
        },
        {
          id: "call_2",
          name: "mcp_tool",
          arguments: { param: "value" },
        },
      ];

      const result = await mcpClientService.executeToolCalls(
        toolCalls,
        agentId,
      );

      // Should return empty since no MCP tools with GitHub tokens exist
      expect(result).toEqual([]);
    });
  });

  describe("GitHub configuration", () => {
    test("creates correct GitHub config", () => {
      const token = "test-token";
      const config = mcpClientService.createGitHubConfig(token);

      expect(config).toEqual({
        id: "github-mcp-server",
        name: "github-mcp-server",
        url: "https://api.githubcopilot.com/mcp/",
        headers: {
          Authorization: "Bearer test-token",
        },
      });
    });
  });
});
