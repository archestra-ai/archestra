// biome-ignore-all lint/suspicious/noExplicitAny: tests inspect MCP payloads dynamically
import { vi } from "vitest";
import {
  AgentModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpHttpSessionModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
import { beforeEach, describe, expect, test } from "@/test";
import { agentOwner } from "@/types";
import mcpClient from "./mcp-client";

// Mock the MCP SDK (upstream server) — the deep exclusion gate must refuse
// BEFORE any connection/dispatch happens.
const mockCallTool = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTools = vi.fn();
const mockListResources = vi.fn();
const mockListResourceTemplates = vi.fn();
const mockListPrompts = vi.fn();
const mockReadResource = vi.fn();
const mockPing = vi.fn();
const mockSetRequestHandler = vi.fn();
const mockSetNotificationHandler = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(function (this: any) {
    this.connect = mockConnect;
    this.callTool = mockCallTool;
    this.close = mockClose;
    this.listTools = mockListTools;
    this.listResources = mockListResources;
    this.listResourceTemplates = mockListResourceTemplates;
    this.listPrompts = mockListPrompts;
    this.readResource = mockReadResource;
    this.ping = mockPing;
    this.setRequestHandler = mockSetRequestHandler;
    this.setNotificationHandler = mockSetNotificationHandler;
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

const TOOL_NAME = "github-mcp-server__list_repos";
const RESOURCE_URI = "ui://github-mcp-server/view.html";
const SIBLING_TOOL_NAME = "github-mcp-server__list_issues";
const SIBLING_RESOURCE_URI = "ui://github-mcp-server/sibling.html";

describe("McpClient Auto-tool-mode exclusions", () => {
  let agentId: string;
  let organizationId: string;
  let catalogId: string;
  let toolId: string;
  let mcpServerId: string;

  beforeEach(async ({ makeOrganization }) => {
    await mcpClient.disconnectAll();
    vi.clearAllMocks();

    const org = await makeOrganization();
    organizationId = org.id;

    const agent = await AgentModel.create({
      name: "Exclusions Agent",
      organizationId,
      scope: "org",
      teams: [],
      accessAllTools: true,
    });
    agentId = agent.id;

    const secret = await secretManager().createSecret(
      { access_token: "test-github-token-123" },
      "testmcptoken",
    );
    // No organizationId on the catalog: org-less (global) catalogs are valid
    // exclusion targets for any org (the service treats them as in-org).
    const catalogItem = await InternalMcpCatalogModel.create({
      name: "github-mcp-server",
      serverType: "remote",
      serverUrl: "https://api.githubcopilot.com/mcp/",
    });
    catalogId = catalogItem.id;
    const mcpServer = await McpServerModel.create({
      name: "github-mcp-server",
      secretId: secret.id,
      catalogId,
      serverType: "remote",
    });
    mcpServerId = mcpServer.id;

    const tool = await ToolModel.createToolIfNotExists({
      name: TOOL_NAME,
      description: "List repos",
      parameters: {},
      catalogId,
      meta: { _meta: { ui: { resourceUri: RESOURCE_URI } } },
    });
    toolId = tool.id;
    await AgentToolModel.create(agentId, tool.id, {
      mcpServerId: mcpServer.id,
    });

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

    mockListTools.mockResolvedValue({ tools: [] });
    mockListResources.mockResolvedValue({ resources: [] });
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
  });

  test("executeToolCallForOwner refuses an excluded assigned tool before any dispatch", async () => {
    // Control: executes normally in Custom mode (proves the dispatch plumbing
    // works, so the later refusal is attributable to the exclusion gate).
    await AgentModel.update(agentId, { accessAllTools: false });
    const before = await mcpClient.executeToolCallForOwner(
      { id: "call_1", name: TOOL_NAME, arguments: {} },
      agentOwner(agentId),
    );
    expect(before.isError ?? false).toBe(false);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    mockCallTool.mockClear();
    mockConnect.mockClear();

    await AgentModel.update(agentId, { accessAllTools: true });
    await agentToolExclusionsService.replaceExclusions({
      agentId,
      organizationId,
      excludedToolIds: [toolId],
    });

    // The refusal is the deep gate: even a caller holding a stale cached tool
    // wrapper (chat) executes through here and must be refused.
    const result = await mcpClient.executeToolCallForOwner(
      { id: "call_2", name: TOOL_NAME, arguments: {} },
      agentOwner(agentId),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      `No tool named \\"${TOOL_NAME}\\" is available to this agent`,
    );
    expect(mockCallTool).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  test("an excluded assigned tool yields precedence to a non-excluded same-named tool from another catalog", async () => {
    // Tool names are unique only per catalog. Catalog B has an identically
    // named tool the agent can reach dynamically; only catalog A's ASSIGNED
    // copy is excluded.
    const secretB = await secretManager().createSecret(
      { access_token: "mirror-token" },
      "mirrortoken",
    );
    const catalogB = await InternalMcpCatalogModel.create({
      name: "github-mirror",
      serverType: "remote",
      serverUrl: "https://mirror.example/mcp/",
    });
    await McpServerModel.create({
      name: "github-mirror",
      secretId: secretB.id,
      catalogId: catalogB.id,
      serverType: "remote",
    });
    const toolB = await ToolModel.createToolIfNotExists({
      name: TOOL_NAME,
      description: "List repos (mirror)",
      parameters: {},
      catalogId: catalogB.id,
    });

    await agentToolExclusionsService.replaceExclusions({
      agentId,
      organizationId,
      excludedToolIds: [toolId],
    });

    // The dispatcher resolved catalog B's non-excluded row (search_tools /
    // run_tool advertise it). Execution must resolve to that row instead of
    // letting the excluded catalog-A assignment hijack the name and refuse the
    // call as "unavailable" — the resolved row moves on to credential
    // resolution (which fails here for lack of a token, a DIFFERENT error).
    const result = await mcpClient.executeToolCallForOwner(
      { id: "call_cross", name: TOOL_NAME, arguments: {} },
      agentOwner(agentId),
      undefined,
      { availableTool: toolB as any },
    );
    expect(JSON.stringify(result.content)).not.toContain(
      "is available to this agent",
    );
  });

  test("exclusions are inert when accessAllTools is off (Custom mode untouched)", async () => {
    await agentToolExclusionsService.replaceExclusions({
      agentId,
      organizationId,
      excludedToolIds: [toolId],
    });
    await AgentModel.update(agentId, { accessAllTools: false });

    const result = await mcpClient.executeToolCallForOwner(
      { id: "call_4", name: TOOL_NAME, arguments: {} },
      agentOwner(agentId),
    );
    expect(result.isError ?? false).toBe(false);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  test("readResource refuses a previously CACHED resource from a newly excluded tool", async () => {
    const cachedResult = {
      contents: [{ uri: RESOURCE_URI, text: "<html>cached</html>" }],
    };
    const cacheKey = `${agentId}:anonymous:${RESOURCE_URI}`;
    const resourceCache = (
      mcpClient as unknown as {
        resourceCache: {
          set(key: string, value: { result: unknown; ttl: number }): void;
        };
      }
    ).resourceCache;
    resourceCache.set(cacheKey, {
      result: cachedResult,
      ttl: Date.now() + 60_000,
    });

    // Control: cache hit is served while nothing is excluded
    const before = await mcpClient.readResource(RESOURCE_URI, agentId);
    expect(before).toEqual(cachedResult);

    await agentToolExclusionsService.replaceExclusions({
      agentId,
      organizationId,
      excludedToolIds: [toolId],
    });

    // The exclusion check runs BEFORE the cache returns: the cached content
    // of the now-excluded tool must not be served.
    await expect(mcpClient.readResource(RESOURCE_URI, agentId)).rejects.toThrow(
      /Resource not found or no server could read it/,
    );
  });

  test("resources/list and templates omit an excluded tool's resources while keeping a non-excluded sibling's", async () => {
    // A second, non-excluded tool keeps the catalog (and its upstream client)
    // reachable — the leak this pins is resources attributable to the
    // EXCLUDED tool still being listed through that surviving client.
    const sibling = await ToolModel.createToolIfNotExists({
      name: SIBLING_TOOL_NAME,
      description: "List issues",
      parameters: {},
      catalogId,
      meta: { _meta: { ui: { resourceUri: SIBLING_RESOURCE_URI } } },
    });
    await AgentToolModel.create(agentId, sibling.id, { mcpServerId });

    mockListResources.mockResolvedValue({
      resources: [
        { uri: RESOURCE_URI, name: "excluded view" },
        { uri: SIBLING_RESOURCE_URI, name: "sibling view" },
      ],
    });
    mockListResourceTemplates.mockResolvedValue({
      resourceTemplates: [
        { uriTemplate: RESOURCE_URI, name: "excluded template" },
        { uriTemplate: SIBLING_RESOURCE_URI, name: "sibling template" },
      ],
    });

    // Control: both tools' resources are listed before any exclusion
    const before = await mcpClient.listResources(agentId);
    expect(before.resources.map((resource) => resource.uri).sort()).toEqual(
      [RESOURCE_URI, SIBLING_RESOURCE_URI].sort(),
    );

    await agentToolExclusionsService.replaceExclusions({
      agentId,
      organizationId,
      excludedToolIds: [toolId],
    });

    const resources = await mcpClient.listResources(agentId);
    expect(resources.resources.map((resource) => resource.uri)).toEqual([
      SIBLING_RESOURCE_URI,
    ]);

    const templates = await mcpClient.listResourceTemplates(agentId);
    expect(
      templates.resourceTemplates.map((template) => template.uriTemplate),
    ).toEqual([SIBLING_RESOURCE_URI]);
  });

  test("getChatMcpToolUiResourceUris omits excluded tools' UI hints", async () => {
    const { getChatMcpToolUiResourceUris } = await import("./chat-mcp-client");

    const before = await getChatMcpToolUiResourceUris(agentId);
    expect(before[TOOL_NAME]).toBe(RESOURCE_URI);

    await agentToolExclusionsService.replaceExclusions({
      agentId,
      organizationId,
      excludedToolIds: [toolId],
    });

    const after = await getChatMcpToolUiResourceUris(agentId);
    expect(after[TOOL_NAME]).toBeUndefined();

    // Inert in Custom mode
    await AgentModel.update(agentId, { accessAllTools: false });
    const custom = await getChatMcpToolUiResourceUris(agentId);
    expect(custom[TOOL_NAME]).toBe(RESOURCE_URI);
  });
});
