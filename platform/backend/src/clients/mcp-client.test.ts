import { vi } from "vitest";
import {
  AgentModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import { secretManager } from "@/secretsmanager";
import { beforeEach, describe, expect, test } from "@/test";
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

// Mock McpServerRuntimeManager - use vi.hoisted to avoid initialization errors
const { mockUsesStreamableHttp, mockGetHttpEndpointUrl, mockGetPod } =
  vi.hoisted(() => ({
    mockUsesStreamableHttp: vi.fn(),
    mockGetHttpEndpointUrl: vi.fn(),
    mockGetPod: vi.fn(),
  }));

vi.mock("@/mcp-server-runtime", () => ({
  McpServerRuntimeManager: {
    usesStreamableHttp: mockUsesStreamableHttp,
    getHttpEndpointUrl: mockGetHttpEndpointUrl,
    getPod: mockGetPod,
  },
}));

describe("McpClient", () => {
  let agentId: string;
  let mcpServerId: string;
  let catalogId: string;

  beforeEach(async () => {
    // Create test agent
    const agent = await AgentModel.create({ name: "Test Agent", teams: [] });
    agentId = agent.id;

    // Create secret with access token
    const secret = await secretManager().createSecret(
      { access_token: "test-github-token-123" },
      "testmcptoken",
    );

    // Create catalog entry for the MCP server
    const catalogItem = await InternalMcpCatalogModel.create({
      name: "github-mcp-server",
      serverType: "remote",
      serverUrl: "https://api.githubcopilot.com/mcp/",
    });
    catalogId = catalogItem.id;

    // Create MCP server for testing with secret and catalog reference
    const mcpServer = await McpServerModel.create({
      name: "github-mcp-server",
      secretId: secret.id,
      catalogId: catalogItem.id,
      serverType: "remote",
    });
    mcpServerId = mcpServer.id;

    // Reset all mocks
    vi.clearAllMocks();
    mockCallTool.mockReset();
    mockConnect.mockReset();
    mockClose.mockReset();
    mockUsesStreamableHttp.mockReset();
    mockGetHttpEndpointUrl.mockReset();
    mockGetPod.mockReset();
  });

  describe("executeToolCall", () => {
    test("returns error when tool not found for agent", async () => {
      const toolCall = {
        id: "call_123",
        name: "non_mcp_tool",
        arguments: { param: "value" },
      };

      const result = await mcpClient.executeToolCall(toolCall, agentId);
      expect(result).toMatchObject({
        id: "call_123",
        isError: true,
        error: expect.stringContaining("Tool not found"),
      });
    });

    describe("Response Modifier Templates", () => {
      test("applies simple text template to tool response", async () => {
        // Create MCP tool with response modifier template
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__test_tool",
          description: "Test MCP tool",
          parameters: {},
          catalogId,
          mcpServerId,
        });

        // Assign tool to agent with response modifier
        await AgentToolModel.create(agentId, tool.id, {
          credentialSourceMcpServerId: mcpServerId,
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

        const toolCall = {
          id: "call_1",
          name: "github-mcp-server__test_tool",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        expect(result).toEqual({
          id: "call_1",
          content: [
            {
              type: "text",
              text: 'Modified: {"issues":[{"id":3550499726,"number":816,"state":"OPEN","title":"Add authentication for MCP gateways"}]}',
            },
          ],
          isError: false,
          name: "github-mcp-server__test_tool",
        });
      });

      test("applies JSON template to tool response", async () => {
        // Create MCP tool with JSON response modifier template
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__json_tool",
          description: "Test MCP tool with JSON",
          parameters: {},
          catalogId,
          mcpServerId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          credentialSourceMcpServerId: mcpServerId,
          responseModifierTemplate:
            '{{#with (lookup response 0)}}{"formatted": true, "data": "{{{this.text}}}"}{{/with}}',
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "test data" }],
          isError: false,
        });

        const toolCall = {
          id: "call_1",
          name: "github-mcp-server__json_tool",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        expect(result).toEqual({
          id: "call_1",
          content: { formatted: true, data: "test data" },
          isError: false,
          name: "github-mcp-server__json_tool",
        });
      });

      test("transforms GitHub issues to id:title mapping using json helper", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__github_issues",
          description: "GitHub issues tool",
          parameters: {},
          catalogId,
          mcpServerId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          credentialSourceMcpServerId: mcpServerId,
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

        const toolCall = {
          id: "call_1",
          name: "github-mcp-server__github_issues",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        expect(result).toEqual({
          id: "call_1",
          content: {
            "3550499726": "Add authentication for MCP gateways",
            "3550391199": 'ERROR: role "postgres" already exists',
          },
          isError: false,
          name: "github-mcp-server__github_issues",
        });
      });

      test("uses {{response}} to access full response content", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__content_tool",
          description: "Test tool accessing full content",
          parameters: {},
          catalogId,
          mcpServerId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          credentialSourceMcpServerId: mcpServerId,
          responseModifierTemplate: "{{{json response}}}",
        });

        mockCallTool.mockResolvedValueOnce({
          content: [
            { type: "text", text: "Line 1" },
            { type: "text", text: "Line 2" },
          ],
          isError: false,
        });

        const toolCall = {
          id: "call_1",
          name: "github-mcp-server__content_tool",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        expect(result?.content).toEqual([
          { type: "text", text: "Line 1" },
          { type: "text", text: "Line 2" },
        ]);
      });

      test("falls back to original content when template fails", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__bad_template",
          description: "Test tool with bad template",
          parameters: {},
          catalogId,
          mcpServerId,
        });

        // Invalid Handlebars template
        await AgentToolModel.create(agentId, tool.id, {
          credentialSourceMcpServerId: mcpServerId,
          responseModifierTemplate: "{{#invalid",
        });

        const originalContent = [{ type: "text", text: "Original" }];
        mockCallTool.mockResolvedValueOnce({
          content: originalContent,
          isError: false,
        });

        const toolCall = {
          id: "call_1",
          name: "github-mcp-server__bad_template",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        // Should fall back to original content when template fails

        expect(result).toEqual({
          id: "call_1",
          content: originalContent,
          isError: false,
          name: "github-mcp-server__bad_template",
        });
      });

      test("handles non-text content gracefully", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__image_tool",
          description: "Test tool with image content",
          parameters: {},
          catalogId,
          mcpServerId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          credentialSourceMcpServerId: mcpServerId,
          responseModifierTemplate:
            'Type: {{lookup (lookup response 0) "type"}}',
        });

        // Response with image instead of text
        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "image", data: "base64data" }],
          isError: false,
        });

        const toolCall = {
          id: "call_1",
          name: "github-mcp-server__image_tool",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        expect(result?.content).toEqual([
          { type: "text", text: "Type: image" },
        ]);
      });

      test("executes tool without template when none is set", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__no_template",
          description: "Test tool without template",
          parameters: {},
          catalogId,
          mcpServerId,
        });

        // Assign tool without response modifier template
        await AgentToolModel.create(agentId, tool.id, {
          credentialSourceMcpServerId: mcpServerId,
          responseModifierTemplate: null,
        });

        const originalContent = [{ type: "text", text: "Unmodified" }];
        mockCallTool.mockResolvedValueOnce({
          content: originalContent,
          isError: false,
        });

        const toolCall = {
          id: "call_1",
          name: "github-mcp-server__no_template",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        expect(result).toEqual({
          id: "call_1",
          content: originalContent,
          isError: false,
          name: "github-mcp-server__no_template",
        });
      });

      test("applies different templates to different tools", async () => {
        // Create two tools with different templates
        const tool1 = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__tool1",
          description: "First tool",
          parameters: {},
          catalogId,
          mcpServerId,
        });

        const tool2 = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__tool2",
          description: "Second tool",
          parameters: {},
          catalogId,
          mcpServerId,
        });

        await AgentToolModel.create(agentId, tool1.id, {
          credentialSourceMcpServerId: mcpServerId,
          responseModifierTemplate:
            'Template 1: {{lookup (lookup response 0) "text"}}',
        });

        await AgentToolModel.create(agentId, tool2.id, {
          credentialSourceMcpServerId: mcpServerId,
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

        const toolCall1 = {
          id: "call_1",
          name: "github-mcp-server__tool1",
          arguments: {},
        };

        const toolCall2 = {
          id: "call_2",
          name: "github-mcp-server__tool2",
          arguments: {},
        };

        const result1 = await mcpClient.executeToolCall(toolCall1, agentId);
        const result2 = await mcpClient.executeToolCall(toolCall2, agentId);

        expect(result1).toEqual({
          id: "call_1",
          content: [{ type: "text", text: "Template 1: Response 1" }],
          isError: false,
          name: "github-mcp-server__tool1",
        });
        expect(result2).toEqual({
          id: "call_2",
          content: [{ type: "text", text: "Template 2: Response 2" }],
          isError: false,
          name: "github-mcp-server__tool2",
        });
      });
    });

    describe("Streamable HTTP Transport (Local Servers)", () => {
      let localMcpServerId: string;
      let localCatalogId: string;

      beforeEach(async ({ makeUser }) => {
        // Create test user for local MCP servers
        const testUser = await makeUser({
          email: "test-local-mcp@example.com",
        });

        // Create catalog entry for local streamable-http server
        const localCatalog = await InternalMcpCatalogModel.create({
          name: "local-streamable-http-server",
          serverType: "local",
          localConfig: {
            command: "npx",
            arguments: [
              "@modelcontextprotocol/server-everything",
              "streamableHttp",
            ],
            transportType: "streamable-http",
            httpPort: 3001,
            httpPath: "/mcp",
          },
        });
        localCatalogId = localCatalog.id;

        // Create MCP server for local streamable-http testing
        const localMcpServer = await McpServerModel.create({
          name: "local-streamable-http-server",
          catalogId: localCatalogId,
          serverType: "local",
          userId: testUser.id,
        });
        localMcpServerId = localMcpServer.id;

        // Reset mocks
        mockUsesStreamableHttp.mockReset();
        mockGetHttpEndpointUrl.mockReset();
        mockCallTool.mockReset();
        mockConnect.mockReset();
      });

      test("executes tools using HTTP transport for streamable-http servers", async () => {
        // Create tool assigned to agent
        const tool = await ToolModel.createToolIfNotExists({
          name: "local-streamable-http-server__test_tool",
          description: "Test tool",
          parameters: {},
          catalogId: localCatalogId,
          mcpServerId: localMcpServerId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          executionSourceMcpServerId: localMcpServerId,
        });

        // Mock runtime manager responses
        mockUsesStreamableHttp.mockResolvedValue(true);
        mockGetHttpEndpointUrl.mockReturnValue("http://localhost:30123/mcp");

        // Mock successful tool call
        mockCallTool.mockResolvedValue({
          content: [{ type: "text", text: "Success from HTTP transport" }],
          isError: false,
        });

        const toolCall = {
          id: "call_1",
          name: "local-streamable-http-server__test_tool",
          arguments: { input: "test" },
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        // Verify HTTP transport was detected
        expect(mockUsesStreamableHttp).toHaveBeenCalledWith(localMcpServerId);
        expect(mockGetHttpEndpointUrl).toHaveBeenCalledWith(localMcpServerId);

        // Verify tool was called via HTTP client
        expect(mockCallTool).toHaveBeenCalledWith({
          name: "test_tool", // Server prefix stripped
          arguments: { input: "test" },
        });

        // Verify result

        expect(result).toEqual({
          id: "call_1",
          content: [{ type: "text", text: "Success from HTTP transport" }],
          isError: false,
          name: "local-streamable-http-server__test_tool",
        });
      });

      test("returns error when HTTP endpoint URL is missing", async () => {
        // Create tool assigned to agent
        const tool = await ToolModel.createToolIfNotExists({
          name: "local-streamable-http-server__test_tool",
          description: "Test tool",
          parameters: {},
          catalogId: localCatalogId,
          mcpServerId: localMcpServerId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          executionSourceMcpServerId: localMcpServerId,
        });

        // Mock runtime manager responses - no endpoint URL
        mockUsesStreamableHttp.mockResolvedValue(true);
        mockGetHttpEndpointUrl.mockReturnValue(undefined);

        const toolCall = {
          id: "call_1",
          name: "local-streamable-http-server__test_tool",
          arguments: { input: "test" },
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        // Verify error result

        expect(result).toEqual({
          id: "call_1",
          content: null,
          isError: true,
          error: expect.stringContaining("No HTTP endpoint URL found"),
          name: "local-streamable-http-server__test_tool",
        });
      });

      test("applies response modifier template with streamable-http", async () => {
        // Create tool with response modifier template
        const tool = await ToolModel.createToolIfNotExists({
          name: "local-streamable-http-server__formatted_tool",
          description: "Tool with template",
          parameters: {},
          catalogId: localCatalogId,
          mcpServerId: localMcpServerId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          executionSourceMcpServerId: localMcpServerId,
          responseModifierTemplate:
            'Result: {{{lookup (lookup response 0) "text"}}}',
        });

        // Mock runtime manager responses
        mockUsesStreamableHttp.mockResolvedValue(true);
        mockGetHttpEndpointUrl.mockReturnValue("http://localhost:30123/mcp");

        // Mock tool call response
        mockCallTool.mockResolvedValue({
          content: [{ type: "text", text: "Original content" }],
          isError: false,
        });

        const toolCall = {
          id: "call_1",
          name: "local-streamable-http-server__formatted_tool",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        // Verify template was applied

        expect(result).toEqual({
          id: "call_1",
          content: [{ type: "text", text: "Result: Original content" }],
          isError: false,
          name: "local-streamable-http-server__formatted_tool",
        });
      });

      test("uses K8s attach transport when streamable-http is false", async () => {
        // Create tool assigned to agent
        const tool = await ToolModel.createToolIfNotExists({
          name: "local-streamable-http-server__stdio_tool",
          description: "Tool using K8s attach",
          parameters: {},
          catalogId: localCatalogId,
          mcpServerId: localMcpServerId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          executionSourceMcpServerId: localMcpServerId,
        });

        // Mock runtime manager to indicate stdio transport (not HTTP)
        mockUsesStreamableHttp.mockResolvedValue(false);

        // Mock K8sPod instance
        const mockK8sPod = {
          k8sAttachClient: {} as import("@kubernetes/client-node").Attach,
          k8sNamespace: "default",
          k8sPodName: "mcp-test-pod",
        };
        mockGetPod.mockReturnValue(mockK8sPod);

        // Mock the tool call response
        mockCallTool.mockResolvedValue({
          content: [{ type: "text", text: "Success from K8s attach" }],
          isError: false,
        });

        const toolCall = {
          id: "call_1",
          name: "local-streamable-http-server__stdio_tool",
          arguments: { input: "test" },
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        // Verify K8s attach transport was used (not HTTP transport)
        expect(mockUsesStreamableHttp).toHaveBeenCalledWith(localMcpServerId);
        expect(mockGetHttpEndpointUrl).not.toHaveBeenCalled();
        expect(mockGetPod).toHaveBeenCalledWith(localMcpServerId);

        // Verify MCP SDK client was used
        expect(mockCallTool).toHaveBeenCalledWith({
          name: "stdio_tool",
          arguments: { input: "test" },
        });

        // Verify result
        expect(result).toMatchObject({
          id: "call_1",
          content: [{ type: "text", text: "Success from K8s attach" }],
          isError: false,
        });
      });
    });
  });
});
