import { randomUUID } from "node:crypto";
import {
  MCP_APPS_EXTENSION_ID,
  MCP_CATALOG_INSTALL_PATH,
  MCP_CATALOG_REAUTH_QUERY_PARAM,
  MCP_CATALOG_SERVER_QUERY_PARAM,
  MCP_ENTERPRISE_AUTH_EXTENSION_ID,
} from "@shared";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import {
  AgentModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpHttpSessionModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import { beforeEach, describe, expect, test } from "@/test";
import mcpClient from "./mcp-client";

// Mock the MCP SDK
const mockCallTool = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTools = vi.fn();
const mockPing = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test..
  Client: vi.fn(function (this: any) {
    this.connect = mockConnect;
    this.callTool = mockCallTool;
    this.close = mockClose;
    this.listTools = mockListTools;
    this.ping = mockPing;
  }),
}));

vi.mock(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js")
      >();
    return {
      ...actual,
      StreamableHTTPClientTransport: vi.fn(),
    };
  },
);

// Mock McpServerRuntimeManager - use vi.hoisted to avoid initialization errors
const {
  mockUsesStreamableHttp,
  mockGetHttpEndpointUrl,
  mockGetRunningPodHttpEndpoint,
  mockGetOrLoadDeployment,
} = vi.hoisted(() => ({
  mockUsesStreamableHttp: vi.fn(),
  mockGetHttpEndpointUrl: vi.fn(),
  mockGetRunningPodHttpEndpoint: vi.fn(),
  mockGetOrLoadDeployment: vi.fn(),
}));

vi.mock("@/k8s/mcp-server-runtime", () => ({
  McpServerRuntimeManager: {
    usesStreamableHttp: mockUsesStreamableHttp,
    getHttpEndpointUrl: mockGetHttpEndpointUrl,
    getRunningPodHttpEndpoint: mockGetRunningPodHttpEndpoint,
    getOrLoadDeployment: mockGetOrLoadDeployment,
  },
}));

describe("McpClient", () => {
  let agentId: string;
  let mcpServerId: string;
  let catalogId: string;

  beforeEach(async () => {
    // Create test agent
    const agent = await AgentModel.create({
      name: "Test Agent",
      scope: "org",
      teams: [],
    });
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
    mockListTools.mockReset();
    mockPing.mockReset();
    mockUsesStreamableHttp.mockReset();
    mockGetHttpEndpointUrl.mockReset();
    mockGetRunningPodHttpEndpoint.mockReset();
    mockGetOrLoadDeployment.mockReset();

    // Spy on McpHttpSessionModel to prevent real DB writes during mcp-client tests
    // and to avoid errors from session persistence in the background
    vi.spyOn(
      McpHttpSessionModel,
      "findRecordByConnectionKey",
    ).mockResolvedValue(null);
    vi.spyOn(McpHttpSessionModel, "upsert").mockResolvedValue(undefined);
    vi.spyOn(McpHttpSessionModel, "deleteByConnectionKey").mockResolvedValue(
      undefined,
    );
    vi.spyOn(McpHttpSessionModel, "deleteStaleSession").mockResolvedValue(
      undefined,
    );
    vi.spyOn(McpHttpSessionModel, "deleteExpired").mockResolvedValue(0);

    // Default: listTools returns empty list (fallback to stripped name)
    mockListTools.mockResolvedValue({ tools: [] });
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

    test("declares MCP Apps and enterprise auth extensions during initialize", async () => {
      const tool = await ToolModel.createToolIfNotExists({
        name: "github-mcp-server__declared_extensions",
        description: "Extension declaration test",
        parameters: {},
        catalogId,
      });

      await AgentToolModel.create(agentId, tool.id, {
        mcpServerId,
        credentialResolutionMode: "static",
      });

      mockConnect.mockResolvedValue(undefined);
      mockCallTool.mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });

      const result = await mcpClient.executeToolCall(
        {
          id: "call_extensions",
          name: tool.name,
          arguments: {},
        },
        agentId,
      );

      expect(result.isError).toBe(false);

      const clientConstructor = vi.mocked(
        (await import("@modelcontextprotocol/sdk/client/index.js")).Client,
      );
      expect(clientConstructor).toHaveBeenCalled();
      const options = clientConstructor.mock.calls.at(-1)?.[1] as
        | { capabilities?: { extensions?: Record<string, unknown> } }
        | undefined;
      expect(options?.capabilities?.extensions).toEqual({
        [MCP_APPS_EXTENSION_ID]: {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
        [MCP_ENTERPRISE_AUTH_EXTENSION_ID]: {},
      });
    });

    describe("Secrets caching (N+1 prevention)", () => {
      test("caches secret lookups across consecutive tool calls to same server", async () => {
        // Create two tools assigned to the same MCP server (same catalog)
        const tool1 = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__tool_a",
          description: "Tool A",
          parameters: {},
          catalogId,
        });
        const tool2 = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__tool_b",
          description: "Tool B",
          parameters: {},
          catalogId,
        });

        await AgentToolModel.create(agentId, tool1.id, {
          mcpServerId: mcpServerId,
        });
        await AgentToolModel.create(agentId, tool2.id, {
          mcpServerId: mcpServerId,
        });

        mockCallTool
          .mockResolvedValueOnce({
            content: [{ type: "text", text: "Result A" }],
            isError: false,
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: "Result B" }],
            isError: false,
          });

        // Spy on secretManager to count calls
        const getSecretSpy = vi.spyOn(secretManager(), "getSecret");

        const resultA = await mcpClient.executeToolCall(
          { id: "call_a", name: "github-mcp-server__tool_a", arguments: {} },
          agentId,
        );
        const resultB = await mcpClient.executeToolCall(
          { id: "call_b", name: "github-mcp-server__tool_b", arguments: {} },
          agentId,
        );

        expect(resultA.isError).toBe(false);
        expect(resultB.isError).toBe(false);

        // Secret should only be fetched once due to caching
        expect(getSecretSpy).toHaveBeenCalledTimes(1);

        getSecretSpy.mockRestore();
      });
    });

    describe("Concurrency limiter", () => {
      test("limits HTTP concurrency to 4", async () => {
        const clientWithInternals = mcpClient as unknown as {
          connectionLimiter: {
            runWithLimit: (
              connectionKey: string,
              limit: number,
              fn: () => Promise<unknown>,
            ) => Promise<unknown>;
          };
          getTransport: (
            catalogItem: unknown,
            targetLocalMcpServerId: string,
            secrets: Record<string, unknown>,
          ) => Promise<unknown>;
          getTransportWithKind: (
            catalogItem: unknown,
            targetLocalMcpServerId: string,
            secrets: Record<string, unknown>,
            transportKind: "stdio" | "http",
          ) => Promise<unknown>;
        };

        const runWithLimitSpy = vi.spyOn(
          clientWithInternals.connectionLimiter,
          "runWithLimit",
        );
        const getTransportSpy = vi.spyOn(clientWithInternals, "getTransport");
        const getTransportWithKindSpy = vi.spyOn(
          clientWithInternals,
          "getTransportWithKind",
        );

        try {
          const tool = await ToolModel.createToolIfNotExists({
            name: "github-mcp-server__limiter_http",
            description: "Limiter http tool",
            parameters: {},
            catalogId,
          });

          await AgentToolModel.create(agentId, tool.id, {
            mcpServerId: mcpServerId,
          });

          mockCallTool.mockResolvedValueOnce({
            content: [{ type: "text", text: "Limiter http" }],
            isError: false,
          });

          const toolCall = {
            id: "call_limiter_http",
            name: "github-mcp-server__limiter_http",
            arguments: {},
          };

          const result = await mcpClient.executeToolCall(toolCall, agentId);

          expect(runWithLimitSpy).toHaveBeenCalled();
          expect(runWithLimitSpy.mock.calls[0]?.[1]).toBe(4);
          expect(getTransportSpy).not.toHaveBeenCalled();
          expect(getTransportWithKindSpy).toHaveBeenCalled();

          expect(result).toEqual({
            id: "call_limiter_http",
            content: [{ type: "text", text: "Limiter http" }],
            isError: false,
            name: "github-mcp-server__limiter_http",
          });
        } finally {
          runWithLimitSpy.mockRestore();
          getTransportSpy.mockRestore();
          getTransportWithKindSpy.mockRestore();
        }
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
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: localMcpServerId,
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
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: localMcpServerId,
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
          content: [
            {
              type: "text",
              text: expect.stringContaining("No HTTP endpoint URL found"),
            },
          ],
          isError: true,
          error: expect.stringContaining("No HTTP endpoint URL found"),
          name: "local-streamable-http-server__test_tool",
          _meta: {
            archestraError: {
              type: "generic",
              message: expect.stringContaining("No HTTP endpoint URL found"),
            },
          },
          structuredContent: {
            archestraError: {
              type: "generic",
              message: expect.stringContaining("No HTTP endpoint URL found"),
            },
          },
        });
      });

      test("uses K8s attach transport when streamable-http is false", async () => {
        // Create tool assigned to agent
        const tool = await ToolModel.createToolIfNotExists({
          name: "local-streamable-http-server__stdio_tool",
          description: "Tool using K8s attach",
          parameters: {},
          catalogId: localCatalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: localMcpServerId,
        });

        // Mock runtime manager to indicate stdio transport (not HTTP)
        mockUsesStreamableHttp.mockResolvedValue(false);

        // Mock K8sDeployment instance
        const mockK8sDeployment = {
          k8sAttachClient: {} as import("@kubernetes/client-node").Attach,
          k8sNamespace: "default",
          deploymentName: "mcp-test-deployment",
          getRunningPodName: vi.fn().mockResolvedValue("mcp-test-pod-actual"),
        };
        mockGetOrLoadDeployment.mockResolvedValue(mockK8sDeployment);

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
        expect(mockGetOrLoadDeployment).toHaveBeenCalledWith(localMcpServerId);
        expect(mockK8sDeployment.getRunningPodName).toHaveBeenCalled();

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

      test("limits stdio concurrency to 1", async () => {
        const clientWithInternals = mcpClient as unknown as {
          connectionLimiter: {
            runWithLimit: (
              connectionKey: string,
              limit: number,
              fn: () => Promise<unknown>,
            ) => Promise<unknown>;
          };
        };

        const runWithLimitSpy = vi.spyOn(
          clientWithInternals.connectionLimiter,
          "runWithLimit",
        );

        try {
          const tool = await ToolModel.createToolIfNotExists({
            name: "local-streamable-http-server__limiter_stdio",
            description: "Limiter stdio tool",
            parameters: {},
            catalogId: localCatalogId,
          });

          await AgentToolModel.create(agentId, tool.id, {
            mcpServerId: localMcpServerId,
          });

          mockUsesStreamableHttp.mockResolvedValue(false);

          const mockK8sDeployment = {
            k8sAttachClient: {} as import("@kubernetes/client-node").Attach,
            k8sNamespace: "default",
            deploymentName: "mcp-test-deployment",
            getRunningPodName: vi.fn().mockResolvedValue("mcp-test-pod-actual"),
          };
          mockGetOrLoadDeployment.mockResolvedValue(mockK8sDeployment);

          mockCallTool.mockResolvedValue({
            content: [{ type: "text", text: "Limiter stdio" }],
            isError: false,
          });

          const toolCall = {
            id: "call_limiter_stdio",
            name: "local-streamable-http-server__limiter_stdio",
            arguments: {},
          };

          const result = await mcpClient.executeToolCall(toolCall, agentId);

          expect(runWithLimitSpy).toHaveBeenCalled();
          expect(runWithLimitSpy.mock.calls[0]?.[1]).toBe(1);

          expect(result).toMatchObject({
            id: "call_limiter_stdio",
            content: [{ type: "text", text: "Limiter stdio" }],
            isError: false,
          });
        } finally {
          runWithLimitSpy.mockRestore();
        }
      });

      test("strips catalogName prefix when mcpServerName includes userId suffix (Issue #1179)", async () => {
        // Create tool with catalogName prefix (how local server tools are actually created)
        const tool = await ToolModel.createToolIfNotExists({
          name: "local-streamable-http-server__prefix_test_tool",
          description: "Tool for testing prefix stripping fallback",
          parameters: {},
          catalogId: localCatalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: localMcpServerId,
        });

        // Mock runtime manager responses
        mockUsesStreamableHttp.mockResolvedValue(true);
        mockGetHttpEndpointUrl.mockReturnValue("http://localhost:30123/mcp");

        // Mock successful tool call
        mockCallTool.mockResolvedValue({
          content: [{ type: "text", text: "Prefix stripping works!" }],
          isError: false,
        });

        const toolCall = {
          id: "call_prefix_test",
          name: "local-streamable-http-server__prefix_test_tool",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        // Verify the tool was called with just the tool name (stripped using catalogName)
        expect(mockCallTool).toHaveBeenCalledWith({
          name: "prefix_test_tool",
          arguments: {},
        });

        expect(result).toMatchObject({
          id: "call_prefix_test",
          content: [{ type: "text", text: "Prefix stripping works!" }],
          isError: false,
        });
      });

      test("falls back to stripping mcpServerName when catalogName prefix is missing", async () => {
        // Create catalog with different name to ensure catalog prefix doesn't match
        const otherCatalog = await InternalMcpCatalogModel.create({
          name: "other-catalog",
          serverType: "local",
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "custom-server-name__fallback_tool",
          description: "Tool using server name prefix",
          parameters: {},
          catalogId: otherCatalog.id,
        });

        // Ensure mcpServerName is 'custom-server-name' for this test
        await McpServerModel.update(localMcpServerId, {
          name: "custom-server-name",
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: localMcpServerId,
        });

        mockUsesStreamableHttp.mockResolvedValue(true);
        mockGetHttpEndpointUrl.mockReturnValue("http://localhost:30123/mcp");

        mockCallTool.mockResolvedValue({
          content: [{ type: "text", text: "Fallback works!" }],
          isError: false,
        });

        const toolCall = {
          id: "call_fallback_test",
          name: "custom-server-name__fallback_tool",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        // Verify stripping worked using mcpServerName fallback
        expect(mockCallTool).toHaveBeenCalledWith({
          name: "fallback_tool",
          arguments: {},
        });

        expect(result).toMatchObject({
          id: "call_fallback_test",
          content: [{ type: "text", text: "Fallback works!" }],
          isError: false,
        });
      });

      test("does not modify tool name when no prefix matches (Identity Case)", async () => {
        // Create tool with a name that doesn't follow the prefix convention
        const tool = await ToolModel.createToolIfNotExists({
          name: "standalone_tool_name",
          description: "Tool without standard prefix",
          parameters: {},
          catalogId: localCatalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: localMcpServerId,
        });

        mockUsesStreamableHttp.mockResolvedValue(true);
        mockGetHttpEndpointUrl.mockReturnValue("http://localhost:30123/mcp");

        mockCallTool.mockResolvedValue({
          content: [{ type: "text", text: "Identity works!" }],
          isError: false,
        });

        const toolCall = {
          id: "call_identity_test",
          name: "standalone_tool_name",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        // Verify the tool name was not mangled since no prefix matched
        expect(mockCallTool).toHaveBeenCalledWith({
          name: "standalone_tool_name",
          arguments: {},
        });

        expect(result).toMatchObject({
          id: "call_identity_test",
          content: [{ type: "text", text: "Identity works!" }],
          isError: false,
        });
      });
    });

    describe("createErrorResult includes error in content", () => {
      test("error results include error message in content array", async () => {
        const toolCall = {
          id: "call_error_content",
          name: "non_existent_tool",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        expect(result).toMatchObject({
          id: "call_error_content",
          isError: true,
          error: expect.any(String),
        });
        // content should be an array with the error text, not null
        expect(result?.content).toEqual([
          { type: "text", text: expect.any(String) },
        ]);
      });
    });

    describe("Dynamic credential auth link", () => {
      test("returns install URL when no server found for user with dynamic credential", async ({
        makeUser,
      }) => {
        const testUser = await makeUser({ email: "dynauth@example.com" });

        // Create a separate catalog + tool for dynamic credential testing
        const dynCatalog = await InternalMcpCatalogModel.create({
          name: "jira-mcp-server",
          serverType: "remote",
          serverUrl: "https://mcp.atlassian.com/v1/mcp",
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "jira-mcp-server__search_issues",
          description: "Search Jira issues",
          parameters: {},
          catalogId: dynCatalog.id,
        });

        // Assign tool to agent with dynamic team credential enabled
        await AgentToolModel.createOrUpdateCredentials(
          agentId,
          tool.id,
          null,
          "dynamic",
        );

        const toolCall = {
          id: "call_dynauth",
          name: "jira-mcp-server__search_issues",
          arguments: { query: "test" },
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId, {
          tokenId: "test-token",
          teamId: null,
          isOrganizationToken: false,
          userId: testUser.id,
        });

        // Should return an error with the install URL
        expect(result).toMatchObject({
          isError: true,
        });
        expect(result?.error).toContain(
          `Authentication required for "jira-mcp-server"`,
        );
        expect(result?.error).toContain(`user: ${testUser.id}`);
        expect(result?.error).toContain(
          `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?install=${dynCatalog.id}`,
        );
        expect(result?.error).toContain(
          "Once you have completed authentication, retry this tool call.",
        );

        // Content should also contain the error message
        expect(result?.content).toEqual([
          { type: "text", text: result?.error },
        ]);
        expect(result?._meta).toMatchObject({
          archestraError: {
            type: "auth_required",
            catalogId: dynCatalog.id,
            catalogName: "jira-mcp-server",
            installUrl: `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?install=${dynCatalog.id}`,
          },
        });
        expect(result?.structuredContent).toMatchObject({
          archestraError: {
            type: "auth_required",
          },
        });
      });

      test("returns install URL with team context when team token has no server", async ({
        makeUser,
        makeTeam,
        makeOrganization,
      }) => {
        const org = await makeOrganization();
        const testUser = await makeUser({ email: "teamauth@example.com" });
        const team = await makeTeam(org.id, testUser.id, {
          name: "Test Team",
        });

        // Create catalog + tool
        const dynCatalog = await InternalMcpCatalogModel.create({
          name: "jira-team-server",
          serverType: "remote",
          serverUrl: "https://mcp.atlassian.com/v1/mcp",
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "jira-team-server__get_issue",
          description: "Get Jira issue",
          parameters: {},
          catalogId: dynCatalog.id,
        });

        await AgentToolModel.createOrUpdateCredentials(
          agentId,
          tool.id,
          null,
          "dynamic",
        );

        const toolCall = {
          id: "call_team_dynauth",
          name: "jira-team-server__get_issue",
          arguments: { key: "PROJ-1" },
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId, {
          tokenId: "team-token",
          teamId: team.id,
          isOrganizationToken: false,
        });

        expect(result).toMatchObject({
          isError: true,
        });
        expect(result?.error).toContain(`team: ${team.id}`);
        expect(result?.error).toContain(
          `${MCP_CATALOG_INSTALL_PATH}?install=${dynCatalog.id}`,
        );
      });

      test("returns auth-required error with team context when servers exist but no owner is in team", async ({
        makeUser,
        makeTeam,
        makeOrganization,
      }) => {
        const org = await makeOrganization();
        // Two users: one owns the server, the other is in the team
        const serverOwner = await makeUser({
          email: "server-owner@example.com",
        });
        const teamMember = await makeUser({
          email: "team-member@example.com",
        });
        const team = await makeTeam(org.id, teamMember.id, {
          name: "Marketing Team",
        });
        // serverOwner is NOT added to the team

        // Create catalog + server owned by serverOwner
        const dynCatalog = await InternalMcpCatalogModel.create({
          name: "slack-mcp-server",
          serverType: "remote",
          serverUrl: "https://mcp.slack.com/v1/mcp",
        });

        const ownerSecret = await secretManager().createSecret(
          { access_token: "owner-slack-token" },
          "slack-owner-secret",
        );

        await McpServerModel.create({
          name: "slack-mcp-server",
          catalogId: dynCatalog.id,
          secretId: ownerSecret.id,
          serverType: "remote",
          ownerId: serverOwner.id,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "slack-mcp-server__send_message",
          description: "Send a Slack message",
          parameters: {},
          catalogId: dynCatalog.id,
        });

        await AgentToolModel.createOrUpdateCredentials(
          agentId,
          tool.id,
          null,
          "dynamic",
        );

        const toolCall = {
          id: "call_team_no_member_cred",
          name: "slack-mcp-server__send_message",
          arguments: { channel: "#general", text: "hello" },
        };

        // Call with teamMember's team token - serverOwner is NOT in this team
        const result = await mcpClient.executeToolCall(toolCall, agentId, {
          tokenId: "team-token-no-cred",
          teamId: team.id,
          isOrganizationToken: false,
        });

        expect(result).toMatchObject({ isError: true });
        expect(result?.error).toContain(
          `Authentication required for "slack-mcp-server"`,
        );
        expect(result?.error).toContain(`team: ${team.id}`);
        expect(result?.error).toContain(
          `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?install=${dynCatalog.id}`,
        );
        expect(result?.error).toContain(
          "Once you have completed authentication, retry this tool call.",
        );
        expect(result?.content).toEqual([
          { type: "text", text: result?.error },
        ]);
      });
    });

    describe("Enterprise-managed credentials", () => {
      test("uses an external IdP JWT as the exchange assertion when the caller authenticates via external IdP auth", async ({
        makeIdentityProvider,
        makeOrganization,
      }) => {
        const organization = await makeOrganization();
        const identityProvider = await makeIdentityProvider(organization.id, {
          providerId: "enterprise-external-jwt",
          issuer: "http://localhost:30081/realms/archestra",
          oidcConfig: {
            clientId: "archestra-oidc",
            tokenEndpoint:
              "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
            enterpriseManagedCredentials: {
              providerType: "keycloak",
              clientId: "archestra-oidc",
              clientSecret: "archestra-oidc-secret",
              tokenEndpoint:
                "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
              tokenEndpointAuthentication: "client_secret_post",
              subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
            },
          },
        });

        await AgentModel.update(agentId, {
          organizationId: organization.id,
          identityProviderId: identityProvider.id,
        });

        await McpServerModel.update(mcpServerId, { secretId: null });
        await InternalMcpCatalogModel.update(catalogId, {
          name: "enterprise external jwt demo",
          enterpriseManagedConfig: {
            identityProviderId: identityProvider.id,
            requestedCredentialType: "bearer_token",
            resourceIdentifier: "archestra-oidc",
            tokenInjectionMode: "authorization_bearer",
          },
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "enterprise external jwt demo__debug-auth-token",
          description: "Managed credential tool",
          parameters: {},
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          credentialResolutionMode: "enterprise_managed",
        });

        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
          new Response(
            JSON.stringify({
              access_token: "exchanged-downstream-token",
              expires_in: 300,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );

        mockCallTool.mockResolvedValue({
          content: [{ type: "text", text: "Managed result" }],
          isError: false,
        });

        const result = await mcpClient.executeToolCall(
          {
            id: "call_enterprise_external_jwt",
            name: "enterprise external jwt demo__debug-auth-token",
            arguments: {},
          },
          agentId,
          {
            tokenId: "external-token",
            teamId: null,
            isOrganizationToken: false,
            userId: "external-user-id",
            isExternalIdp: true,
            rawToken: "external-idp-jwt",
          },
        );

        expect(result.isError).toBe(false);

        const [, requestInit] = fetchMock.mock.calls.at(0) ?? [];
        expect(String(requestInit?.body)).toContain(
          "subject_token=external-idp-jwt",
        );

        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const [, options] =
          vi.mocked(StreamableHTTPClientTransport).mock.calls.at(-1) ?? [];
        const headers =
          options?.requestInit?.headers instanceof Headers
            ? options.requestInit.headers
            : new Headers(options?.requestInit?.headers);
        expect(headers.get("Authorization")).toBe(
          "Bearer exchanged-downstream-token",
        );

        fetchMock.mockRestore();
      });

      test("injects the brokered managed credential into the outgoing MCP request", async ({
        makeIdentityProvider,
        makeOrganization,
        makeUser,
      }) => {
        const organization = await makeOrganization();
        const user = await makeUser({ email: "managed-mcp@example.com" });
        const managedConfig = {
          requestedCredentialType: "secret" as const,
          resourceIdentifier: "orn:okta:pam:github-secret",
          tokenInjectionMode: "authorization_bearer" as const,
          responseFieldPath: "token",
        };
        const identityProvider = await makeIdentityProvider(organization.id, {
          providerId: "okta-managed-mcp",
          issuer: "https://example.okta.com",
          oidcConfig: {
            clientId: "web-client-id",
            tokenEndpoint: "https://example.okta.com/oauth2/v1/token",
            enterpriseManagedCredentials: {
              providerType: "okta",
              clientId: "ai-agent-client-id",
              tokenEndpoint: "https://example.okta.com/oauth2/v1/token",
              tokenEndpointAuthentication: "client_secret_post",
              clientSecret: "ai-agent-client-secret",
            },
          },
        });

        await AgentModel.update(agentId, {
          organizationId: organization.id,
          identityProviderId: identityProvider.id,
        });

        await McpServerModel.update(mcpServerId, { secretId: null });
        await InternalMcpCatalogModel.update(catalogId, {
          enterpriseManagedConfig: managedConfig,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__managed_tool",
          description: "Managed credential tool",
          parameters: {},
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          credentialResolutionMode: "enterprise_managed",
        });

        await db.insert(schema.accountsTable).values({
          id: randomUUID(),
          accountId: "acct-managed",
          providerId: identityProvider.providerId,
          userId: user.id,
          idToken: createJwt({ exp: futureExpSeconds() }),
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
          new Response(
            JSON.stringify({
              issued_token_type: "urn:okta:params:oauth:token-type:secret",
              secret: { token: "ghu_managed_token" },
              expires_in: 300,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );

        mockCallTool.mockResolvedValue({
          content: [{ type: "text", text: "Managed result" }],
          isError: false,
        });

        const result = await mcpClient.executeToolCall(
          {
            id: "call_enterprise_managed",
            name: "github-mcp-server__managed_tool",
            arguments: {},
          },
          agentId,
          {
            tokenId: "session-token",
            teamId: null,
            isOrganizationToken: false,
            userId: user.id,
          },
          { conversationId: "enterprise-managed-conv" },
        );

        expect(result.isError).toBe(false);

        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const [, options] =
          vi.mocked(StreamableHTTPClientTransport).mock.calls.at(-1) ?? [];
        const headers =
          options?.requestInit?.headers instanceof Headers
            ? options.requestInit.headers
            : new Headers(options?.requestInit?.headers);
        expect(headers.get("Authorization")).toBe("Bearer ghu_managed_token");

        fetchMock.mockRestore();
      });

      test("caches the brokered enterprise-managed credential for repeated tool calls", async ({
        makeIdentityProvider,
        makeOrganization,
        makeUser,
      }) => {
        const organization = await makeOrganization();
        const user = await makeUser({
          email: "cached-managed-mcp@example.com",
        });
        const managedConfig = {
          requestedCredentialType: "secret" as const,
          resourceIdentifier: "orn:okta:pam:github-secret",
          tokenInjectionMode: "authorization_bearer" as const,
          responseFieldPath: "token",
        };
        const identityProvider = await makeIdentityProvider(organization.id, {
          providerId: "okta-managed-cache",
          issuer: "https://example.okta.com",
          oidcConfig: {
            clientId: "web-client-id",
            tokenEndpoint: "https://example.okta.com/oauth2/v1/token",
            enterpriseManagedCredentials: {
              providerType: "okta",
              clientId: "ai-agent-client-id",
              tokenEndpoint: "https://example.okta.com/oauth2/v1/token",
              tokenEndpointAuthentication: "client_secret_post",
              clientSecret: "ai-agent-client-secret",
            },
          },
        });

        await AgentModel.update(agentId, {
          organizationId: organization.id,
          identityProviderId: identityProvider.id,
        });

        await McpServerModel.update(mcpServerId, { secretId: null });
        await InternalMcpCatalogModel.update(catalogId, {
          enterpriseManagedConfig: managedConfig,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__managed_cache_tool",
          description: "Managed credential cache tool",
          parameters: {},
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          credentialResolutionMode: "enterprise_managed",
        });

        await db.insert(schema.accountsTable).values({
          id: randomUUID(),
          accountId: "acct-managed-cache",
          providerId: identityProvider.providerId,
          userId: user.id,
          idToken: createJwt({ exp: futureExpSeconds() }),
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
          new Response(
            JSON.stringify({
              issued_token_type: "urn:okta:params:oauth:token-type:secret",
              secret: { token: "ghu_managed_token" },
              expires_in: 300,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );

        mockCallTool.mockResolvedValue({
          content: [{ type: "text", text: "Managed result" }],
          isError: false,
        });

        const firstResult = await mcpClient.executeToolCall(
          {
            id: "call_enterprise_managed_cache_1",
            name: "github-mcp-server__managed_cache_tool",
            arguments: {},
          },
          agentId,
          {
            tokenId: "session-token",
            teamId: null,
            isOrganizationToken: false,
            userId: user.id,
          },
          { conversationId: "enterprise-managed-cache-conv" },
        );
        const secondResult = await mcpClient.executeToolCall(
          {
            id: "call_enterprise_managed_cache_2",
            name: "github-mcp-server__managed_cache_tool",
            arguments: {},
          },
          agentId,
          {
            tokenId: "session-token",
            teamId: null,
            isOrganizationToken: false,
            userId: user.id,
          },
          { conversationId: "enterprise-managed-cache-conv" },
        );

        expect(firstResult.isError).toBe(false);
        expect(secondResult.isError).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        fetchMock.mockRestore();
      });

      test("returns re-authentication error when no usable enterprise assertion is available", async ({
        makeIdentityProvider,
        makeOrganization,
        makeUser,
      }) => {
        const organization = await makeOrganization();
        const user = await makeUser({
          email: "missing-enterprise-assertion@example.com",
        });
        const identityProvider = await makeIdentityProvider(organization.id, {
          providerId: "keycloak-managed-mcp",
          issuer: "http://localhost:30081/realms/archestra",
          oidcConfig: {
            clientId: "archestra-oidc",
            tokenEndpoint:
              "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
            enterpriseManagedCredentials: {
              providerType: "keycloak",
              clientId: "archestra-oidc",
              clientSecret: "archestra-oidc-secret",
              tokenEndpoint:
                "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
              tokenEndpointAuthentication: "client_secret_post",
              subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
            },
          },
        });

        await AgentModel.update(agentId, {
          organizationId: organization.id,
          identityProviderId: identityProvider.id,
        });

        await InternalMcpCatalogModel.update(catalogId, {
          name: "keycloak protected demo",
          enterpriseManagedConfig: {
            identityProviderId: identityProvider.id,
            requestedCredentialType: "bearer_token",
            resourceIdentifier: "archestra-oidc",
            tokenInjectionMode: "authorization_bearer",
          },
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "keycloak protected demo__whoami",
          description: "Show the current authenticated user",
          parameters: {},
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          credentialResolutionMode: "enterprise_managed",
        });

        const result = await mcpClient.executeToolCall(
          {
            id: "call_missing_enterprise_assertion",
            name: "keycloak protected demo__whoami",
            arguments: {},
          },
          agentId,
          {
            tokenId: "session-token",
            teamId: null,
            isOrganizationToken: false,
            userId: user.id,
          },
        );

        expect(result.isError).toBe(true);
        expect(result.error).toContain(
          'Expired or invalid authentication for "keycloak protected demo"',
        );
        expect(result.error).toContain(
          `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?${MCP_CATALOG_REAUTH_QUERY_PARAM}=${catalogId}&${MCP_CATALOG_SERVER_QUERY_PARAM}=${mcpServerId}`,
        );
        expect(result._meta).toMatchObject({
          archestraError: {
            type: "auth_expired",
            catalogId,
            catalogName: "keycloak protected demo",
            serverId: mcpServerId,
          },
        });
      });
    });

    describe("Auth error actionable message", () => {
      test("returns expired-auth message with manage URL when tool call throws UnauthorizedError on OAuth server with existing credentials", async ({
        makeUser,
      }) => {
        const testUser = await makeUser({
          email: "oauth-unauth@example.com",
        });

        // Create an OAuth-enabled catalog
        const oauthCatalog = await InternalMcpCatalogModel.create({
          name: "github-oauth-server",
          serverType: "remote",
          serverUrl: "https://api.githubcopilot.com/mcp/",
          oauthConfig: {
            name: "GitHub",
            server_url: "https://api.githubcopilot.com/mcp/",
            client_id: "test-client-id",
            redirect_uris: ["http://localhost:3000/callback"],
            scopes: ["repo"],
            default_scopes: ["repo"],
            supports_resource_metadata: false,
          },
        });

        // Create secret WITHOUT refresh_token (simulates expired token, no refresh)
        const secret = await secretManager().createSecret(
          { access_token: "expired-token" },
          "expired-oauth-secret",
        );

        const mcpServer = await McpServerModel.create({
          name: "github-oauth-server",
          catalogId: oauthCatalog.id,
          secretId: secret.id,
          serverType: "remote",
          ownerId: testUser.id,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "github-oauth-server__list_repos",
          description: "List repos",
          parameters: {},
          catalogId: oauthCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServer.id,
        });

        // Mock callTool to throw UnauthorizedError
        const { UnauthorizedError } = await import(
          "@modelcontextprotocol/sdk/client/auth.js"
        );
        mockCallTool.mockRejectedValueOnce(new UnauthorizedError());
        mockConnect.mockResolvedValue(undefined);

        const toolCall = {
          id: "call_oauth_unauth",
          name: "github-oauth-server__list_repos",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId, {
          tokenId: "test-token",
          teamId: null,
          isOrganizationToken: false,
          userId: testUser.id,
        });

        expect(result).toMatchObject({ isError: true });
        expect(result?.error).toContain(
          `Expired or invalid authentication for "github-oauth-server"`,
        );
        expect(result?.error).toContain(`user: ${testUser.id}`);
        expect(result?.error).toContain(
          `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?${MCP_CATALOG_REAUTH_QUERY_PARAM}=${oauthCatalog.id}&${MCP_CATALOG_SERVER_QUERY_PARAM}=${mcpServer.id}`,
        );
        expect(result?.error).toContain(
          "Once you have re-authenticated, retry this tool call.",
        );
        expect(result?._meta).toMatchObject({
          archestraError: {
            type: "auth_expired",
            catalogId: oauthCatalog.id,
            catalogName: "github-oauth-server",
            serverId: mcpServer.id,
            reauthUrl: `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?${MCP_CATALOG_REAUTH_QUERY_PARAM}=${oauthCatalog.id}&${MCP_CATALOG_SERVER_QUERY_PARAM}=${mcpServer.id}`,
          },
        });
      });

      test("returns expired-auth message with manage URL when tool call throws StreamableHTTPError 401 on OAuth server", async ({
        makeUser,
      }) => {
        const testUser = await makeUser({
          email: "oauth-http401@example.com",
        });

        const oauthCatalog = await InternalMcpCatalogModel.create({
          name: "github-http401-server",
          serverType: "remote",
          serverUrl: "https://api.githubcopilot.com/mcp/",
          oauthConfig: {
            name: "GitHub",
            server_url: "https://api.githubcopilot.com/mcp/",
            client_id: "test-client-id",
            redirect_uris: ["http://localhost:3000/callback"],
            scopes: ["repo"],
            default_scopes: ["repo"],
            supports_resource_metadata: false,
          },
        });

        const secret = await secretManager().createSecret(
          { access_token: "expired-token-2" },
          "expired-oauth-secret-2",
        );

        const mcpServer = await McpServerModel.create({
          name: "github-http401-server",
          catalogId: oauthCatalog.id,
          secretId: secret.id,
          serverType: "remote",
          ownerId: testUser.id,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "github-http401-server__list_repos",
          description: "List repos",
          parameters: {},
          catalogId: oauthCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServer.id,
        });

        // Mock callTool to throw StreamableHTTPError with 401
        const { StreamableHTTPError } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        mockCallTool.mockRejectedValueOnce(
          new StreamableHTTPError(401, "Unauthorized"),
        );
        mockConnect.mockResolvedValue(undefined);

        const toolCall = {
          id: "call_oauth_http401",
          name: "github-http401-server__list_repos",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId, {
          tokenId: "test-token",
          teamId: null,
          isOrganizationToken: false,
          userId: testUser.id,
        });

        expect(result).toMatchObject({ isError: true });
        expect(result?.error).toContain(
          `Expired or invalid authentication for "github-http401-server"`,
        );
        expect(result?.error).toContain(
          `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?${MCP_CATALOG_REAUTH_QUERY_PARAM}=${oauthCatalog.id}&${MCP_CATALOG_SERVER_QUERY_PARAM}=${mcpServer.id}`,
        );
      });

      test("returns expired-auth message for auth error on non-OAuth server (PAT-based) with existing credentials", async ({
        makeUser,
      }) => {
        const testUser = await makeUser({
          email: "non-oauth-unauth@example.com",
        });

        // Create catalog WITHOUT oauthConfig (PAT-based auth like GitHub)
        const nonOauthCatalog = await InternalMcpCatalogModel.create({
          name: "private-api-server",
          serverType: "remote",
          serverUrl: "https://private-api.example.com/mcp/",
        });

        const secret = await secretManager().createSecret(
          { access_token: "bad-token" },
          "non-oauth-secret",
        );

        const mcpServer = await McpServerModel.create({
          name: "private-api-server",
          catalogId: nonOauthCatalog.id,
          secretId: secret.id,
          serverType: "remote",
          ownerId: testUser.id,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "private-api-server__get_data",
          description: "Get data",
          parameters: {},
          catalogId: nonOauthCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServer.id,
        });

        const { UnauthorizedError } = await import(
          "@modelcontextprotocol/sdk/client/auth.js"
        );
        mockCallTool.mockRejectedValueOnce(new UnauthorizedError());
        mockConnect.mockResolvedValue(undefined);

        const toolCall = {
          id: "call_non_oauth_unauth",
          name: "private-api-server__get_data",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId, {
          tokenId: "test-token",
          teamId: null,
          isOrganizationToken: false,
          userId: testUser.id,
        });

        expect(result).toMatchObject({ isError: true });
        // Non-OAuth servers with existing credentials should get expired-auth message
        expect(result?.error).toContain(
          `Expired or invalid authentication for "private-api-server"`,
        );
        expect(result?.error).toContain(
          `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?${MCP_CATALOG_REAUTH_QUERY_PARAM}=${nonOauthCatalog.id}&${MCP_CATALOG_SERVER_QUERY_PARAM}=${mcpServer.id}`,
        );
      });

      test("returns expired-auth message when error message contains auth keywords", async ({
        makeUser,
      }) => {
        const testUser = await makeUser({
          email: "auth-keyword@example.com",
        });

        // Non-OAuth catalog (like GitHub with PAT)
        const catalog = await InternalMcpCatalogModel.create({
          name: "github-pat-server",
          serverType: "remote",
          serverUrl: "https://api.githubcopilot.com/mcp/",
        });

        const secret = await secretManager().createSecret(
          { access_token: "expired-pat" },
          "expired-pat-secret",
        );

        const mcpServer = await McpServerModel.create({
          name: "github-pat-server",
          catalogId: catalog.id,
          secretId: secret.id,
          serverType: "remote",
          ownerId: testUser.id,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "github-pat-server__list_repos",
          description: "List repos",
          parameters: {},
          catalogId: catalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServer.id,
        });

        // Mock callTool to throw StreamableHTTPError with non-401 code but auth message
        // (this is what GitHub actually does - returns error with "unauthorized" in body)
        const { StreamableHTTPError } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        mockCallTool.mockRejectedValueOnce(
          new StreamableHTTPError(
            500,
            "Error POSTing to endpoint: unauthorized: unauthorized: AuthenticateToken authentication failed",
          ),
        );
        mockConnect.mockResolvedValue(undefined);

        const toolCall = {
          id: "call_auth_keyword",
          name: "github-pat-server__list_repos",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId, {
          tokenId: "test-token",
          teamId: null,
          isOrganizationToken: false,
          userId: testUser.id,
        });

        expect(result).toMatchObject({ isError: true });
        expect(result?.error).toContain(
          `Expired or invalid authentication for "github-pat-server"`,
        );
        expect(result?.error).toContain(
          `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?${MCP_CATALOG_REAUTH_QUERY_PARAM}=${catalog.id}&${MCP_CATALOG_SERVER_QUERY_PARAM}=${mcpServer.id}`,
        );
      });

      test("returns expired-auth message with team context", async ({
        makeUser,
        makeTeam,
        makeOrganization,
      }) => {
        const org = await makeOrganization();
        const testUser = await makeUser({
          email: "oauth-team-unauth@example.com",
        });
        const team = await makeTeam(org.id, testUser.id, {
          name: "Dev Team",
        });

        const oauthCatalog = await InternalMcpCatalogModel.create({
          name: "github-team-oauth-server",
          serverType: "remote",
          serverUrl: "https://api.githubcopilot.com/mcp/",
          oauthConfig: {
            name: "GitHub",
            server_url: "https://api.githubcopilot.com/mcp/",
            client_id: "test-client-id",
            redirect_uris: ["http://localhost:3000/callback"],
            scopes: ["repo"],
            default_scopes: ["repo"],
            supports_resource_metadata: false,
          },
        });

        const secret = await secretManager().createSecret(
          { access_token: "expired-team-token" },
          "expired-team-oauth-secret",
        );

        const mcpServer = await McpServerModel.create({
          name: "github-team-oauth-server",
          catalogId: oauthCatalog.id,
          secretId: secret.id,
          serverType: "remote",
          ownerId: testUser.id,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "github-team-oauth-server__list_repos",
          description: "List repos",
          parameters: {},
          catalogId: oauthCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServer.id,
        });

        const { UnauthorizedError } = await import(
          "@modelcontextprotocol/sdk/client/auth.js"
        );
        mockCallTool.mockRejectedValueOnce(new UnauthorizedError());
        mockConnect.mockResolvedValue(undefined);

        const toolCall = {
          id: "call_team_oauth_unauth",
          name: "github-team-oauth-server__list_repos",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId, {
          tokenId: "team-token",
          teamId: team.id,
          isOrganizationToken: false,
        });

        expect(result).toMatchObject({ isError: true });
        expect(result?.error).toContain(
          `Expired or invalid authentication for "github-team-oauth-server"`,
        );
        expect(result?.error).toContain(`team: ${team.id}`);
        expect(result?.error).toContain(
          `${config.frontendBaseUrl}${MCP_CATALOG_INSTALL_PATH}?${MCP_CATALOG_REAUTH_QUERY_PARAM}=${oauthCatalog.id}&${MCP_CATALOG_SERVER_QUERY_PARAM}=${mcpServer.id}`,
        );
      });
    });

    describe("Stale session retry", () => {
      let localMcpServerId: string;
      let localCatalogId: string;

      beforeEach(async ({ makeUser }) => {
        const testUser = await makeUser({
          email: "test-stale-session@example.com",
        });

        const localCatalog = await InternalMcpCatalogModel.create({
          name: "stale-session-server",
          serverType: "local",
          localConfig: {
            dockerImage: "mcr.microsoft.com/playwright/mcp",
            transportType: "streamable-http",
            httpPort: 8080,
          },
        });
        localCatalogId = localCatalog.id;

        const localMcpServer = await McpServerModel.create({
          name: "stale-session-server",
          catalogId: localCatalogId,
          serverType: "local",
          userId: testUser.id,
        });
        localMcpServerId = localMcpServer.id;

        mockUsesStreamableHttp.mockReset();
        mockGetHttpEndpointUrl.mockReset();
        mockCallTool.mockReset();
        mockConnect.mockReset();
        mockPing.mockReset();

        // Make StreamableHTTPClientTransport mock store sessionId from options
        // so getOrCreateClient can detect stored sessions via `transport.sessionId`
        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        vi.mocked(StreamableHTTPClientTransport).mockImplementation(function (
          this: { sessionId?: string },
          _url: URL,
          options?: { sessionId?: string },
        ) {
          this.sessionId = options?.sessionId;
        } as
          // biome-ignore lint/suspicious/noExplicitAny: cast required for mock constructor
          any);
      });

      test("uses stored endpoint URL when resuming HTTP session", async () => {
        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );

        const tool = await ToolModel.createToolIfNotExists({
          name: "stale-session-server__stored_endpoint",
          description: "Test tool",
          parameters: {},
          catalogId: localCatalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: localMcpServerId,
        });

        mockUsesStreamableHttp.mockResolvedValue(true);
        mockGetHttpEndpointUrl.mockReturnValue("http://service-url:8080/mcp");
        vi.spyOn(
          McpHttpSessionModel,
          "findRecordByConnectionKey",
        ).mockResolvedValueOnce({
          sessionId: "stored-session-id",
          sessionEndpointUrl: "http://10.42.1.88:8080/mcp",
          sessionEndpointPodName: "mcp-stale-session-server-abc123",
        });

        mockConnect.mockResolvedValue(undefined);
        mockCallTool.mockResolvedValue({
          content: [{ type: "text", text: "ok" }],
          isError: false,
        });

        const result = await mcpClient.executeToolCall(
          {
            id: "call_stored_endpoint",
            name: "stale-session-server__stored_endpoint",
            arguments: {},
          },
          agentId,
          undefined,
          { conversationId: "conv-1" },
        );

        expect(result.isError).toBe(false);
        expect(vi.mocked(StreamableHTTPClientTransport)).toHaveBeenCalledWith(
          new URL("http://10.42.1.88:8080/mcp"),
          expect.objectContaining({ sessionId: "stored-session-id" }),
        );
      });

      test("retries with fresh session when stale session is detected", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "stale-session-server__test_tool",
          description: "Test tool",
          parameters: {},
          catalogId: localCatalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: localMcpServerId,
        });

        mockUsesStreamableHttp.mockResolvedValue(true);
        mockGetHttpEndpointUrl.mockReturnValue("http://localhost:30123/mcp");

        // First call: findRecordByConnectionKey returns a stored session
        // Second call (retry): findRecordByConnectionKey returns null (session was deleted)
        vi.spyOn(McpHttpSessionModel, "findRecordByConnectionKey")
          .mockResolvedValueOnce({
            sessionId: "stale-session-id",
            sessionEndpointUrl: null,
            sessionEndpointPodName: null,
          })
          .mockResolvedValueOnce(null);

        // First connect fails (stale session), second connect succeeds
        mockConnect
          .mockRejectedValueOnce(new Error("Session not found"))
          .mockResolvedValueOnce(undefined);

        mockCallTool.mockResolvedValue({
          content: [{ type: "text", text: "Success after retry" }],
          isError: false,
        });

        const toolCall = {
          id: "call_stale_retry",
          name: "stale-session-server__test_tool",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        // Should succeed after retry
        expect(result).toMatchObject({
          id: "call_stale_retry",
          content: [{ type: "text", text: "Success after retry" }],
          isError: false,
        });

        // deleteStaleSession should have been called
        expect(McpHttpSessionModel.deleteStaleSession).toHaveBeenCalled();

        // connect should have been called twice (first stale, then fresh)
        expect(mockConnect).toHaveBeenCalledTimes(2);
      });

      test("does not retry more than once for stale sessions", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "stale-session-server__no_double_retry",
          description: "Test tool",
          parameters: {},
          catalogId: localCatalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: localMcpServerId,
        });

        mockUsesStreamableHttp.mockResolvedValue(true);
        mockGetHttpEndpointUrl.mockReturnValue("http://localhost:30123/mcp");

        // Both calls return stored session IDs
        vi.spyOn(McpHttpSessionModel, "findRecordByConnectionKey")
          .mockResolvedValueOnce({
            sessionId: "stale-session-1",
            sessionEndpointUrl: null,
            sessionEndpointPodName: null,
          })
          .mockResolvedValueOnce({
            sessionId: "stale-session-2",
            sessionEndpointUrl: null,
            sessionEndpointPodName: null,
          });

        // Both connect attempts fail
        mockConnect
          .mockRejectedValueOnce(new Error("Session not found"))
          .mockRejectedValueOnce(new Error("Session not found again"));

        const toolCall = {
          id: "call_no_double_retry",
          name: "stale-session-server__no_double_retry",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        // Should return error (no infinite retry loop)
        expect(result).toMatchObject({
          id: "call_no_double_retry",
          isError: true,
        });
      });

      test("retries when callTool throws StreamableHTTPError with 'Session not found'", async () => {
        const { StreamableHTTPError } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );

        const tool = await ToolModel.createToolIfNotExists({
          name: "stale-session-server__http_error_retry",
          description: "Test tool",
          parameters: {},
          catalogId: localCatalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: localMcpServerId,
        });

        mockUsesStreamableHttp.mockResolvedValue(true);
        mockGetHttpEndpointUrl.mockReturnValue("http://localhost:30123/mcp");

        // First call: findRecordByConnectionKey returns a stored session
        // Second call (retry): findRecordByConnectionKey returns null (session was deleted)
        vi.spyOn(McpHttpSessionModel, "findRecordByConnectionKey")
          .mockResolvedValueOnce({
            sessionId: "stale-session-id",
            sessionEndpointUrl: null,
            sessionEndpointPodName: null,
          })
          .mockResolvedValueOnce(null);

        // connect() succeeds both times (SDK skips initialization for resumed sessions)
        mockConnect.mockResolvedValue(undefined);

        // First callTool throws StreamableHTTPError "Session not found",
        // second callTool succeeds (after retry with fresh session)
        mockCallTool
          .mockRejectedValueOnce(
            new StreamableHTTPError(
              404,
              "Error POSTing to endpoint: Session not found",
            ),
          )
          .mockResolvedValueOnce({
            content: [{ type: "text", text: "Success after retry" }],
            isError: false,
          });

        const toolCall = {
          id: "call_http_error_retry",
          name: "stale-session-server__http_error_retry",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        // Should succeed after retry
        expect(result).toMatchObject({
          id: "call_http_error_retry",
          content: [{ type: "text", text: "Success after retry" }],
          isError: false,
        });

        // deleteStaleSession should have been called
        expect(McpHttpSessionModel.deleteStaleSession).toHaveBeenCalled();

        // callTool should have been called twice (first stale, then fresh)
        expect(mockCallTool).toHaveBeenCalledTimes(2);
      });
    });

    describe("Tool name casing resolution", () => {
      test("resolves camelCase tool name from remote server", async () => {
        // Create tool with lowercased name (as slugifyName produces)
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__getuserinfo",
          description: "Get user info",
          parameters: { type: "object", properties: {} },
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServerId,
        });

        // Remote server reports tool with camelCase name
        mockListTools.mockResolvedValueOnce({
          tools: [
            { name: "getUserInfo", inputSchema: { type: "object" } },
            { name: "searchIssues", inputSchema: { type: "object" } },
          ],
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "success" }],
          isError: false,
        });

        const toolCall = {
          id: "call_casing_1",
          name: "github-mcp-server__getuserinfo",
          arguments: {},
        };

        await mcpClient.executeToolCall(toolCall, agentId);

        // Verify callTool was called with the original camelCase name
        expect(mockCallTool).toHaveBeenCalledWith({
          name: "getUserInfo",
          arguments: {},
        });
      });

      test("resolves PascalCase tool name from remote server", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__getrepository",
          description: "Get repository",
          parameters: { type: "object", properties: {} },
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServerId,
        });

        // Remote server reports tool with PascalCase name
        mockListTools.mockResolvedValueOnce({
          tools: [{ name: "GetRepository", inputSchema: { type: "object" } }],
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "success" }],
          isError: false,
        });

        const toolCall = {
          id: "call_casing_2",
          name: "github-mcp-server__getrepository",
          arguments: {},
        };

        await mcpClient.executeToolCall(toolCall, agentId);

        expect(mockCallTool).toHaveBeenCalledWith({
          name: "GetRepository",
          arguments: {},
        });
      });

      test("falls back to stripped name when listTools fails", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__sometool",
          description: "Some tool",
          parameters: { type: "object", properties: {} },
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServerId,
        });

        // listTools throws an error
        mockListTools.mockRejectedValueOnce(new Error("Connection timeout"));

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "success" }],
          isError: false,
        });

        const toolCall = {
          id: "call_casing_3",
          name: "github-mcp-server__sometool",
          arguments: {},
        };

        await mcpClient.executeToolCall(toolCall, agentId);

        // Falls back to the lowercased stripped name
        expect(mockCallTool).toHaveBeenCalledWith({
          name: "sometool",
          arguments: {},
        });
      });

      test("falls back to stripped name when tool not in server list", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__missingtool",
          description: "Missing tool",
          parameters: { type: "object", properties: {} },
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServerId,
        });

        // Server returns tools, but not the one we're looking for
        mockListTools.mockResolvedValueOnce({
          tools: [{ name: "otherTool", inputSchema: { type: "object" } }],
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "success" }],
          isError: false,
        });

        const toolCall = {
          id: "call_casing_4",
          name: "github-mcp-server__missingtool",
          arguments: {},
        };

        await mcpClient.executeToolCall(toolCall, agentId);

        // Falls back to stripped name since no match found
        expect(mockCallTool).toHaveBeenCalledWith({
          name: "missingtool",
          arguments: {},
        });
      });

      test("preserves already-correct lowercase tool name", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__search_issues",
          description: "Search issues",
          parameters: { type: "object", properties: {} },
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServerId,
        });

        // Server also uses lowercase (snake_case)
        mockListTools.mockResolvedValueOnce({
          tools: [{ name: "search_issues", inputSchema: { type: "object" } }],
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "success" }],
          isError: false,
        });

        const toolCall = {
          id: "call_casing_5",
          name: "github-mcp-server__search_issues",
          arguments: {},
        };

        await mcpClient.executeToolCall(toolCall, agentId);

        expect(mockCallTool).toHaveBeenCalledWith({
          name: "search_issues",
          arguments: {},
        });
      });
    });

    describe("Tool name suffix fallback", () => {
      test("resolves unprefixed tool name by suffix when no exact match", async () => {
        // Create a tool with the full prefixed name
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__refresh-stats",
          description: "Refresh stats",
          parameters: {},
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServerId,
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "refreshed" }],
          isError: false,
        });

        // Call with unprefixed name (no "__") — triggers suffix fallback
        const toolCall = {
          id: "call_suffix_1",
          name: "refresh-stats",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        expect(result.isError).toBe(false);
        // The tool name should be rewritten to the full prefixed name
        expect(result.name).toBe("github-mcp-server__refresh-stats");
      });

      test("does not use suffix fallback when name contains separator", async () => {
        // Tool call with "__" in the name should NOT trigger suffix fallback
        const toolCall = {
          id: "call_suffix_2",
          name: "wrong-server__nonexistent-tool",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        expect(result.isError).toBe(true);
        expect(result.error).toContain("Tool not found");
      });
    });

    describe("_meta and structuredContent passthrough", () => {
      test("passes _meta from callTool result into CommonToolResult", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__meta_tool",
          description: "Tool with meta",
          parameters: {},
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServerId,
        });

        const toolMeta = { ui: { resourceUri: "mcp://widget/stats" } };
        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "result" }],
          isError: false,
          _meta: toolMeta,
        });

        const toolCall = {
          id: "call_meta_1",
          name: "github-mcp-server__meta_tool",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        expect(result.isError).toBe(false);
        expect(result._meta).toEqual(toolMeta);
      });

      test("passes structuredContent from callTool result into CommonToolResult", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__structured_tool",
          description: "Tool with structured content",
          parameters: {},
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServerId,
        });

        const structured = { dashboard: { widgets: ["chart", "table"] } };
        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "ok" }],
          isError: false,
          structuredContent: structured,
        });

        const toolCall = {
          id: "call_structured_1",
          name: "github-mcp-server__structured_tool",
          arguments: {},
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId);

        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual(structured);
      });
    });
  });
});

function createJwt(payload: Record<string, unknown>): string {
  return [
    base64UrlEncode({ alg: "none", typ: "JWT" }),
    base64UrlEncode(payload),
    "",
  ].join(".");
}

function base64UrlEncode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function futureExpSeconds(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}
