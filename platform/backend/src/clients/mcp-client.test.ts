import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  AgentModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  SecretModel,
  ToolModel,
} from "@/models";
import mcpClient from "./mcp-client";

// Mock the MCP SDK
const mockCallTool = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test..
  Client: vi.fn(function (this: any) {
    this.connect = mockConnect;
    this.callTool = mockCallTool;
    this.close = mockClose;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

describe("McpClient", () => {
  let agentId: string;
  let mcpServerId: string;

  beforeEach(async () => {
    // Create test agent
    const agent = await AgentModel.create({ name: "Test Agent", teams: [] });
    agentId = agent.id;

    // Create secret with access token
    const secret = await SecretModel.create({
      secret: {
        access_token: "test-github-token-123",
      },
    });

    // Create MCP server for testing with secret
    const catalogItem = await InternalMcpCatalogModel.create({
      name: "github-mcp-server",
      serverType: "remote",
      serverUrl: "https://api.githubcopilot.com/mcp/",
    });
    const mcpServer = await McpServerModel.create({
      name: "github-mcp-server",
      secretId: secret.id,
      catalogId: catalogItem.id,
    });
    mcpServerId = mcpServer.id;

    // Reset all mocks
    vi.clearAllMocks();
    mockCallTool.mockReset();
    mockConnect.mockReset();
    mockClose.mockReset();
  });

  describe("executeToolCalls", () => {
    test("returns empty array when no tool calls provided", async () => {
      const result = await mcpClient.executeToolCalls([], agentId);
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

      const result = await mcpClient.executeToolCalls(toolCalls, agentId);
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

      const result = await mcpClient.executeToolCalls(toolCalls, agentId);

      // Should return empty since no MCP tools with GitHub tokens exist
      expect(result).toEqual([]);
    });

    describe("Response Modifier Templates", () => {
      test("applies simple text template to tool response", async () => {
        // Create MCP tool with response modifier template
        const tool = await ToolModel.createToolIfNotExists({
          agentId,
          name: "github-mcp-server__test_tool",
          description: "Test MCP tool",
          parameters: {},
          mcpServerId,
        });

        // Assign tool to agent with response modifier
        await AgentToolModel.create(agentId, tool.id, {
          responseModifierTemplate:
            'Modified: {{{lookup (lookup response 0) "text"}}}',
        });

        // Mock the MCP client response with realistic GitHub issues data
        mockCallTool.mockResolvedValueOnce({
          content: [
            {
              type: "text",
              text: '{"issues":[{"id":3550499726,"number":816,"state":"OPEN","title":"Add authentication for MCP gateways"}]}',
            },
          ],
          isError: false,
        });

        const toolCalls = [
          {
            id: "call_1",
            name: "github-mcp-server__test_tool",
            arguments: {},
          },
        ];

        const results = await mcpClient.executeToolCalls(toolCalls, agentId);

        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
          id: "call_1",
          content: [
            {
              type: "text",
              text: 'Modified: {"issues":[{"id":3550499726,"number":816,"state":"OPEN","title":"Add authentication for MCP gateways"}]}',
            },
          ],
          isError: false,
        });
      });

      test("applies JSON template to tool response", async () => {
        // Create MCP tool with JSON response modifier template
        const tool = await ToolModel.createToolIfNotExists({
          agentId,
          name: "github-mcp-server__json_tool",
          description: "Test MCP tool with JSON",
          parameters: {},
          mcpServerId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          responseModifierTemplate:
            '{{#with (lookup response 0)}}{"formatted": true, "data": "{{{this.text}}}"}{{/with}}',
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "test data" }],
          isError: false,
        });

        const toolCalls = [
          {
            id: "call_1",
            name: "github-mcp-server__json_tool",
            arguments: {},
          },
        ];

        const results = await mcpClient.executeToolCalls(toolCalls, agentId);

        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
          id: "call_1",
          content: { formatted: true, data: "test data" },
          isError: false,
        });
      });

      test("transforms GitHub issues to id:title mapping using json helper", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          agentId,
          name: "github-mcp-server__github_issues",
          description: "GitHub issues tool",
          parameters: {},
          mcpServerId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          responseModifierTemplate: `{{#with (lookup response 0)}}{{#with (json this.text)}}
{
  {{#each this.issues}}
    "{{this.id}}": "{{{escapeJson this.title}}}"{{#unless @last}},{{/unless}}
  {{/each}}
}
{{/with}}{{/with}}`,
        });

        // Realistic GitHub MCP response with stringified JSON
        mockCallTool.mockResolvedValueOnce({
          content: [
            {
              type: "text",
              text: '{"issues":[{"id":3550499726,"number":816,"state":"OPEN","title":"Add authentication for MCP gateways"},{"id":3550391199,"number":815,"state":"OPEN","title":"ERROR: role \\"postgres\\" already exists"}]}',
            },
          ],
          isError: false,
        });

        const toolCalls = [
          {
            id: "call_1",
            name: "github-mcp-server__github_issues",
            arguments: {},
          },
        ];

        const results = await mcpClient.executeToolCalls(toolCalls, agentId);

        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
          id: "call_1",
          content: {
            "3550499726": "Add authentication for MCP gateways",
            "3550391199": 'ERROR: role "postgres" already exists',
          },
          isError: false,
        });
      });

      test("uses {{response}} to access full response content", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          agentId,
          name: "github-mcp-server__content_tool",
          description: "Test tool accessing full content",
          parameters: {},
          mcpServerId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          responseModifierTemplate: "{{{json response}}}",
        });

        mockCallTool.mockResolvedValueOnce({
          content: [
            { type: "text", text: "Line 1" },
            { type: "text", text: "Line 2" },
          ],
          isError: false,
        });

        const toolCalls = [
          {
            id: "call_1",
            name: "github-mcp-server__content_tool",
            arguments: {},
          },
        ];

        const results = await mcpClient.executeToolCalls(toolCalls, agentId);

        expect(results).toHaveLength(1);
        expect(results[0]?.content).toEqual([
          { type: "text", text: "Line 1" },
          { type: "text", text: "Line 2" },
        ]);
      });

      test("falls back to original content when template fails", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          agentId,
          name: "github-mcp-server__bad_template",
          description: "Test tool with bad template",
          parameters: {},
          mcpServerId,
        });

        // Invalid Handlebars template
        await AgentToolModel.create(agentId, tool.id, {
          responseModifierTemplate: "{{#invalid",
        });

        const originalContent = [{ type: "text", text: "Original" }];
        mockCallTool.mockResolvedValueOnce({
          content: originalContent,
          isError: false,
        });

        const toolCalls = [
          {
            id: "call_1",
            name: "github-mcp-server__bad_template",
            arguments: {},
          },
        ];

        const results = await mcpClient.executeToolCalls(toolCalls, agentId);

        // Should fall back to original content when template fails
        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
          id: "call_1",
          content: originalContent,
          isError: false,
        });
      });

      test("handles non-text content gracefully", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          agentId,
          name: "github-mcp-server__image_tool",
          description: "Test tool with image content",
          parameters: {},
          mcpServerId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          responseModifierTemplate:
            'Type: {{lookup (lookup response 0) "type"}}',
        });

        // Response with image instead of text
        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "image", data: "base64data" }],
          isError: false,
        });

        const toolCalls = [
          {
            id: "call_1",
            name: "github-mcp-server__image_tool",
            arguments: {},
          },
        ];

        const results = await mcpClient.executeToolCalls(toolCalls, agentId);

        expect(results).toHaveLength(1);
        expect(results[0]?.content).toEqual([
          { type: "text", text: "Type: image" },
        ]);
      });

      test("executes tool without template when none is set", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          agentId,
          name: "github-mcp-server__no_template",
          description: "Test tool without template",
          parameters: {},
          mcpServerId,
        });

        // Assign tool without response modifier template
        await AgentToolModel.create(agentId, tool.id, {
          responseModifierTemplate: null,
        });

        const originalContent = [{ type: "text", text: "Unmodified" }];
        mockCallTool.mockResolvedValueOnce({
          content: originalContent,
          isError: false,
        });

        const toolCalls = [
          {
            id: "call_1",
            name: "github-mcp-server__no_template",
            arguments: {},
          },
        ];

        const results = await mcpClient.executeToolCalls(toolCalls, agentId);

        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
          id: "call_1",
          content: originalContent,
          isError: false,
        });
      });

      test("applies different templates to different tools", async () => {
        // Create two tools with different templates
        const tool1 = await ToolModel.createToolIfNotExists({
          agentId,
          name: "github-mcp-server__tool1",
          description: "First tool",
          parameters: {},
          mcpServerId,
        });

        const tool2 = await ToolModel.createToolIfNotExists({
          agentId,
          name: "github-mcp-server__tool2",
          description: "Second tool",
          parameters: {},
          mcpServerId,
        });

        await AgentToolModel.create(agentId, tool1.id, {
          responseModifierTemplate:
            'Template 1: {{lookup (lookup response 0) "text"}}',
        });

        await AgentToolModel.create(agentId, tool2.id, {
          responseModifierTemplate:
            'Template 2: {{lookup (lookup response 0) "text"}}',
        });

        mockCallTool
          .mockResolvedValueOnce({
            content: [{ type: "text", text: "Response 1" }],
            isError: false,
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: "Response 2" }],
            isError: false,
          });

        const toolCalls = [
          {
            id: "call_1",
            name: "github-mcp-server__tool1",
            arguments: {},
          },
          {
            id: "call_2",
            name: "github-mcp-server__tool2",
            arguments: {},
          },
        ];

        const results = await mcpClient.executeToolCalls(toolCalls, agentId);

        expect(results).toHaveLength(2);
        expect(results[0]).toEqual({
          id: "call_1",
          content: [{ type: "text", text: "Template 1: Response 1" }],
          isError: false,
        });
        expect(results[1]).toEqual({
          id: "call_2",
          content: [{ type: "text", text: "Template 2: Response 2" }],
          isError: false,
        });
      });
    });
  });
});
