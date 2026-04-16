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
import * as oauthRoutes from "@/routes/oauth";
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
    await mcpClient.disconnectAll();

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

  test("invalidateConnectionsForServer closes cached active connections for the server", async () => {
    const tool = await ToolModel.createToolIfNotExists({
      name: "github-mcp-server__list_repos",
      description: "List repos",
      parameters: {},
      catalogId,
    });

    await AgentToolModel.create(agentId, tool.id, {
      mcpServerId,
    });

    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });

    await mcpClient.executeToolCall(
      {
        id: "call_invalidate_connection",
        name: "github-mcp-server__list_repos",
        arguments: {},
      },
      agentId,
    );

    expect(mockConnect).toHaveBeenCalledTimes(1);

    await mcpClient.invalidateConnectionsForServer(mcpServerId);

    expect(mockClose).toHaveBeenCalled();
    expect(McpHttpSessionModel.deleteStaleSession).toHaveBeenCalled();

    mockConnect.mockClear();

    await mcpClient.executeToolCall(
      {
        id: "call_invalidate_connection_after",
        name: "github-mcp-server__list_repos",
        arguments: {},
      },
      agentId,
    );

    expect(mockConnect).toHaveBeenCalledTimes(1);
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

      test("reloads cached secrets after server credentials are re-authenticated", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__rotated_secret",
          description: "Rotated secret tool",
          parameters: {},
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId,
          credentialResolutionMode: "static",
        });

        mockCallTool.mockResolvedValue({
          content: [{ type: "text", text: "ok" }],
          isError: false,
        });

        const getSecretSpy = vi.spyOn(secretManager(), "getSecret");
        const toolCall = {
          id: "call_rotated_secret",
          name: tool.name,
          arguments: {},
        };

        const firstResult = await mcpClient.executeToolCall(toolCall, agentId);
        expect(firstResult.isError).toBe(false);
        expect(getSecretSpy).toHaveBeenCalledTimes(1);

        const rotatedSecret = await secretManager().createSecret(
          { access_token: "fresh-github-token-456" },
          "rotatedmcptoken",
        );
        await McpServerModel.update(mcpServerId, {
          secretId: rotatedSecret.id,
        });

        const secondResult = await mcpClient.executeToolCall(toolCall, agentId);
        expect(secondResult.isError).toBe(false);
        expect(getSecretSpy).toHaveBeenCalledTimes(2);

        getSecretSpy.mockRestore();
      });
    });

    test("expires idle active connections and recreates them on the next tool call", async () => {
      vi.useFakeTimers();

      try {
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__ttl_reconnect",
          description: "TTL reconnect test",
          parameters: {},
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId,
          credentialResolutionMode: "static",
        });

        mockConnect.mockResolvedValue(undefined);
        mockPing.mockResolvedValue(undefined);
        mockCallTool.mockResolvedValue({
          content: [{ type: "text", text: "ok" }],
          isError: false,
        });

        const toolCall = {
          id: "call_ttl_reconnect",
          name: tool.name,
          arguments: {},
        };

        const firstResult = await mcpClient.executeToolCall(toolCall, agentId);
        expect(firstResult.isError).toBe(false);
        expect(mockConnect).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);

        const secondResult = await mcpClient.executeToolCall(toolCall, agentId);
        expect(secondResult.isError).toBe(false);

        expect(mockConnect).toHaveBeenCalledTimes(2);
        expect(mockClose).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    test("recreates cached client after server credentials change", async () => {
      const tool = await ToolModel.createToolIfNotExists({
        name: "github-mcp-server__reauth_reconnect",
        description: "Reconnect after reauth",
        parameters: {},
        catalogId,
      });

      await AgentToolModel.create(agentId, tool.id, {
        mcpServerId,
        credentialResolutionMode: "static",
      });

      mockConnect.mockResolvedValue(undefined);
      mockPing.mockResolvedValue(undefined);
      mockCallTool.mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      });

      const toolCall = {
        id: "call_reauth_reconnect",
        name: tool.name,
        arguments: {},
      };

      const firstResult = await mcpClient.executeToolCall(toolCall, agentId);
      expect(firstResult.isError).toBe(false);
      expect(mockConnect).toHaveBeenCalledTimes(1);

      const rotatedSecret = await secretManager().createSecret(
        { access_token: "fresh-github-token-789" },
        "reauthreconnecttoken",
      );
      await McpServerModel.update(mcpServerId, { secretId: rotatedSecret.id });

      const secondResult = await mcpClient.executeToolCall(toolCall, agentId);
      expect(secondResult.isError).toBe(false);
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledTimes(2);
    });

    test("reuses cached client when MCP server row changes without secret rotation", async () => {
      const tool = await ToolModel.createToolIfNotExists({
        name: "github-mcp-server__metadata_update_reuse",
        description: "Reuse after metadata update",
        parameters: {},
        catalogId,
      });

      await AgentToolModel.create(agentId, tool.id, {
        mcpServerId,
        credentialResolutionMode: "static",
      });

      mockConnect.mockResolvedValue(undefined);
      mockPing.mockResolvedValue(undefined);
      mockCallTool.mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      });

      const toolCall = {
        id: "call_metadata_update_reuse",
        name: tool.name,
        arguments: {},
      };

      const firstResult = await mcpClient.executeToolCall(toolCall, agentId);
      expect(firstResult.isError).toBe(false);
      expect(mockConnect).toHaveBeenCalledTimes(1);

      await McpServerModel.update(mcpServerId, {
        oauthRefreshError: "refresh_failed",
      });

      const secondResult = await mcpClient.executeToolCall(toolCall, agentId);
      expect(secondResult.isError).toBe(false);
      expect(mockClose).toHaveBeenCalledTimes(0);
      expect(mockConnect).toHaveBeenCalledTimes(1);
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

      test("returns a config error when a static personal connection belongs to another user", async ({
        makeUser,
      }) => {
        const connectionOwner = await makeUser({
          email: "static-owner@example.com",
        });
        const invokingUser = await makeUser({
          email: "static-invoker@example.com",
        });

        const staticCatalog = await InternalMcpCatalogModel.create({
          name: "githubcopilot__remote-mcp",
          serverType: "remote",
          serverUrl: "https://api.githubcopilot.com/mcp/",
        });

        const ownerSecret = await secretManager().createSecret(
          { access_token: "owner-token" },
          "static-owner-secret",
        );

        const personalServer = await McpServerModel.create({
          name: "githubcopilot__remote-mcp",
          catalogId: staticCatalog.id,
          secretId: ownerSecret.id,
          serverType: "remote",
          ownerId: connectionOwner.id,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "githubcopilot__remote-mcp__issue_write",
          description: "Create an issue",
          parameters: {},
          catalogId: staticCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: personalServer.id,
        });

        const toolCall = {
          id: "call_static_foreign_personal",
          name: "githubcopilot__remote-mcp__issue_write",
          arguments: { title: "Test issue" },
        };

        const result = await mcpClient.executeToolCall(toolCall, agentId, {
          tokenId: "invoker-token",
          teamId: null,
          isOrganizationToken: false,
          userId: invokingUser.id,
        });

        expect(result).toMatchObject({ isError: true });
        expect(result?.error).toContain(
          'Credential assignment unavailable for "githubcopilot__remote-mcp"',
        );
        expect(result?.error).toContain(
          'This tool is pinned to a personal "githubcopilot__remote-mcp" connection that your account cannot access.',
        );
        expect(result?.error).toContain(
          "Ask the agent owner or an admin to update the tool's credential assignment before retrying.",
        );
        expect(result?._meta).toMatchObject({
          archestraError: {
            type: "assigned_credential_unavailable",
            catalogId: staticCatalog.id,
            catalogName: "githubcopilot__remote-mcp",
          },
        });
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
      test("refreshes and retries when an OAuth server returns an auth-related tool error result", async ({
        makeUser,
      }) => {
        const testUser = await makeUser({
          email: "oauth-tool-error-refresh@example.com",
        });

        const oauthCatalog = await InternalMcpCatalogModel.create({
          name: "jira-oauth-server",
          serverType: "remote",
          serverUrl: "https://mcp.atlassian.example.com/mcp/",
          oauthConfig: {
            name: "Jira",
            server_url: "https://mcp.atlassian.example.com/mcp/",
            client_id: "test-client-id",
            redirect_uris: ["http://localhost:3000/callback"],
            scopes: ["read:jira-work"],
            default_scopes: ["read:jira-work"],
            supports_resource_metadata: false,
          },
        });

        const secret = await secretManager().createSecret(
          {
            access_token: "expired-token",
            refresh_token: "refresh-token",
            expires_at: Date.now() + 24 * 3_600_000,
          },
          "jira-oauth-refresh-secret",
        );

        const mcpServer = await McpServerModel.create({
          name: "jira-oauth-server",
          catalogId: oauthCatalog.id,
          secretId: secret.id,
          serverType: "remote",
          ownerId: testUser.id,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "jira-oauth-server__get_issue",
          description: "Get issue",
          parameters: {},
          catalogId: oauthCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServer.id,
        });

        const refreshSpy = vi
          .spyOn(oauthRoutes, "refreshOAuthToken")
          .mockImplementation(async () => {
            await secretManager().updateSecret(secret.id, {
              access_token: "refreshed-token",
              refresh_token: "refresh-token",
              expires_at: Date.now() + 3_600_000,
            });
            return true;
          });

        mockConnect.mockResolvedValue(undefined);
        mockCallTool
          .mockResolvedValueOnce({
            content: [
              {
                type: "text",
                text: "Authentication failed: access token expired",
              },
            ],
            isError: true,
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: "Issue fetched" }],
            isError: false,
          });

        const result = await mcpClient.executeToolCall(
          {
            id: "call_oauth_tool_error_refresh",
            name: "jira-oauth-server__get_issue",
            arguments: { issue_key: "CTAZ-1015" },
          },
          agentId,
          {
            tokenId: "test-token",
            teamId: null,
            isOrganizationToken: false,
            userId: testUser.id,
          },
        );

        expect(refreshSpy).toHaveBeenCalledWith(secret.id, oauthCatalog.id);
        expect(mockCallTool).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
          isError: false,
          content: [{ type: "text", text: "Issue fetched" }],
        });

        refreshSpy.mockRestore();
      });

      test("does not refresh when a tool returns an application-level access denied error", async ({
        makeUser,
      }) => {
        const testUser = await makeUser({
          email: "oauth-tool-error-access-denied@example.com",
        });

        const oauthCatalog = await InternalMcpCatalogModel.create({
          name: "jira-oauth-access-denied-server",
          serverType: "remote",
          serverUrl: "https://mcp.atlassian.example.com/mcp/",
          oauthConfig: {
            name: "Jira",
            server_url: "https://mcp.atlassian.example.com/mcp/",
            client_id: "test-client-id",
            redirect_uris: ["http://localhost:3000/callback"],
            scopes: ["read:jira-work"],
            default_scopes: ["read:jira-work"],
            supports_resource_metadata: false,
          },
        });

        const secret = await secretManager().createSecret(
          {
            access_token: "valid-token",
            refresh_token: "refresh-token",
            expires_at: Date.now() + 24 * 3_600_000,
          },
          "jira-oauth-access-denied-secret",
        );

        const mcpServer = await McpServerModel.create({
          name: "jira-oauth-access-denied-server",
          catalogId: oauthCatalog.id,
          secretId: secret.id,
          serverType: "remote",
          ownerId: testUser.id,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "jira-oauth-access-denied-server__get_issue",
          description: "Get issue",
          parameters: {},
          catalogId: oauthCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServer.id,
        });

        const refreshSpy = vi.spyOn(oauthRoutes, "refreshOAuthToken");

        mockConnect.mockResolvedValue(undefined);
        mockCallTool.mockResolvedValue({
          content: [
            {
              type: "text",
              text: "Access denied: you do not have permission to view this project",
            },
          ],
          isError: true,
        });

        const result = await mcpClient.executeToolCall(
          {
            id: "call_oauth_tool_error_access_denied",
            name: "jira-oauth-access-denied-server__get_issue",
            arguments: { issue_key: "CTAZ-1015" },
          },
          agentId,
          {
            tokenId: "test-token",
            teamId: null,
            isOrganizationToken: false,
            userId: testUser.id,
          },
        );

        expect(refreshSpy).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          isError: true,
          content: [
            {
              type: "text",
              text: "Access denied: you do not have permission to view this project",
            },
          ],
        });

        refreshSpy.mockRestore();
      });

      test("does not refresh when a tool error only mentions bearer auth guidance", async ({
        makeUser,
      }) => {
        const testUser = await makeUser({
          email: "oauth-tool-error-bearer-guidance@example.com",
        });

        const oauthCatalog = await InternalMcpCatalogModel.create({
          name: "jira-oauth-bearer-guidance-server",
          serverType: "remote",
          serverUrl: "https://mcp.atlassian.example.com/mcp/",
          oauthConfig: {
            name: "Jira",
            server_url: "https://mcp.atlassian.example.com/mcp/",
            client_id: "test-client-id",
            redirect_uris: ["http://localhost:3000/callback"],
            scopes: ["read:jira-work"],
            default_scopes: ["read:jira-work"],
            supports_resource_metadata: false,
          },
        });

        const secret = await secretManager().createSecret(
          {
            access_token: "valid-token",
            refresh_token: "refresh-token",
            expires_at: Date.now() + 24 * 3_600_000,
          },
          "jira-oauth-bearer-guidance-secret",
        );

        const mcpServer = await McpServerModel.create({
          name: "jira-oauth-bearer-guidance-server",
          catalogId: oauthCatalog.id,
          secretId: secret.id,
          serverType: "remote",
          ownerId: testUser.id,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "jira-oauth-bearer-guidance-server__get_issue",
          description: "Get issue",
          parameters: {},
          catalogId: oauthCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServer.id,
        });

        const refreshSpy = vi.spyOn(oauthRoutes, "refreshOAuthToken");

        mockConnect.mockResolvedValue(undefined);
        mockCallTool.mockResolvedValue({
          content: [
            {
              type: "text",
              text: "This endpoint requires Bearer token authentication. See docs for setup steps.",
            },
          ],
          isError: true,
        });

        const result = await mcpClient.executeToolCall(
          {
            id: "call_oauth_tool_error_bearer_guidance",
            name: "jira-oauth-bearer-guidance-server__get_issue",
            arguments: { issue_key: "CTAZ-1015" },
          },
          agentId,
          {
            tokenId: "test-token",
            teamId: null,
            isOrganizationToken: false,
            userId: testUser.id,
          },
        );

        expect(refreshSpy).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          isError: true,
          content: [
            {
              type: "text",
              text: "This endpoint requires Bearer token authentication. See docs for setup steps.",
            },
          ],
        });

        refreshSpy.mockRestore();
      });

      test("proactively refreshes an OAuth token shortly before expiry", async ({
        makeUser,
      }) => {
        const testUser = await makeUser({
          email: "oauth-proactive-refresh@example.com",
        });

        const oauthCatalog = await InternalMcpCatalogModel.create({
          name: "jira-proactive-server",
          serverType: "remote",
          serverUrl: "https://mcp.atlassian.example.com/mcp/",
          oauthConfig: {
            name: "Jira",
            server_url: "https://mcp.atlassian.example.com/mcp/",
            client_id: "test-client-id",
            redirect_uris: ["http://localhost:3000/callback"],
            scopes: ["read:jira-work"],
            default_scopes: ["read:jira-work"],
            supports_resource_metadata: false,
          },
        });

        const secret = await secretManager().createSecret(
          {
            access_token: "soon-expiring-token",
            refresh_token: "refresh-token",
            expires_at: Date.now() + 30_000,
          },
          "jira-oauth-proactive-secret",
        );

        const mcpServer = await McpServerModel.create({
          name: "jira-proactive-server",
          catalogId: oauthCatalog.id,
          secretId: secret.id,
          serverType: "remote",
          ownerId: testUser.id,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "jira-proactive-server__get_issue",
          description: "Get issue",
          parameters: {},
          catalogId: oauthCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServer.id,
        });

        const refreshSpy = vi
          .spyOn(oauthRoutes, "refreshOAuthToken")
          .mockImplementation(async () => {
            await secretManager().updateSecret(secret.id, {
              access_token: "proactively-refreshed-token",
              refresh_token: "refresh-token",
              expires_at: Date.now() + 3_600_000,
            });
            return true;
          });

        mockConnect.mockResolvedValue(undefined);
        mockCallTool.mockResolvedValue({
          content: [{ type: "text", text: "Issue fetched proactively" }],
          isError: false,
        });

        const result = await mcpClient.executeToolCall(
          {
            id: "call_oauth_proactive_refresh",
            name: "jira-proactive-server__get_issue",
            arguments: { issue_key: "CTAZ-1015" },
          },
          agentId,
          {
            tokenId: "test-token",
            teamId: null,
            isOrganizationToken: false,
            userId: testUser.id,
          },
        );

        expect(refreshSpy).toHaveBeenCalledWith(secret.id, oauthCatalog.id);
        expect(mockCallTool).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
          isError: false,
          content: [{ type: "text", text: "Issue fetched proactively" }],
        });

        refreshSpy.mockRestore();
      });

      test("falls back to the existing token when proactive refresh fails transiently", async ({
        makeUser,
      }) => {
        const testUser = await makeUser({
          email: "oauth-proactive-refresh-fallback@example.com",
        });

        const oauthCatalog = await InternalMcpCatalogModel.create({
          name: "jira-proactive-fallback-server",
          serverType: "remote",
          serverUrl: "https://mcp.atlassian.example.com/mcp/",
          oauthConfig: {
            name: "Jira",
            server_url: "https://mcp.atlassian.example.com/mcp/",
            client_id: "test-client-id",
            redirect_uris: ["http://localhost:3000/callback"],
            scopes: ["read:jira-work"],
            default_scopes: ["read:jira-work"],
            supports_resource_metadata: false,
          },
        });

        const secret = await secretManager().createSecret(
          {
            access_token: "still-valid-token",
            refresh_token: "refresh-token",
            expires_at: Date.now() + 30_000,
          },
          "jira-oauth-proactive-fallback-secret",
        );

        const mcpServer = await McpServerModel.create({
          name: "jira-proactive-fallback-server",
          catalogId: oauthCatalog.id,
          secretId: secret.id,
          serverType: "remote",
          ownerId: testUser.id,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "jira-proactive-fallback-server__get_issue",
          description: "Get issue",
          parameters: {},
          catalogId: oauthCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServer.id,
        });

        const refreshSpy = vi
          .spyOn(oauthRoutes, "refreshOAuthToken")
          .mockResolvedValue(false);

        mockConnect.mockResolvedValue(undefined);
        mockCallTool.mockResolvedValue({
          content: [
            { type: "text", text: "Issue fetched with existing token" },
          ],
          isError: false,
        });

        const result = await mcpClient.executeToolCall(
          {
            id: "call_oauth_proactive_refresh_fallback",
            name: "jira-proactive-fallback-server__get_issue",
            arguments: { issue_key: "CTAZ-1015" },
          },
          agentId,
          {
            tokenId: "test-token",
            teamId: null,
            isOrganizationToken: false,
            userId: testUser.id,
          },
        );

        expect(refreshSpy).toHaveBeenCalledWith(secret.id, oauthCatalog.id);
        expect(mockCallTool).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
          isError: false,
          content: [
            { type: "text", text: "Issue fetched with existing token" },
          ],
        });

        refreshSpy.mockRestore();
      });

      test("deduplicates concurrent proactive refresh attempts for the same OAuth secret", async ({
        makeUser,
      }) => {
        const testUser = await makeUser({
          email: "oauth-concurrent-refresh@example.com",
        });

        const oauthCatalog = await InternalMcpCatalogModel.create({
          name: "jira-concurrent-server",
          serverType: "remote",
          serverUrl: "https://mcp.atlassian.example.com/mcp/",
          oauthConfig: {
            name: "Jira",
            server_url: "https://mcp.atlassian.example.com/mcp/",
            client_id: "test-client-id",
            redirect_uris: ["http://localhost:3000/callback"],
            scopes: ["read:jira-work"],
            default_scopes: ["read:jira-work"],
            supports_resource_metadata: false,
          },
        });

        const secret = await secretManager().createSecret(
          {
            access_token: "initial-token",
            refresh_token: "refresh-token",
            expires_at: Date.now() + 24 * 3_600_000,
          },
          "jira-oauth-concurrent-secret",
        );

        const mcpServer = await McpServerModel.create({
          name: "jira-concurrent-server",
          catalogId: oauthCatalog.id,
          secretId: secret.id,
          serverType: "remote",
          ownerId: testUser.id,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "jira-concurrent-server__get_issue",
          description: "Get issue",
          parameters: {},
          catalogId: oauthCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServer.id,
        });

        mockConnect.mockResolvedValue(undefined);
        mockCallTool.mockResolvedValue({
          content: [{ type: "text", text: "Issue fetched concurrently" }],
          isError: false,
        });

        await mcpClient.executeToolCall(
          {
            id: "call_oauth_concurrent_seed",
            name: "jira-concurrent-server__get_issue",
            arguments: { issue_key: "CTAZ-1014" },
          },
          agentId,
          {
            tokenId: "seed-token",
            teamId: null,
            isOrganizationToken: false,
            userId: testUser.id,
          },
        );

        await secretManager().updateSecret(secret.id, {
          access_token: "soon-expiring-token",
          refresh_token: "refresh-token",
          expires_at: Date.now() + 30_000,
        });
        (
          mcpClient as unknown as {
            secretsCache: { set: (key: string, value: unknown) => void };
          }
        ).secretsCache.set(mcpServer.id, {
          secrets: {
            access_token: "soon-expiring-token",
            refresh_token: "refresh-token",
            expires_at: Date.now() + 30_000,
          },
          secretId: secret.id,
        });

        mockCallTool.mockClear();
        mockClose.mockClear();

        const refreshSpy = vi
          .spyOn(oauthRoutes, "refreshOAuthToken")
          .mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            await secretManager().updateSecret(secret.id, {
              access_token: "concurrently-refreshed-token",
              refresh_token: "rotated-refresh-token",
              expires_at: Date.now() + 3_600_000,
            });
            return true;
          });

        const toolCall = {
          id: "call_oauth_concurrent_refresh",
          name: "jira-concurrent-server__get_issue",
          arguments: { issue_key: "CTAZ-1015" },
        };

        const results = await Promise.all([
          mcpClient.executeToolCall(toolCall, agentId, {
            tokenId: "test-token-1",
            teamId: null,
            isOrganizationToken: false,
            userId: testUser.id,
          }),
          mcpClient.executeToolCall(
            { ...toolCall, id: "call_oauth_concurrent_refresh_2" },
            agentId,
            {
              tokenId: "test-token-2",
              teamId: null,
              isOrganizationToken: false,
              userId: testUser.id,
            },
          ),
          mcpClient.executeToolCall(
            { ...toolCall, id: "call_oauth_concurrent_refresh_3" },
            agentId,
            {
              tokenId: "test-token-3",
              teamId: null,
              isOrganizationToken: false,
              userId: testUser.id,
            },
          ),
        ]);

        expect(refreshSpy).toHaveBeenCalledTimes(1);
        expect(mockClose).toHaveBeenCalledTimes(1);
        for (const result of results) {
          expect(result).toMatchObject({
            isError: false,
            content: [{ type: "text", text: "Issue fetched concurrently" }],
          });
        }

        refreshSpy.mockRestore();
      });

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

      test("returns config error when a team token hits a personal static assignment", async ({
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
          `Credential assignment unavailable for "github-team-oauth-server"`,
        );
        expect(result?.error).toContain(
          'This tool is pinned to a personal "github-team-oauth-server" connection that your account cannot access.',
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

    describe("Credential resolution priority (JWKS auth)", () => {
      test("JWKS auth with upstream credentials uses upstream token, not JWT (remote server)", async () => {
        // The existing setup creates a remote server with access_token: "test-github-token-123"
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__jwks_cred_test",
          description: "Test JWKS credential priority",
          parameters: {},
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServerId,
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "GitHub response" }],
          isError: false,
        });

        const toolCall = {
          id: "call_jwks_cred",
          name: "github-mcp-server__jwks_cred_test",
          arguments: {},
        };

        // Call with JWKS tokenAuth — the gateway has both the JWT and upstream credentials
        await mcpClient.executeToolCall(toolCall, agentId, {
          tokenId: "ext-token",
          teamId: null,
          isOrganizationToken: false,
          isExternalIdp: true,
          rawToken: "keycloak-jwt-should-not-be-forwarded",
          userId: "ext-user-123",
        });

        // Verify the transport was created with the upstream GitHub token, NOT the Keycloak JWT
        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const transportCalls = vi.mocked(StreamableHTTPClientTransport).mock
          .calls;
        expect(transportCalls.length).toBeGreaterThan(0);
        const lastCall = transportCalls[transportCalls.length - 1];
        const headers = lastCall[1]?.requestInit?.headers as Headers;
        expect(headers.get("authorization")).toBe(
          "Bearer test-github-token-123",
        );
      });

      test("JWKS auth without upstream credentials falls back to JWT propagation (remote server)", async () => {
        // Create a remote server WITHOUT credentials
        const noCredCatalog = await InternalMcpCatalogModel.create({
          name: "jwks-echo-server",
          serverType: "remote",
          serverUrl: "https://jwks-echo.example.com/mcp",
        });

        const noCredServer = await McpServerModel.create({
          name: "jwks-echo-server",
          catalogId: noCredCatalog.id,
          serverType: "remote",
          // No secretId — this server has no upstream credentials
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "jwks-echo-server__get_info",
          description: "Get info with JWT passthrough",
          parameters: {},
          catalogId: noCredCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: noCredServer.id,
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "JWT validated" }],
          isError: false,
        });

        const toolCall = {
          id: "call_jwks_passthrough",
          name: "jwks-echo-server__get_info",
          arguments: {},
        };

        await mcpClient.executeToolCall(toolCall, agentId, {
          tokenId: "ext-token",
          teamId: null,
          isOrganizationToken: false,
          isExternalIdp: true,
          rawToken: "keycloak-jwt-for-passthrough",
          userId: "ext-user-456",
        });

        // Verify the transport was created with the Keycloak JWT (fallback)
        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const transportCalls = vi.mocked(StreamableHTTPClientTransport).mock
          .calls;
        expect(transportCalls.length).toBeGreaterThan(0);
        const lastCall = transportCalls[transportCalls.length - 1];
        const headers = lastCall[1]?.requestInit?.headers as Headers;
        expect(headers.get("authorization")).toBe(
          "Bearer keycloak-jwt-for-passthrough",
        );
      });

      test("JWKS auth with raw_access_token uses raw token (remote server)", async () => {
        // Create a server with raw_access_token instead of access_token
        const rawTokenCatalog = await InternalMcpCatalogModel.create({
          name: "raw-token-server",
          serverType: "remote",
          serverUrl: "https://raw-token.example.com/mcp",
        });

        const rawTokenSecret = await secretManager().createSecret(
          { raw_access_token: "Token github_pat_raw_abc123" },
          "raw-token-secret",
        );

        const rawTokenServer = await McpServerModel.create({
          name: "raw-token-server",
          secretId: rawTokenSecret.id,
          catalogId: rawTokenCatalog.id,
          serverType: "remote",
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "raw-token-server__list_items",
          description: "List items with raw token",
          parameters: {},
          catalogId: rawTokenCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: rawTokenServer.id,
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "Raw token response" }],
          isError: false,
        });

        const toolCall = {
          id: "call_jwks_raw",
          name: "raw-token-server__list_items",
          arguments: {},
        };

        await mcpClient.executeToolCall(toolCall, agentId, {
          tokenId: "ext-token",
          teamId: null,
          isOrganizationToken: false,
          isExternalIdp: true,
          rawToken: "keycloak-jwt-should-not-be-used",
          userId: "ext-user-789",
        });

        // Verify raw_access_token was used (not the JWT)
        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const transportCalls = vi.mocked(StreamableHTTPClientTransport).mock
          .calls;
        expect(transportCalls.length).toBeGreaterThan(0);
        const lastCall = transportCalls[transportCalls.length - 1];
        const headers = lastCall[1]?.requestInit?.headers as Headers;
        expect(headers.get("authorization")).toBe(
          "Token github_pat_raw_abc123",
        );
      });

      test("uses a custom header name for static bearer credentials", async () => {
        const customHeaderCatalog = await InternalMcpCatalogModel.create({
          name: "custom-header-server",
          serverType: "remote",
          serverUrl: "https://custom-header.example.com/mcp",
          userConfig: {
            access_token: {
              type: "string",
              title: "Access Token",
              description: "Bearer token",
              required: true,
              sensitive: true,
              headerName: "x-api-key",
            },
          },
        });

        const customHeaderSecret = await secretManager().createSecret(
          { access_token: "header-secret-token" },
          "custom-header-secret",
        );

        const customHeaderServer = await McpServerModel.create({
          name: "custom-header-server",
          secretId: customHeaderSecret.id,
          catalogId: customHeaderCatalog.id,
          serverType: "remote",
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "custom-header-server__list_items",
          description: "List items with custom header auth",
          parameters: {},
          catalogId: customHeaderCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: customHeaderServer.id,
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "Custom header response" }],
          isError: false,
        });

        await mcpClient.executeToolCall(
          {
            id: "call_custom_header_auth",
            name: "custom-header-server__list_items",
            arguments: {},
          },
          agentId,
        );

        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const transportCalls = vi.mocked(StreamableHTTPClientTransport).mock
          .calls;
        const lastCall = transportCalls[transportCalls.length - 1];
        const headers = lastCall[1]?.requestInit?.headers as Headers;
        expect(headers.get("x-api-key")).toBe("header-secret-token");
        expect(headers.get("authorization")).toBeNull();
      });

      test("treats lowercase authorization header names as satisfying the auth fallback", async () => {
        const lowercaseAuthorizationCatalog =
          await InternalMcpCatalogModel.create({
            name: "lowercase-authorization-server",
            serverType: "remote",
            serverUrl: "https://lowercase-authorization.example.com/mcp",
            userConfig: {
              access_token: {
                type: "string",
                title: "Access Token",
                description: "Bearer token",
                required: true,
                sensitive: true,
                headerName: "authorization",
              },
            },
          });

        const lowercaseAuthorizationSecret = await secretManager().createSecret(
          { access_token: "lowercase-auth-token" },
          "lowercase-authorization-secret",
        );

        const lowercaseAuthorizationServer = await McpServerModel.create({
          name: "lowercase-authorization-server",
          secretId: lowercaseAuthorizationSecret.id,
          catalogId: lowercaseAuthorizationCatalog.id,
          serverType: "remote",
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "lowercase-authorization-server__list_items",
          description: "List items with lowercase authorization header",
          parameters: {},
          catalogId: lowercaseAuthorizationCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: lowercaseAuthorizationServer.id,
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "Lowercase authorization response" }],
          isError: false,
        });

        await mcpClient.executeToolCall(
          {
            id: "call_lowercase_authorization",
            name: "lowercase-authorization-server__list_items",
            arguments: {},
          },
          agentId,
        );

        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const transportCalls = vi.mocked(StreamableHTTPClientTransport).mock
          .calls;
        const lastCall = transportCalls[transportCalls.length - 1];
        const headers = lastCall[1]?.requestInit?.headers as Headers;
        expect(headers.get("authorization")).toBe(
          "Bearer lowercase-auth-token",
        );
        expect(Array.from(headers.entries())).toEqual([
          ["authorization", "Bearer lowercase-auth-token"],
        ]);
      });

      test("falls back to Authorization header for legacy bearer credentials without headerName", async () => {
        const legacyBearerCatalog = await InternalMcpCatalogModel.create({
          name: "legacy-bearer-server",
          serverType: "remote",
          serverUrl: "https://legacy-bearer.example.com/mcp",
          userConfig: {
            access_token: {
              type: "string",
              title: "Access Token",
              description: "Bearer token",
              required: true,
              sensitive: true,
            },
          },
        });

        const legacyBearerSecret = await secretManager().createSecret(
          { access_token: "legacy-bearer-token" },
          "legacy-bearer-secret",
        );

        const legacyBearerServer = await McpServerModel.create({
          name: "legacy-bearer-server",
          secretId: legacyBearerSecret.id,
          catalogId: legacyBearerCatalog.id,
          serverType: "remote",
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "legacy-bearer-server__list_items",
          description: "List items with legacy bearer auth",
          parameters: {},
          catalogId: legacyBearerCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: legacyBearerServer.id,
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "Legacy bearer response" }],
          isError: false,
        });

        await mcpClient.executeToolCall(
          {
            id: "call_legacy_bearer_auth",
            name: "legacy-bearer-server__list_items",
            arguments: {},
          },
          agentId,
        );

        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const transportCalls = vi.mocked(StreamableHTTPClientTransport).mock
          .calls;
        const lastCall = transportCalls[transportCalls.length - 1];
        const headers = lastCall[1]?.requestInit?.headers as Headers;
        expect(headers.get("authorization")).toBe("Bearer legacy-bearer-token");
      });

      test("sends additional static headers alongside the auth header", async () => {
        const multiHeaderCatalog = await InternalMcpCatalogModel.create({
          name: "multi-header-server",
          serverType: "remote",
          serverUrl: "https://multi-header.example.com/mcp",
          userConfig: {
            access_token: {
              type: "string",
              title: "Access Token",
              description: "Bearer token",
              required: true,
              sensitive: true,
              headerName: "x-api-key",
            },
            header_x_tenant_id: {
              type: "string",
              title: "x-tenant-id",
              description: "Tenant ID",
              required: true,
              sensitive: true,
              headerName: "x-tenant-id",
            },
          },
        });

        const multiHeaderSecret = await secretManager().createSecret(
          {
            access_token: "header-secret-token",
            header_x_tenant_id: "tenant-42",
          },
          "multi-header-secret",
        );

        const multiHeaderServer = await McpServerModel.create({
          name: "multi-header-server",
          secretId: multiHeaderSecret.id,
          catalogId: multiHeaderCatalog.id,
          serverType: "remote",
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "multi-header-server__get_info",
          description: "Get info with multiple headers",
          parameters: {},
          catalogId: multiHeaderCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: multiHeaderServer.id,
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "Multi header response" }],
          isError: false,
        });

        await mcpClient.executeToolCall(
          {
            id: "call_multi_header_auth",
            name: "multi-header-server__get_info",
            arguments: {},
          },
          agentId,
        );

        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const transportCalls = vi.mocked(StreamableHTTPClientTransport).mock
          .calls;
        const lastCall = transportCalls[transportCalls.length - 1];
        const headers = lastCall[1]?.requestInit?.headers as Headers;
        expect(headers.get("x-api-key")).toBe("header-secret-token");
        expect(headers.get("x-tenant-id")).toBe("tenant-42");
      });

      test("non-JWKS auth (OAuth/Bearer) still uses upstream credentials", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__oauth_cred_test",
          description: "Test OAuth credential behavior",
          parameters: {},
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: mcpServerId,
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "OAuth response" }],
          isError: false,
        });

        const toolCall = {
          id: "call_oauth_cred",
          name: "github-mcp-server__oauth_cred_test",
          arguments: {},
        };

        // Call with standard (non-JWKS) tokenAuth — isExternalIdp is false
        await mcpClient.executeToolCall(toolCall, agentId, {
          tokenId: "user-token",
          teamId: null,
          isOrganizationToken: false,
          isUserToken: true,
          userId: "user-123",
        });

        // Verify upstream credentials are used (unchanged behavior)
        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const transportCalls = vi.mocked(StreamableHTTPClientTransport).mock
          .calls;
        expect(transportCalls.length).toBeGreaterThan(0);
        const lastCall = transportCalls[transportCalls.length - 1];
        const headers = lastCall[1]?.requestInit?.headers as Headers;
        expect(headers.get("authorization")).toBe(
          "Bearer test-github-token-123",
        );
      });

      test("JWKS auth with dynamic credentials resolves server and uses its credentials", async ({
        makeUser,
      }) => {
        const testUser = await makeUser({
          email: "jwks-dynamic@example.com",
        });

        // Create a catalog with dynamic credentials enabled
        const dynCatalog = await InternalMcpCatalogModel.create({
          name: "github-dynamic",
          serverType: "remote",
          serverUrl: "https://api.github.com/mcp",
        });

        // Create a server owned by the test user with credentials
        const dynSecret = await secretManager().createSecret(
          { access_token: "ghp_dynamic_user_token" },
          "github-dynamic-secret",
        );

        await McpServerModel.create({
          name: "github-dynamic",
          catalogId: dynCatalog.id,
          secretId: dynSecret.id,
          serverType: "remote",
          ownerId: testUser.id,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "github-dynamic__list_repos",
          description: "List repos",
          parameters: {},
          catalogId: dynCatalog.id,
        });

        // Enable dynamic credential resolution
        await AgentToolModel.createOrUpdateCredentials(
          agentId,
          tool.id,
          null,
          "dynamic",
        );

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "Dynamic response" }],
          isError: false,
        });

        const toolCall = {
          id: "call_jwks_dynamic",
          name: "github-dynamic__list_repos",
          arguments: {},
        };

        // Call with JWKS tokenAuth, userId matching the server owner
        await mcpClient.executeToolCall(toolCall, agentId, {
          tokenId: "ext-dynamic-token",
          teamId: null,
          isOrganizationToken: false,
          isExternalIdp: true,
          rawToken: "keycloak-jwt-not-for-github",
          userId: testUser.id,
        });

        // Verify the dynamically resolved server credentials were used
        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const transportCalls = vi.mocked(StreamableHTTPClientTransport).mock
          .calls;
        expect(transportCalls.length).toBeGreaterThan(0);
        const lastCall = transportCalls[transportCalls.length - 1];
        const headers = lastCall[1]?.requestInit?.headers as Headers;
        expect(headers.get("authorization")).toBe(
          "Bearer ghp_dynamic_user_token",
        );
      });

      test("JWKS auth with local streamable-http server uses upstream credentials over JWT", async ({
        makeUser,
      }) => {
        const testUser = await makeUser({
          email: "jwks-local@example.com",
        });

        // Create local server with credentials
        const localCatalog = await InternalMcpCatalogModel.create({
          name: "local-github-jwks",
          serverType: "local",
          localConfig: {
            command: "npx",
            arguments: ["github-mcp-server"],
            transportType: "streamable-http",
            httpPort: 3001,
            httpPath: "/mcp",
          },
        });

        const localSecret = await secretManager().createSecret(
          { access_token: "ghp_local_server_token" },
          "local-github-secret",
        );

        const localServer = await McpServerModel.create({
          name: "local-github-jwks",
          catalogId: localCatalog.id,
          secretId: localSecret.id,
          serverType: "local",
          userId: testUser.id,
        });

        const tool = await ToolModel.createToolIfNotExists({
          name: "local-github-jwks__get_repos",
          description: "Get repos",
          parameters: {},
          catalogId: localCatalog.id,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId: localServer.id,
        });

        mockUsesStreamableHttp.mockResolvedValue(true);
        mockGetHttpEndpointUrl.mockReturnValue("http://localhost:30456/mcp");

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "Local GitHub response" }],
          isError: false,
        });

        const toolCall = {
          id: "call_jwks_local",
          name: "local-github-jwks__get_repos",
          arguments: {},
        };

        await mcpClient.executeToolCall(toolCall, agentId, {
          tokenId: "ext-local-token",
          teamId: null,
          isOrganizationToken: false,
          isExternalIdp: true,
          rawToken: "keycloak-jwt-not-for-local",
          userId: "ext-user-local",
        });

        // Verify local server used upstream credentials, not JWT
        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const transportCalls = vi.mocked(StreamableHTTPClientTransport).mock
          .calls;
        expect(transportCalls.length).toBeGreaterThan(0);
        const lastCall = transportCalls[transportCalls.length - 1];
        const headers = lastCall[1]?.requestInit?.headers as Headers;
        expect(headers.get("authorization")).toBe(
          "Bearer ghp_local_server_token",
        );
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

    describe("passthrough headers", () => {
      test("includes passthrough headers in transport for remote servers", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__passthrough_test",
          description: "Passthrough header test",
          parameters: {},
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId,
          credentialResolutionMode: "static",
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "ok" }],
        });

        await mcpClient.executeToolCall(
          {
            id: "call_passthrough_1",
            name: "github-mcp-server__passthrough_test",
            arguments: {},
          },
          agentId,
          {
            tokenId: "tok-1",
            teamId: null,
            isOrganizationToken: true,
            passthroughHeaders: {
              "x-correlation-id": "abc-123",
              "x-tenant-id": "tenant-1",
            },
          },
        );

        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const transportCalls = vi.mocked(StreamableHTTPClientTransport).mock
          .calls;
        expect(transportCalls.length).toBeGreaterThan(0);
        const lastCall = transportCalls[transportCalls.length - 1];
        const headers = lastCall[1]?.requestInit?.headers as Headers;
        expect(headers.get("x-correlation-id")).toBe("abc-123");
        expect(headers.get("x-tenant-id")).toBe("tenant-1");
      });

      test("passthrough headers do not override existing auth headers", async () => {
        const tool = await ToolModel.createToolIfNotExists({
          name: "github-mcp-server__passthrough_no_override",
          description: "Passthrough should not override auth",
          parameters: {},
          catalogId,
        });

        await AgentToolModel.create(agentId, tool.id, {
          mcpServerId,
          credentialResolutionMode: "static",
        });

        mockCallTool.mockResolvedValueOnce({
          content: [{ type: "text", text: "ok" }],
        });

        await mcpClient.executeToolCall(
          {
            id: "call_passthrough_2",
            name: "github-mcp-server__passthrough_no_override",
            arguments: {},
          },
          agentId,
          {
            tokenId: "tok-1",
            teamId: null,
            isOrganizationToken: true,
            passthroughHeaders: {
              authorization: "Bearer malicious-override",
              "x-custom": "allowed",
            },
          },
        );

        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const transportCalls = vi.mocked(StreamableHTTPClientTransport).mock
          .calls;
        expect(transportCalls.length).toBeGreaterThan(0);
        const lastCall = transportCalls[transportCalls.length - 1];
        const headers = lastCall[1]?.requestInit?.headers as Headers;
        // Auth header should be the server's credential, not the passthrough
        expect(headers.get("authorization")).toBe(
          "Bearer test-github-token-123",
        );
        // Custom header should still be included
        expect(headers.get("x-custom")).toBe("allowed");
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
