import {
  getArchestraToolFullName,
  TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
  TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_WHOAMI_SHORT_NAME,
} from "@archestra/shared";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchema, type Tool } from "ai";
import { beforeEach, vi } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { AgentModel, TeamTokenModel } from "@/models";
import { resolveSessionExternalIdpToken } from "@/services/identity-providers/session-token";
import { describe, expect, test } from "@/test";
import { agentOwner } from "@/types";
import * as chatClient from "./chat-mcp-client";
import {
  buildArchestraToolOutput,
  mcpToolToModelOutput,
  __test as toolBuilderTest,
} from "./chat-tool-builder";
import mcpClient from "./mcp-client";

const mockConnect = vi.fn().mockRejectedValue(new Error("Connection closed"));
const mockClose = vi.fn();

const createMockClient = () => ({
  connect: mockConnect,
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: mockClose,
  ping: vi.fn(),
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  // biome-ignore lint/complexity/useArrowFunction: mock constructor to satisfy Vitest class warning
  Client: vi.fn(function () {
    return createMockClient();
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

vi.mock("@/clients/mcp-client", () => ({
  default: {
    executeToolCallForOwner: vi.fn(),
    resolveUiAppInstallIdForCaller: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/features/browser-stream/services/browser-stream.feature", () => ({
  browserStreamFeature: {
    isEnabled: vi.fn().mockReturnValue(false),
  },
}));

vi.mock("@/services/identity-providers/session-token", () => ({
  resolveSessionExternalIdpToken: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(mcpClient.executeToolCallForOwner).mockReset();
  vi.mocked(mcpClient.resolveUiAppInstallIdForCaller).mockReset();
  vi.mocked(mcpClient.resolveUiAppInstallIdForCaller).mockResolvedValue(null);
  vi.mocked(resolveSessionExternalIdpToken).mockResolvedValue(null);
  vi.mocked(StreamableHTTPClientTransport).mockClear();
});

describe("isBrowserMcpTool", () => {
  test("returns true for tools containing 'playwright'", () => {
    expect(chatClient.__test.isBrowserMcpTool("mcp-playwright__navigate")).toBe(
      true,
    );
    expect(
      chatClient.__test.isBrowserMcpTool("some_playwright_tool_name"),
    ).toBe(true);
    expect(chatClient.__test.isBrowserMcpTool("playwright")).toBe(true);
  });

  test("returns true for tools starting with 'browser_'", () => {
    expect(chatClient.__test.isBrowserMcpTool("browser_navigate")).toBe(true);
    expect(chatClient.__test.isBrowserMcpTool("browser_take_screenshot")).toBe(
      true,
    );
    expect(chatClient.__test.isBrowserMcpTool("browser_click")).toBe(true);
    expect(chatClient.__test.isBrowserMcpTool("browser_tabs")).toBe(true);
  });

  test("returns false for non-browser tools", () => {
    expect(chatClient.__test.isBrowserMcpTool("lookup_email")).toBe(false);
    expect(chatClient.__test.isBrowserMcpTool("get_weather")).toBe(false);
    expect(chatClient.__test.isBrowserMcpTool("search_database")).toBe(false);
    // Edge case: contains 'browser' but doesn't start with 'browser_'
    expect(chatClient.__test.isBrowserMcpTool("my_browser_helper")).toBe(false);
  });
});

describe("normalizeJsonSchema", () => {
  const { normalizeJsonSchema } = toolBuilderTest;

  test("returns fallback schema for missing/invalid input", () => {
    expect(normalizeJsonSchema(null)).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(normalizeJsonSchema(undefined)).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(normalizeJsonSchema("not-an-object")).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(normalizeJsonSchema([])).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  test("returns fallback schema for invalid type field", () => {
    expect(normalizeJsonSchema({ type: 123 })).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(normalizeJsonSchema({ type: "None" })).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(normalizeJsonSchema({ type: "null" })).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  test("adds additionalProperties: false to simple object schema", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    };
    expect(normalizeJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    });
  });

  test("adds additionalProperties: false to empty object schema", () => {
    const schema = { type: "object", properties: {} };
    expect(normalizeJsonSchema(schema)).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  test("preserves existing additionalProperties value", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: true,
    };
    const result = normalizeJsonSchema(schema);
    expect(result.additionalProperties).toBe(true);
  });

  test("recursively adds additionalProperties: false to nested objects", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        address: {
          type: "object",
          properties: {
            street: { type: "string" },
            city: { type: "string" },
          },
        },
      },
    };
    expect(normalizeJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        address: {
          type: "object",
          properties: {
            street: { type: "string" },
            city: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });
  });

  test("recursively handles array items with object schemas", () => {
    const schema = {
      type: "object",
      properties: {
        labels: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              value: { type: "string" },
            },
            required: ["key", "value"],
          },
        },
      },
    };
    expect(normalizeJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        labels: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              value: { type: "string" },
            },
            required: ["key", "value"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    });
  });

  test("does not modify non-object schemas", () => {
    const schema = { type: "string" };
    expect(normalizeJsonSchema(schema)).toEqual({ type: "string" });
  });

  test("gives untyped nodes an explicit type (Gemini/Vertex rejects untyped schema nodes)", () => {
    // posthog__cohorts-partial-update shape: `query` is zod.unknown().nullable(),
    // which serializes to a bare {} branch that Vertex 400s on — even behind
    // OpenRouter when it routes the model to a Google-hosted deployment.
    const schema = {
      type: "object",
      properties: {
        query: { anyOf: [{}, { type: "null" }] },
        payload: {},
        config: { properties: { a: { type: "string" } } },
        tags: { items: { type: "string" } },
        mode: { enum: ["fast", "slow"] },
        count: { enum: [1, 2] },
        linked: { $ref: "#/$defs/Thing" },
      },
      $defs: { Thing: { type: "string" } },
    };
    expect(normalizeJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        query: {
          anyOf: [
            { type: "object", additionalProperties: true },
            { type: "null" },
          ],
        },
        payload: { type: "object", additionalProperties: true },
        config: {
          type: "object",
          properties: { a: { type: "string" } },
          additionalProperties: false,
        },
        tags: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["fast", "slow"] },
        count: { type: "integer", enum: [1, 2] },
        linked: { $ref: "#/$defs/Thing" },
      },
      $defs: { Thing: { type: "string" } },
      additionalProperties: false,
    });
  });

  test("keeps a bare any-node open instead of clamping it with additionalProperties: false", () => {
    const result = normalizeJsonSchema({
      type: "object",
      properties: { anything: {} },
    });
    expect(
      (result.properties as Record<string, Record<string, unknown>>).anything,
    ).toEqual({ type: "object", additionalProperties: true });
  });

  test("does not mutate the original schema", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
    };
    const original = JSON.parse(JSON.stringify(schema));
    normalizeJsonSchema(schema);
    expect(schema).toEqual(original);
  });
});

describe("chat-mcp-client health check", () => {
  test("expires idle cached conversation clients and closes them on cleanup", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
  }) => {
    vi.useFakeTimers();

    try {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);
      const agent = await makeAgent({ teams: [team.id] });
      await makeTeamMember(team.id, user.id);
      await TeamTokenModel.createTeamToken(team.id, team.name);

      const cacheKey = chatClient.__test.getCacheKey(
        agent.id,
        user.id,
        "conv-1",
      );
      chatClient.clearChatMcpClient(agent.id);
      await chatClient.__test.clearToolCache(cacheKey);

      const expiredClient = {
        ping: vi.fn(),
        listTools: vi.fn(),
        callTool: vi.fn(),
        close: vi.fn(),
      };

      chatClient.__test.setCachedClient(
        cacheKey,
        expiredClient as unknown as Client,
        1_000,
      );

      await vi.advanceTimersByTimeAsync(1_001);

      // The idle client is evicted and closed; the fresh connect then fails in
      // the test env, so the fetch throws rather than streaming with empty tools.
      await expect(
        chatClient.getChatMcpTools({
          agentName: agent.name,
          agentId: agent.id,
          userId: user.id,
          organizationId: org.id,
          conversationId: "conv-1",
        }),
      ).rejects.toBeInstanceOf(chatClient.McpToolsUnavailableError);

      expect(expiredClient.ping).not.toHaveBeenCalled();
      expect(expiredClient.close).toHaveBeenCalledTimes(1);

      chatClient.clearChatMcpClient(agent.id);
      await chatClient.__test.clearToolCache(cacheKey);
    } finally {
      vi.useRealTimers();
    }
  });

  test("discards cached client when ping fails and fetches fresh tools", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ teams: [team.id] });
    await makeTeamMember(team.id, user.id);
    await TeamTokenModel.createTeamToken(team.id, team.name);

    const cacheKey = chatClient.__test.getCacheKey(agent.id, user.id);
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache(cacheKey);

    // Create a mock client with a failing ping (simulates dead connection)
    const deadClient = {
      ping: vi.fn().mockRejectedValue(new Error("Connection closed")),
      listTools: vi.fn(),
      callTool: vi.fn(),
      close: vi.fn(),
    };

    chatClient.__test.setCachedClient(
      cacheKey,
      deadClient as unknown as Client,
    );

    // getChatMcpTools should detect the dead client via ping, discard it, and
    // attempt a fresh client (which fails in the test env). The fetch throws
    // rather than silently returning empty tools.
    await expect(
      chatClient.getChatMcpTools({
        agentName: agent.name,
        agentId: agent.id,
        userId: user.id,
        organizationId: org.id,
      }),
    ).rejects.toBeInstanceOf(chatClient.McpToolsUnavailableError);

    // Ping should have been called on the dead client
    expect(deadClient.ping).toHaveBeenCalledTimes(1);
    // close() should have been called to clean up resources before cache removal
    expect(deadClient.close).toHaveBeenCalledTimes(1);
    // listTools should NOT have been called on the dead client
    expect(deadClient.listTools).not.toHaveBeenCalled();

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache(cacheKey);
  });

  test("skips ping for recently validated cached clients", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ teams: [team.id] });
    await makeTeamMember(team.id, user.id);
    await TeamTokenModel.createTeamToken(team.id, team.name);

    const cacheKey = chatClient.__test.getCacheKey(agent.id, user.id);
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache(cacheKey);

    const cachedClient = {
      ping: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool: vi.fn(),
      close: vi.fn(),
    };

    chatClient.__test.setCachedClient(
      cacheKey,
      cachedClient as unknown as Client,
    );
    chatClient.__test.setCachedClientLastValidatedAt(cacheKey, Date.now());

    const tools = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
    });

    expect(cachedClient.ping).not.toHaveBeenCalled();
    expect(cachedClient.listTools).toHaveBeenCalledTimes(1);
    expect(tools).toEqual({});

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache(cacheKey);
  });

  test("clears the ping timeout timer once ping settles", async () => {
    vi.useFakeTimers();
    try {
      const before = vi.getTimerCount();
      await chatClient.__test.pingClientWithTimeout({
        ping: () => Promise.resolve({}),
      });
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  test("discards cached client when ping hangs past timeout", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
  }) => {
    vi.useFakeTimers();
    try {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);
      const agent = await makeAgent({ teams: [team.id] });
      await makeTeamMember(team.id, user.id);
      await TeamTokenModel.createTeamToken(team.id, team.name);

      const cacheKey = chatClient.__test.getCacheKey(agent.id, user.id);
      chatClient.clearChatMcpClient(agent.id);
      await chatClient.__test.clearToolCache(cacheKey);

      const hangingClient = {
        ping: vi.fn(() => new Promise(() => {})),
        listTools: vi.fn(),
        callTool: vi.fn(),
        close: vi.fn(),
      };

      chatClient.__test.setCachedClient(
        cacheKey,
        hangingClient as unknown as Client,
      );

      const toolsPromise = chatClient.getChatMcpTools({
        agentName: agent.name,
        agentId: agent.id,
        userId: user.id,
        organizationId: org.id,
      });
      // Hold the rejection assertion so the pending promise stays handled while
      // we advance the fake clock past the 5s ping timeout.
      const rejection = expect(toolsPromise).rejects.toBeInstanceOf(
        chatClient.McpToolsUnavailableError,
      );

      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;

      expect(hangingClient.ping).toHaveBeenCalledTimes(1);
      expect(hangingClient.close).toHaveBeenCalledTimes(1);
      expect(hangingClient.listTools).not.toHaveBeenCalled();

      chatClient.clearChatMcpClient(agent.id);
      await chatClient.__test.clearToolCache(cacheKey);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getChatMcpTools failure-vs-empty contract", () => {
  test("returns an empty set (no throw) when the gateway lists zero tools", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
  }) => {
    // A successful fetch that yields no tools is a legitimate state (e.g. a new
    // agent) and must NOT be conflated with a fetch failure.
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ teams: [team.id] });
    await makeTeamMember(team.id, user.id);
    await TeamTokenModel.createTeamToken(team.id, team.name);

    const cacheKey = chatClient.__test.getCacheKey(agent.id, user.id);
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache(cacheKey);

    const emptyClient = {
      ping: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool: vi.fn(),
      close: vi.fn(),
    };
    chatClient.__test.setCachedClient(
      cacheKey,
      emptyClient as unknown as Client,
    );
    chatClient.__test.setCachedClientLastValidatedAt(cacheKey, Date.now());

    const tools = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
    });

    expect(emptyClient.listTools).toHaveBeenCalledTimes(1);
    expect(tools).toEqual({});

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache(cacheKey);
  });
});

describe("executeMcpTool error handling", () => {
  const baseCtx = {
    toolName: "test_tool",
    toolArguments: {},
    agentId: "00000000-0000-4000-8000-000000000001",
    agentName: "Test Agent",
    userId: "00000000-0000-4000-8000-000000000002",
    organizationId: "00000000-0000-4000-8000-000000000003",
    userIsAgentAdmin: false,
    mcpGwToken: null,
    considerContextUntrusted: false,
  };

  const mockResult = (overrides: Record<string, unknown>) => ({
    id: "call-1",
    name: "test_tool",
    content: [],
    isError: true,
    ...overrides,
  });

  test("returns error text from text content array", async () => {
    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce(
      mockResult({
        content: [{ type: "text", text: "Auth required: install the server" }],
        _meta: {
          archestraError: {
            type: "auth_required",
            message: "Auth required: install the server",
            catalogId: "cat_123",
            catalogName: "jwks demo",
            installUrl: "http://localhost:3000/mcp/registry?install=cat_123",
          },
        },
        structuredContent: {
          archestraError: {
            type: "auth_required",
            message: "Auth required: install the server",
            catalogId: "cat_123",
            catalogName: "jwks demo",
            installUrl: "http://localhost:3000/mcp/registry?install=cat_123",
          },
        },
      }),
    );

    const result = await toolBuilderTest.executeMcpTool(baseCtx);
    expect(result.content).toBe("Auth required: install the server");
    expect(result._meta).toMatchObject({
      archestraError: expect.objectContaining({
        type: "auth_required",
        catalogId: "cat_123",
      }),
    });
    expect(result.structuredContent).toMatchObject({
      archestraError: expect.objectContaining({
        type: "auth_required",
        catalogId: "cat_123",
      }),
    });
    expect(result.rawContent).toEqual([
      { type: "text", text: "Auth required: install the server" },
    ]);
  });

  test("joins multiple text content items with newline", async () => {
    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce(
      mockResult({
        content: [
          { type: "text", text: "Error line 1" },
          { type: "text", text: "Error line 2" },
        ],
      }),
    );

    const result = await toolBuilderTest.executeMcpTool(baseCtx);
    expect(result.content).toBe("Error line 1\nError line 2");
  });

  test("falls back to JSON.stringify for non-text content items", async () => {
    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce(
      mockResult({
        content: [{ type: "image", data: "base64..." }],
      }),
    );

    const result = await toolBuilderTest.executeMcpTool(baseCtx);
    expect(result.content).toBe(
      JSON.stringify({ type: "image", data: "base64..." }),
    );
  });

  test("returns error string when content is not an array", async () => {
    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce(
      mockResult({ content: null, error: "Something failed" }),
    );

    const result = await toolBuilderTest.executeMcpTool(baseCtx);
    expect(result.content).toBe("Something failed");
  });

  test("returns fallback message when no content and no error", async () => {
    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce(
      mockResult({ content: null }),
    );

    const result = await toolBuilderTest.executeMcpTool(baseCtx);
    expect(result.content).toBe("Tool execution failed");
  });

  test("preserves structured error metadata for auth-expired tool errors", async () => {
    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce(
      mockResult({
        content: [
          {
            type: "text",
            text: 'Expired or invalid authentication for "id-jag test".',
          },
        ],
        _meta: {
          archestraError: {
            type: "auth_expired",
            message: 'Expired or invalid authentication for "id-jag test".',
            catalogId: "cat_abc",
            catalogName: "id-jag test",
            serverId: "srv_xyz",
            reauthUrl:
              "http://localhost:3000/mcp/registry?reauth=cat_abc&server=srv_xyz",
          },
        },
        structuredContent: {
          archestraError: {
            type: "auth_expired",
            message: 'Expired or invalid authentication for "id-jag test".',
            catalogId: "cat_abc",
            catalogName: "id-jag test",
            serverId: "srv_xyz",
            reauthUrl:
              "http://localhost:3000/mcp/registry?reauth=cat_abc&server=srv_xyz",
          },
        },
      }),
    );

    const result = await toolBuilderTest.executeMcpTool(baseCtx);

    expect(result._meta).toMatchObject({
      archestraError: expect.objectContaining({
        type: "auth_expired",
        serverId: "srv_xyz",
      }),
    });
    expect(result.structuredContent).toMatchObject({
      archestraError: expect.objectContaining({
        type: "auth_expired",
        serverId: "srv_xyz",
      }),
    });
    expect(result.rawContent).toEqual([
      {
        type: "text",
        text: 'Expired or invalid authentication for "id-jag test".',
      },
    ]);
  });

  test("attaches unsafe-context boundary metadata when a tool result is marked untrusted", async ({
    makeAgent,
    makeTool,
    makeTrustedDataPolicy,
  }) => {
    const agent = await makeAgent();
    const tool = await makeTool({ name: "test_tool" });

    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
      id: "call-1",
      name: "test_tool",
      content: [{ type: "text", text: "ARCH_TEST = secret-value" }],
      isError: false,
    } as never);

    await makeTrustedDataPolicy(tool.id, {
      conditions: [],
      action: "mark_as_untrusted",
    });

    const result = await toolBuilderTest.executeMcpTool({
      ...baseCtx,
      agentId: agent.id,
    });

    expect(result.unsafeContextBoundary).toMatchObject({
      kind: "tool_result",
      reason: "tool_result_marked_untrusted",
      toolCallId: expect.any(String),
      toolName: "test_tool",
    });
    expect(result._meta).toMatchObject({
      unsafeContextBoundary: {
        kind: "tool_result",
        reason: "tool_result_marked_untrusted",
        toolCallId: expect.any(String),
        toolName: "test_tool",
      },
    });
  });
});

describe("chat-mcp-client tool caching", () => {
  test("passes token auth context when chat executes archestra run_tool", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
    makeUser,
    makeOrganization,
    makeMember,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Chat Run Tool Agent",
    });
    const catalog = await makeInternalMcpCatalog();
    const targetTool = await makeTool({
      name: "workspace__find_projects",
      catalogId: catalog.id,
    });
    await makeAgentTool(agent.id, targetTool.id);

    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    const conversationId = conversation.id;
    const cacheKey = chatClient.__test.getCacheKey(
      agent.id,
      user.id,
      conversationId,
    );
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();

    const mockClient = {
      ping: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: getArchestraToolFullName("run_tool"),
            description: "Run tool",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string" },
                tool_args: { type: "object" },
              },
              required: ["tool_name"],
            },
          },
        ],
      }),
      callTool: vi.fn(),
      close: vi.fn(),
    };

    chatClient.__test.setCachedClient(
      cacheKey,
      mockClient as unknown as Client,
    );
    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
      content: [{ type: "text", text: "Workspace projects" }],
      isError: false,
    } as never);

    const tools = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      conversationId,
    });

    const runTool = tools[getArchestraToolFullName("run_tool")];
    expect(runTool).toBeDefined();

    const result = await runTool.execute?.(
      {
        tool_name: "workspace__find_projects",
        tool_args: {},
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal AI SDK execution context for this unit test
      { messages: [] } as any,
    );

    expect(result).toBe("Workspace projects");
    expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "workspace__find_projects",
        arguments: {},
      }),
      agentOwner(agent.id),
      expect.objectContaining({
        organizationId: org.id,
        isUserToken: true,
        userId: user.id,
        teamId: null,
        isOrganizationToken: false,
        tokenId: expect.any(String),
      }),
      { conversationId },
    );

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
  });

  test("requests approval for run_tool when the target tool requires approval", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeUser,
    makeOrganization,
    makeMember,
    makeTool,
    makeToolPolicy,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Chat Wrapped Approval Agent",
    });
    const catalog = await makeInternalMcpCatalog();
    const targetTool = await makeTool({
      name: `workspace__export_${crypto.randomUUID().slice(0, 8)}`,
      catalogId: catalog.id,
    });
    await makeAgentTool(agent.id, targetTool.id);
    await makeToolPolicy(targetTool.id, {
      action: "require_approval",
      conditions: [
        { key: "destination", operator: "equal", value: "external" },
      ],
    });

    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    const conversationId = conversation.id;
    const cacheKey = chatClient.__test.getCacheKey(
      agent.id,
      user.id,
      conversationId,
    );
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();

    const mockClient = {
      ping: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: getArchestraToolFullName("run_tool"),
            description: "Run tool",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string" },
                tool_args: { type: "object" },
              },
              required: ["tool_name"],
            },
          },
        ],
      }),
      callTool: vi.fn(),
      close: vi.fn(),
    };

    chatClient.__test.setCachedClient(
      cacheKey,
      mockClient as unknown as Client,
    );

    const tools = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      conversationId,
    });

    const runTool = tools[getArchestraToolFullName("run_tool")];
    expect(typeof runTool.needsApproval).toBe("function");
    const needsApproval = runTool.needsApproval as NonNullable<
      Exclude<typeof runTool.needsApproval, boolean>
    >;
    await expect(
      needsApproval(
        {
          tool_name: targetTool.name,
          tool_args: { destination: "external" },
        },
        // biome-ignore lint/suspicious/noExplicitAny: minimal AI SDK execution context for this unit test
        { messages: [] } as any,
      ),
    ).resolves.toBe(true);

    await expect(
      needsApproval(
        {
          tool_name: targetTool.name,
          tool_args: { destination: "internal" },
        },
        // biome-ignore lint/suspicious/noExplicitAny: minimal AI SDK execution context for this unit test
        { messages: [] } as any,
      ),
    ).resolves.toBe(false);

    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValueOnce({
      content: [{ type: "text", text: "Export queued" }],
      isError: false,
    } as never);
    const result = await runTool.execute?.(
      {
        tool_name: targetTool.name,
        tool_args: { destination: "external" },
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal AI SDK execution context for this unit test
      { messages: [] } as any,
    );

    expect(result).toBe("Export queued");
    expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        name: targetTool.name,
        arguments: { destination: "external" },
      }),
      agentOwner(agent.id),
      expect.anything(),
      { conversationId },
    );

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
  });

  test("reuses cached tool definitions for the same agent and user", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
  }) => {
    // Create real test data using fixtures
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      teams: [team.id],
    });

    // Add user to team as a member
    await makeTeamMember(team.id, user.id);

    // Create team token for the team
    await TeamTokenModel.createTeamToken(team.id, team.name);

    const cacheKey = chatClient.__test.getCacheKey(agent.id, user.id);

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache(cacheKey);

    const mockClient = {
      ping: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: "lookup_email",
            description: "Lookup email",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
      callTool: vi.fn(),
      close: vi.fn(),
    };

    chatClient.__test.setCachedClient(
      cacheKey,
      mockClient as unknown as Client,
    );

    const first = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
    });
    expect(Object.keys(first)).toEqual(["lookup_email"]);

    const second = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
    });

    // Check that second call returns the same tool names
    // Note: With cacheManager, functions and symbols cannot be serialized,
    // so we compare the tool names and descriptions rather than full equality
    expect(Object.keys(second)).toEqual(["lookup_email"]);
    expect(second.lookup_email.description).toEqual(
      first.lookup_email.description,
    );
    // Most importantly, listTools should only be called once due to caching
    expect(mockClient.listTools).toHaveBeenCalledTimes(1);

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache(cacheKey);
  });

  test("empty conversation selection keeps built-in search/run tools and drops user tools", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ teams: [team.id] });
    await makeTeamMember(team.id, user.id);
    await TeamTokenModel.createTeamToken(team.id, team.name);

    const cacheKey = chatClient.__test.getCacheKey(agent.id, user.id);
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache(cacheKey);

    archestraMcpBranding.syncFromOrganization(null);
    const searchToolsName = getArchestraToolFullName("search_tools");
    const runToolName = getArchestraToolFullName("run_tool");

    const mockClient = {
      ping: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: searchToolsName,
            description: "Search tools",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
          {
            name: runToolName,
            description: "Run tool",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string" },
                tool_args: { type: "object" },
              },
              required: ["tool_name"],
            },
          },
          {
            name: "workspace__find_projects",
            description: "Find projects",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
      callTool: vi.fn(),
      close: vi.fn(),
    };

    chatClient.__test.setCachedClient(
      cacheKey,
      mockClient as unknown as Client,
    );

    // A search_and_run_only conversation with zero user-selectable tools enabled
    // resolves to an empty enabledToolIds; the built-in meta tools must survive.
    const tools = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      enabledToolIds: [],
    });

    expect(Object.keys(tools).sort()).toEqual(
      [runToolName, searchToolsName].sort(),
    );
    expect(tools).not.toHaveProperty("workspace__find_projects");

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache(cacheKey);
  });
});

describe("filterToolsByEnabledIds", () => {
  const { filterToolsByEnabledIds } = chatClient.__test;

  const makeMockTool = (description = "test"): Tool => ({
    description,
    inputSchema: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => "ok",
  });

  test("returns all tools when enabledToolIds is undefined (no custom selection)", async () => {
    const tools = {
      github__list_repos: makeMockTool(),
      [TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME]: makeMockTool(),
    };

    const result = await filterToolsByEnabledIds(tools, undefined);
    expect(Object.keys(result)).toHaveLength(2);
  });

  test("empty array retains archestra built-in tools and drops the rest", async () => {
    archestraMcpBranding.syncFromOrganization(null);
    const searchToolsName = getArchestraToolFullName("search_tools");

    const tools = {
      github__list_repos: makeMockTool(),
      [searchToolsName]: makeMockTool("Search tools"),
    };

    // Empty custom selection = zero user-selectable tools enabled. Built-ins
    // (search_tools/run_tool) must still survive so search_and_run_only agents
    // can call tools; only the user-selectable tool is dropped.
    const result = await filterToolsByEnabledIds(tools, []);

    expect(Object.keys(result)).toEqual([searchToolsName]);
  });

  test("white-labeled built-in tools bypass custom selection filtering", async ({
    makeTool,
  }) => {
    // Create a real tool in the DB so getNamesByIds can find it
    const githubTool = await makeTool({ name: "github__list_repos" });
    archestraMcpBranding.syncFromOrganization({
      appName: "Acme Copilot",
      iconLogo: null,
    });
    const brandedWhoami = getArchestraToolFullName(TOOL_WHOAMI_SHORT_NAME, {
      appName: "Acme Copilot",
      fullWhiteLabeling: true,
    });
    const brandedKnowledgeTool = getArchestraToolFullName(
      TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
      {
        appName: "Acme Copilot",
        fullWhiteLabeling: true,
      },
    );

    const tools = {
      github__list_repos: makeMockTool(),
      [brandedKnowledgeTool]: makeMockTool("Query knowledge"),
      [brandedWhoami]: makeMockTool("Who am I"),
    };

    // Only enable the github tool — archestra tools should still pass through
    const result = await filterToolsByEnabledIds(tools, [githubTool.id]);

    expect(Object.keys(result)).toContain("github__list_repos");
    expect(Object.keys(result)).toContain(brandedKnowledgeTool);
    expect(Object.keys(result)).toContain(brandedWhoami);
    expect(Object.keys(result)).toHaveLength(3);
  });

  test("non-archestra tools are filtered when not in custom selection", async ({
    makeTool,
  }) => {
    const githubTool = await makeTool({ name: "github__list_repos" });

    const tools = {
      github__list_repos: makeMockTool(),
      slack__send_message: makeMockTool(),
    };

    // Only enable the github tool
    const result = await filterToolsByEnabledIds(tools, [githubTool.id]);

    expect(Object.keys(result)).toContain("github__list_repos");
    expect(Object.keys(result)).not.toContain("slack__send_message");
  });

  test("empty array returns nothing when there are no built-in tools", async () => {
    archestraMcpBranding.syncFromOrganization(null);
    const tools = {
      github__list_repos: makeMockTool(),
      slack__send_message: makeMockTool(),
    };

    // No archestra built-ins to bypass the selection, so disabling every
    // user-selectable tool genuinely yields an empty set.
    const result = await filterToolsByEnabledIds(tools, []);

    expect(Object.keys(result)).toHaveLength(0);
  });

  test("empty array retains white-labeled built-in tools", async () => {
    archestraMcpBranding.syncFromOrganization({
      appName: "Acme Copilot",
      iconLogo: null,
    });
    const brandedWhoami = getArchestraToolFullName(TOOL_WHOAMI_SHORT_NAME, {
      appName: "Acme Copilot",
      fullWhiteLabeling: true,
    });

    const tools = {
      github__list_repos: makeMockTool(),
      [brandedWhoami]: makeMockTool("Who am I"),
    };

    // The bypass must recognize the white-labeled built-in name under an empty
    // selection too, or white-label deployments lose search/run.
    const result = await filterToolsByEnabledIds(tools, []);

    expect(Object.keys(result)).toEqual([brandedWhoami]);
  });

  test("empty array drops names that carry the archestra prefix but are not real built-ins", async () => {
    archestraMcpBranding.syncFromOrganization(null);
    const searchToolsName = getArchestraToolFullName("search_tools");
    const prefixedNonTool = searchToolsName.replace(
      "search_tools",
      "bogus_not_a_tool",
    );

    const tools = {
      [prefixedNonTool]: makeMockTool("Looks built-in but is not"),
      [searchToolsName]: makeMockTool("Search tools"),
    };

    // isToolName validates the short name against the known set, so a name that
    // merely carries the prefix is treated as user-selectable and filtered out.
    const result = await filterToolsByEnabledIds(tools, []);

    expect(Object.keys(result)).toEqual([searchToolsName]);
  });
});

describe("clearChatMcpClient", () => {
  test("closes and removes all cached clients for an agent", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ teams: [team.id] });
    await makeTeamMember(team.id, user.id);

    const cacheKey = chatClient.__test.getCacheKey(agent.id, user.id);

    const mockClient = {
      ping: vi.fn().mockResolvedValue({}),
      listTools: vi.fn(),
      close: vi.fn(),
    };

    chatClient.__test.setCachedClient(
      cacheKey,
      mockClient as unknown as Client,
    );

    chatClient.clearChatMcpClient(agent.id);

    expect(mockClient.close).toHaveBeenCalledTimes(1);
  });

  test("does not affect clients cached for other agents", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent1 = await makeAgent({ teams: [team.id] });
    const agent2 = await makeAgent({ teams: [team.id] });
    await makeTeamMember(team.id, user.id);

    const cacheKey1 = chatClient.__test.getCacheKey(agent1.id, user.id);
    const cacheKey2 = chatClient.__test.getCacheKey(agent2.id, user.id);

    const mockClient1 = { ping: vi.fn(), listTools: vi.fn(), close: vi.fn() };
    const mockClient2 = { ping: vi.fn(), listTools: vi.fn(), close: vi.fn() };

    chatClient.__test.setCachedClient(
      cacheKey1,
      mockClient1 as unknown as Client,
    );
    chatClient.__test.setCachedClient(
      cacheKey2,
      mockClient2 as unknown as Client,
    );

    // Clear only agent1
    chatClient.clearChatMcpClient(agent1.id);

    expect(mockClient1.close).toHaveBeenCalledTimes(1);
    // agent2's client should not have been closed
    expect(mockClient2.close).not.toHaveBeenCalled();

    // Cleanup
    chatClient.clearChatMcpClient(agent2.id);
  });
});

describe("AgentModel.update evicts cached chat MCP clients", () => {
  // The cached chat MCP connection freezes the agent's advertised tool surface
  // (toolExposureMode / accessAllTools) at build time, so changing that config
  // must evict the connection — otherwise switching an agent to "all tools" /
  // search_and_run_only doesn't expose run_tool/search_tools until the cache is
  // rebuilt for some unrelated reason.
  test("evicts when toolExposureMode changes", async ({
    makeAgent,
    makeUser,
  }) => {
    const user = await makeUser();
    // makeAgent defaults to full mode + accessAllTools=false.
    const agent = await makeAgent();

    const cacheKey = chatClient.__test.getCacheKey(agent.id, user.id);
    const mockClient = { ping: vi.fn(), listTools: vi.fn(), close: vi.fn() };
    chatClient.__test.setCachedClient(
      cacheKey,
      mockClient as unknown as Client,
    );

    await AgentModel.update(agent.id, {
      toolExposureMode: "search_and_run_only",
    });

    expect(mockClient.close).toHaveBeenCalledTimes(1);
  });

  test("evicts when accessAllTools is turned on", async ({
    makeAgent,
    makeUser,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent();

    const cacheKey = chatClient.__test.getCacheKey(agent.id, user.id);
    const mockClient = { ping: vi.fn(), listTools: vi.fn(), close: vi.fn() };
    chatClient.__test.setCachedClient(
      cacheKey,
      mockClient as unknown as Client,
    );

    await AgentModel.update(agent.id, { accessAllTools: true });

    expect(mockClient.close).toHaveBeenCalledTimes(1);
  });

  test("does not evict when an unrelated field changes", async ({
    makeAgent,
    makeUser,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent();

    const cacheKey = chatClient.__test.getCacheKey(agent.id, user.id);
    const mockClient = { ping: vi.fn(), listTools: vi.fn(), close: vi.fn() };
    chatClient.__test.setCachedClient(
      cacheKey,
      mockClient as unknown as Client,
    );

    await AgentModel.update(agent.id, { description: "a new description" });

    expect(mockClient.close).not.toHaveBeenCalled();

    // Cleanup
    chatClient.clearChatMcpClient(agent.id);
  });
});

describe("closeChatMcpClient", () => {
  test("closes the client for a specific conversation and clears its tool cache", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ teams: [team.id] });
    await makeTeamMember(team.id, user.id);
    const conversationId = crypto.randomUUID();

    const cacheKey = chatClient.__test.getCacheKey(
      agent.id,
      user.id,
      conversationId,
    );
    const mockClient = { ping: vi.fn(), listTools: vi.fn(), close: vi.fn() };
    chatClient.__test.setCachedClient(
      cacheKey,
      mockClient as unknown as Client,
    );

    chatClient.closeChatMcpClient(agent.id, user.id, conversationId);

    expect(mockClient.close).toHaveBeenCalledTimes(1);
  });

  test("does not close clients for other conversations", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ teams: [team.id] });
    await makeTeamMember(team.id, user.id);
    const conv1 = crypto.randomUUID();
    const conv2 = crypto.randomUUID();

    const cacheKey1 = chatClient.__test.getCacheKey(agent.id, user.id, conv1);
    const cacheKey2 = chatClient.__test.getCacheKey(agent.id, user.id, conv2);

    const mockClient1 = { ping: vi.fn(), listTools: vi.fn(), close: vi.fn() };
    const mockClient2 = { ping: vi.fn(), listTools: vi.fn(), close: vi.fn() };

    chatClient.__test.setCachedClient(
      cacheKey1,
      mockClient1 as unknown as Client,
    );
    chatClient.__test.setCachedClient(
      cacheKey2,
      mockClient2 as unknown as Client,
    );

    chatClient.closeChatMcpClient(agent.id, user.id, conv1);

    expect(mockClient1.close).toHaveBeenCalledTimes(1);
    expect(mockClient2.close).not.toHaveBeenCalled();

    // Cleanup
    chatClient.clearChatMcpClient(agent.id);
  });
});

describe("getChatMcpToolUiResourceUris", () => {
  test("returns empty record when agent has no tools", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const result = await chatClient.getChatMcpToolUiResourceUris(agent.id);
    expect(result).toEqual({});
  });

  test("returns only tools that have a UI resource URI in meta", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent();
    const catalog = await makeInternalMcpCatalog();

    const statsTool = await makeTool({
      name: "server__get-stats",
      description: "Get stats",
      catalogId: catalog.id,
      meta: { _meta: { ui: { resourceUri: "resource://server/stats-ui" } } },
    });
    const infoTool = await makeTool({
      name: "server__get-info",
      description: "Get info",
      catalogId: catalog.id,
      meta: null,
    });
    const chartTool = await makeTool({
      name: "server__show-chart",
      description: "Show chart",
      catalogId: catalog.id,
      meta: { _meta: { ui: { resourceUri: "resource://server/chart-ui" } } },
    });
    await makeAgentTool(agent.id, statsTool.id);
    await makeAgentTool(agent.id, infoTool.id);
    await makeAgentTool(agent.id, chartTool.id);

    const result = await chatClient.getChatMcpToolUiResourceUris(agent.id);

    expect(result).toEqual({
      "server__get-stats": "resource://server/stats-ui",
      "server__show-chart": "resource://server/chart-ui",
    });
    expect(result).not.toHaveProperty("server__get-info");
  });

  test("returns empty record when no tools have a UI resource URI", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent();
    const catalog = await makeInternalMcpCatalog();

    const queryTool = await makeTool({
      name: "server__query",
      description: "Query",
      catalogId: catalog.id,
      meta: { annotations: { audience: ["assistant"] } }, // no _meta.ui
    });
    await makeAgentTool(agent.id, queryTool.id);

    const result = await chatClient.getChatMcpToolUiResourceUris(agent.id);

    expect(result).toEqual({});
  });
});

describe("fetchToolUiResource", () => {
  beforeEach(() => {
    chatClient.clearUiResourceCache();
  });

  // Use real UUIDs — the client is injected directly into the cache, so no DB
  // access is needed and these IDs are never written to the database.
  const AGENT_ID = "00000000-0000-0000-0000-000000000001";
  const USER_ID = "00000000-0000-0000-0000-000000000002";
  const ORG_ID = "00000000-0000-0000-0000-000000000003";
  const TOOL_NAME = "server__my-tool";
  const URI = "resource://server/my-tool-ui";

  function buildMockClient(readResourceImpl: () => unknown) {
    return {
      connect: vi.fn(),
      close: vi.fn(),
      // ping must resolve (not throw) so getChatMcpClient returns the cached client
      ping: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(),
      callTool: vi.fn(),
      readResource: vi.fn().mockImplementation(readResourceImpl),
    };
  }

  function injectClient(client: ReturnType<typeof buildMockClient>) {
    const cacheKey = chatClient.__test.getCacheKey(AGENT_ID, USER_ID);
    // biome-ignore lint/suspicious/noExplicitAny: test helper injects mock
    chatClient.__test.setCachedClient(cacheKey, client as any);
  }

  test("returns parsed ToolUiResourceData for text content", async () => {
    const mockClient = buildMockClient(() => ({
      contents: [
        {
          text: "<html>hello</html>",
          _meta: {
            ui: {
              csp: { connectDomains: ["https://api.example.com"] },
              permissions: { camera: true },
            },
          },
        },
      ],
    }));
    injectClient(mockClient);

    const result = await chatClient.fetchToolUiResource({
      agentId: AGENT_ID,
      userId: USER_ID,
      organizationId: ORG_ID,
      toolName: TOOL_NAME,
      uri: URI,
    });

    expect(result).toEqual({
      html: "<html>hello</html>",
      csp: { connectDomains: ["https://api.example.com"] },
      permissions: { camera: true },
    });
    expect(mockClient.readResource).toHaveBeenCalledWith({ uri: URI });
  });

  test("returns parsed ToolUiResourceData for base64 blob content", async () => {
    const html = "<html>blob</html>";
    const mockClient = buildMockClient(() => ({
      contents: [{ blob: Buffer.from(html).toString("base64") }],
    }));
    injectClient(mockClient);

    const result = await chatClient.fetchToolUiResource({
      agentId: AGENT_ID,
      userId: USER_ID,
      organizationId: ORG_ID,
      toolName: TOOL_NAME,
      uri: URI,
    });

    expect(result?.html).toBe(html);
  });

  test("returns null when readResource throws", async () => {
    const mockClient = buildMockClient(() => {
      throw new Error("MCP server unreachable");
    });
    injectClient(mockClient);

    const result = await chatClient.fetchToolUiResource({
      agentId: AGENT_ID,
      userId: USER_ID,
      organizationId: ORG_ID,
      toolName: TOOL_NAME,
      uri: URI,
    });

    expect(result).toBeNull();
  });

  test("returns null when contents are empty", async () => {
    const mockClient = buildMockClient(() => ({ contents: [] }));
    injectClient(mockClient);

    const result = await chatClient.fetchToolUiResource({
      agentId: AGENT_ID,
      userId: USER_ID,
      organizationId: ORG_ID,
      toolName: TOOL_NAME,
      uri: URI,
    });

    expect(result).toBeNull();
  });
});

describe("getChatMcpClient", () => {
  test("prefers a session-derived external IdP token over internal gateway tokens", async () => {
    mockConnect.mockReset();
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockReset();
    vi.mocked(resolveSessionExternalIdpToken).mockResolvedValue({
      identityProviderId: crypto.randomUUID(),
      providerId: "okta-chat",
      rawToken: "external-idp-jwt",
    });

    const teamTokenSpy = vi.spyOn(TeamTokenModel, "findAll");

    const agentId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const organizationId = crypto.randomUUID();

    const client = await chatClient.getChatMcpClient(
      agentId,
      userId,
      organizationId,
      undefined,
      "internal-fallback-token",
    );

    expect(client).not.toBeNull();
    expect(teamTokenSpy).not.toHaveBeenCalled();

    const [, options] = vi.mocked(StreamableHTTPClientTransport).mock
      .calls[0] as [URL, { requestInit?: RequestInit }];
    const headers = new Headers(options.requestInit?.headers);
    expect(headers.get("Authorization")).toBe("Bearer external-idp-jwt");
  });

  test("falls back to the internal gateway token when session-derived external IdP auth fails", async () => {
    mockConnect.mockReset();
    mockConnect
      .mockRejectedValueOnce(new Error("Unauthorized"))
      .mockResolvedValueOnce(undefined);
    mockClose.mockReset();
    vi.mocked(resolveSessionExternalIdpToken).mockResolvedValue({
      identityProviderId: crypto.randomUUID(),
      providerId: "okta-chat",
      rawToken: "external-idp-jwt",
    });

    const agentId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const organizationId = crypto.randomUUID();

    const client = await chatClient.getChatMcpClient(
      agentId,
      userId,
      organizationId,
      undefined,
      "internal-fallback-token",
    );

    expect(client).not.toBeNull();
    expect(mockConnect).toHaveBeenCalledTimes(2);

    const authorizationHeaders = vi
      .mocked(StreamableHTTPClientTransport)
      .mock.calls.map(([, options]) =>
        new Headers(
          (options as { requestInit?: RequestInit }).requestInit?.headers,
        ).get("Authorization"),
      );
    expect(authorizationHeaders).toContain("Bearer external-idp-jwt");
    expect(authorizationHeaders).toContain("Bearer internal-fallback-token");
  });

  test("times out a hung connect instead of hanging indefinitely", async () => {
    vi.useFakeTimers();
    try {
      mockConnect.mockReset();
      // Never resolves: simulates a gateway that accepts the socket but stalls.
      mockConnect.mockImplementation(() => new Promise(() => {}));
      mockClose.mockReset();
      vi.mocked(resolveSessionExternalIdpToken).mockResolvedValue(null);

      const clientPromise = chatClient.getChatMcpClient(
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        undefined,
        "internal-token",
      );

      await vi.advanceTimersByTimeAsync(15_000);

      // With resolveSessionExternalIdpToken mocked to null, the passed
      // "internal-token" is the sole (primary) connect token and there is no
      // fallback token to retry — so the timed-out connect yields a null client
      // (which getChatMcpTools turns into a McpToolsUnavailableError).
      expect(await clientPromise).toBeNull();
      expect(mockConnect).toHaveBeenCalledTimes(1);
      // The half-open client is closed on timeout so a late connect can't leak it.
      expect(mockClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      mockConnect.mockReset();
      mockConnect.mockRejectedValue(new Error("Connection closed"));
    }
  });
});

describe("mcpToolToModelOutput", () => {
  test("returns plain string output when input is a string", () => {
    const result = mcpToolToModelOutput({ output: "Hello World" });

    expect(result).toEqual({ type: "text", value: "Hello World" });
  });

  test("extracts content string from rich MCP tool output", () => {
    const result = mcpToolToModelOutput({
      output: {
        content: "Tool executed successfully",
        _meta: { ui: { resourceUri: "resource://server/ui" } },
        structuredContent: { data: [1, 2, 3] },
        rawContent: [{ type: "text", text: "Tool executed successfully" }],
      },
    });

    expect(result).toEqual({
      type: "text",
      value: "Tool executed successfully",
    });
  });

  test("strips _meta, structuredContent, and rawContent from output", () => {
    const richOutput = {
      content: "OK",
      _meta: { ui: { resourceUri: "resource://server/stats-ui" } },
      structuredContent: { stats: { cpu: 80, memory: 60 } },
      rawContent: [
        { type: "text", text: "OK" },
        {
          type: "resource",
          resource: {
            uri: "resource://inline",
            mimeType: "text/html",
            text: "<div>chart</div>",
          },
        },
      ],
    };

    const result = mcpToolToModelOutput({ output: richOutput });

    // Only the plain text content should come through
    expect(result.type).toBe("text");
    expect(result.value).toBe("OK");
    // Verify the result has no UI metadata
    expect(result).not.toHaveProperty("_meta");
    expect(result).not.toHaveProperty("structuredContent");
    expect(result).not.toHaveProperty("rawContent");
  });

  test("handles empty string output", () => {
    const result = mcpToolToModelOutput({ output: "" });

    expect(result).toEqual({ type: "text", value: "" });
  });

  test("handles rich output with empty content string", () => {
    const result = mcpToolToModelOutput({
      output: { content: "" },
    });

    expect(result).toEqual({ type: "text", value: "" });
  });

  test("handles rich output with only content field (no metadata)", () => {
    const result = mcpToolToModelOutput({
      output: { content: "Just text, no metadata" },
    });

    expect(result).toEqual({ type: "text", value: "Just text, no metadata" });
  });

  test("forwards a bounded image block as a media model-output part", () => {
    const result = mcpToolToModelOutput({
      output: {
        content: "App rendered clean.",
        rawContent: [
          { type: "text", text: "App rendered clean." },
          { type: "image", data: "QUJD", mimeType: "image/jpeg" },
        ],
      },
    });

    expect(result).toEqual({
      type: "content",
      value: [
        { type: "text", text: "App rendered clean." },
        { type: "media", data: "QUJD", mediaType: "image/jpeg" },
      ],
    });
  });

  test("drops an oversized image block, keeping the text", () => {
    const result = mcpToolToModelOutput({
      output: {
        content: "App rendered clean.",
        rawContent: [
          {
            type: "image",
            data: "A".repeat(2_000_001),
            mimeType: "image/jpeg",
          },
        ],
      },
    });

    expect(result).toEqual({ type: "text", value: "App rendered clean." });
  });
});

describe("buildArchestraToolOutput", () => {
  const archestraResponse = {
    content: [{ type: "text" as const, text: "Diagram displayed!" }],
    structuredContent: { checkpoint: "abc" },
    _meta: { extra: true },
  };

  test("returns plain text for a direct non-app archestra tool even with structuredContent", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const result = await buildArchestraToolOutput({
      response: archestraResponse,
      toolName: "archestra__whoami",
      toolArguments: {},
      agentId: agent.id,
    });

    expect(result).toBe("Diagram displayed!");
  });

  test("carries an image block as one media part without base64 in the text (end to end)", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const base64 = "QUJDREVG".repeat(4); // valid base64, not a placeholder
    const built = await buildArchestraToolOutput({
      response: {
        content: [
          { type: "text" as const, text: "App rendered clean." },
          { type: "image" as const, data: base64, mimeType: "image/jpeg" },
        ],
        isError: false,
      },
      toolName: "archestra__get_app_diagnostics",
      toolArguments: {},
      agentId: agent.id,
    });

    // the base64 must NOT be stringified into the text summary (it rides
    // rawContent instead, to be stripped from history later)
    expect(built).toMatchObject({ content: "App rendered clean.\n[image]" });
    const richContent = (built as { content: string }).content;
    expect(richContent).not.toContain(base64);

    // and toModelOutput forwards it exactly once, as a media part
    const modelOutput = mcpToolToModelOutput({ output: built });
    expect(modelOutput.type).toBe("content");
    const value = (modelOutput as { value: Array<Record<string, unknown>> })
      .value;
    const media = value.filter((p) => p.type === "media");
    const textParts = value.filter((p) => p.type === "text");
    expect(media).toEqual([
      { type: "media", data: base64, mediaType: "image/jpeg" },
    ]);
    expect(textParts[0].text).not.toContain(base64);
  });

  test("does not re-forward a history-stripped image placeholder as media", () => {
    const modelOutput = mcpToolToModelOutput({
      output: {
        content: "App rendered clean.",
        rawContent: [
          {
            type: "image",
            // what the history image-stripper leaves behind
            data: "[Image data stripped to save context]",
            mimeType: "image/jpeg",
          },
        ],
      },
    });
    expect(modelOutput).toEqual({ type: "text", value: "App rendered clean." });
  });

  test.for([
    "edit_app",
    "render_app",
  ] as const)("returns the rich shape for a direct %s result so chat can mount the app runtime", async (shortName, {
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const appResponse = {
      content: [{ type: "text" as const, text: `Created app "Todo" (app-1).` }],
      structuredContent: { id: "app-1", name: "Todo", latestVersion: 1 },
      isError: false,
    };

    const result = await buildArchestraToolOutput({
      response: appResponse,
      toolName: `archestra__${shortName}`,
      toolArguments: {},
      agentId: agent.id,
    });

    expect(result).toMatchObject({
      content: `Created app "Todo" (app-1).`,
      structuredContent: { id: "app-1" },
      rawContent: appResponse.content,
    });
  });

  // scaffold_app only seeds the boilerplate template, which chat never renders —
  // so its result stays plain text (no structuredContent passthrough).
  test("returns plain text for a direct scaffold_app result", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const result = await buildArchestraToolOutput({
      response: {
        content: [
          { type: "text" as const, text: `Created app "Todo" (app-1).` },
        ],
        structuredContent: { id: "app-1", name: "Todo", latestVersion: 1 },
        isError: false,
      },
      toolName: "archestra__scaffold_app",
      toolArguments: {},
      agentId: agent.id,
    });

    expect(result).toBe(`Created app "Todo" (app-1).`);
  });

  test("returns the rich shape for a run_tool dispatch with a bare edit_app target", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const appResponse = {
      content: [{ type: "text" as const, text: `Edited app "Todo" (app-1).` }],
      structuredContent: { id: "app-1", name: "Todo", latestVersion: 2 },
      isError: false,
    };

    const result = await buildArchestraToolOutput({
      response: appResponse,
      toolName: "archestra__run_tool",
      toolArguments: { tool_name: "edit_app", tool_args: {} },
      agentId: agent.id,
    });

    expect(result).toMatchObject({
      content: `Edited app "Todo" (app-1).`,
      structuredContent: { id: "app-1" },
    });
  });

  test("returns plain text for an app tool error result", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const result = await buildArchestraToolOutput({
      response: {
        content: [
          { type: "text" as const, text: "Error: Authentication required." },
        ],
        isError: true,
      },
      toolName: "archestra__scaffold_app",
      toolArguments: {},
      agentId: agent.id,
    });

    expect(result).toBe("Error: Authentication required.");
  });

  test("returns plain text for list_apps despite structuredContent", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const result = await buildArchestraToolOutput({
      response: {
        content: [{ type: "text" as const, text: "2 apps" }],
        structuredContent: { apps: [] },
        isError: false,
      },
      toolName: "archestra__list_apps",
      toolArguments: {},
      agentId: agent.id,
    });

    expect(result).toBe("2 apps");
  });

  test("attaches the target tool's UI resource when dispatched via run_tool", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent();
    const catalog = await makeInternalMcpCatalog();
    const targetTool = await makeTool({
      name: "excalidraw__create_view",
      catalogId: catalog.id,
      meta: { _meta: { ui: { resourceUri: "ui://excalidraw/mcp-app.html" } } },
    });
    await makeAgentTool(agent.id, targetTool.id);

    const result = await buildArchestraToolOutput({
      response: archestraResponse,
      toolName: "archestra__run_tool",
      toolArguments: {
        tool_name: "excalidraw__create_view",
        tool_args: { elements: "[]" },
      },
      agentId: agent.id,
    });

    expect(typeof result).toBe("object");
    expect(result).toMatchObject({
      content: "Diagram displayed!",
      _meta: {
        extra: true,
        ui: { resourceUri: "ui://excalidraw/mcp-app.html" },
      },
      structuredContent: { checkpoint: "abc" },
    });
  });

  test("does not attach the UI resource when the target tool is not assigned to the agent", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const owner = await makeAgent();
    const catalog = await makeInternalMcpCatalog();
    const targetTool = await makeTool({
      name: "excalidraw__create_view",
      catalogId: catalog.id,
      meta: { _meta: { ui: { resourceUri: "ui://excalidraw/mcp-app.html" } } },
    });
    await makeAgentTool(owner.id, targetTool.id);

    // A different agent without the tool assigned and without dynamic access
    // (accessAllTools defaults off) cannot reach the tool, so no UI resource
    // attaches — the assignment-scoped lookup misses and the dynamic fallback
    // is gated off.
    const otherAgent = await makeAgent();
    const result = await buildArchestraToolOutput({
      response: archestraResponse,
      toolName: "archestra__run_tool",
      toolArguments: {
        tool_name: "excalidraw__create_view",
        tool_args: { elements: "[]" },
      },
      agentId: otherAgent.id,
    });

    expect(result).toBe("Diagram displayed!");
  });

  test("attaches the target tool's UI resource for an unassigned tool reached via dynamic access", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    // "All tools" mode: run_tool dispatches to any tool the user can access
    // without an agent_tools assignment. The UI resource must still attach so
    // the MCP App renders as an iframe instead of a plain tool-call card.
    const agent = await makeAgent({
      organizationId: org.id,
      accessAllTools: true,
    });
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    await makeTool({
      name: "excalidraw__create_view",
      catalogId: catalog.id,
      meta: { _meta: { ui: { resourceUri: "ui://excalidraw/mcp-app.html" } } },
    });
    // The org-scoped install that makes the catalog reachable for the user.
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });

    const result = await buildArchestraToolOutput({
      response: archestraResponse,
      toolName: "archestra__run_tool",
      toolArguments: {
        tool_name: "excalidraw__create_view",
        tool_args: { elements: "[]" },
      },
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
    });

    expect(result).toMatchObject({
      content: "Diagram displayed!",
      _meta: { ui: { resourceUri: "ui://excalidraw/mcp-app.html" } },
    });
  });

  test("stamps the resolved install id onto the dispatched app's UI so callbacks bind to the server", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent();
    const catalog = await makeInternalMcpCatalog();
    const targetTool = await makeTool({
      name: "excalidraw__create_view",
      catalogId: catalog.id,
      meta: { _meta: { ui: { resourceUri: "ui://excalidraw/mcp-app.html" } } },
    });
    await makeAgentTool(agent.id, targetTool.id);
    // The resolver (unit-tested against the DB in mcp-client.test.ts) yields the
    // caller's install; here we assert buildArchestraToolOutput surfaces it on
    // _meta.ui.mcpServerId. Without it the app's SDK callServerTool misroutes to
    // the agent gateway ("No tool named ..."); with it chat mounts callbacks
    // against POST /api/mcp/server/<install>.
    vi.mocked(mcpClient.resolveUiAppInstallIdForCaller).mockResolvedValue(
      "install-123",
    );

    const result = await buildArchestraToolOutput({
      response: archestraResponse,
      toolName: "archestra__run_tool",
      toolArguments: {
        tool_name: "excalidraw__create_view",
        tool_args: { elements: "[]" },
      },
      agentId: agent.id,
    });

    expect(result).toMatchObject({
      _meta: {
        ui: {
          resourceUri: "ui://excalidraw/mcp-app.html",
          mcpServerId: "install-123",
        },
      },
    });
  });

  test("omits mcpServerId when the resolver returns null (owned-app backing / unreachable install)", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent();
    const catalog = await makeInternalMcpCatalog();
    const targetTool = await makeTool({
      name: "excalidraw__create_view",
      catalogId: catalog.id,
      meta: { _meta: { ui: { resourceUri: "ui://excalidraw/mcp-app.html" } } },
    });
    await makeAgentTool(agent.id, targetTool.id);
    // The resolver returns null for owned-app backings (routed by app id via
    // render_app) and when no install is reachable — the UI must render without
    // a spurious server binding.
    vi.mocked(mcpClient.resolveUiAppInstallIdForCaller).mockResolvedValue(null);

    const result = await buildArchestraToolOutput({
      response: archestraResponse,
      toolName: "archestra__run_tool",
      toolArguments: {
        tool_name: "excalidraw__create_view",
        tool_args: { elements: "[]" },
      },
      agentId: agent.id,
    });

    expect(result).toMatchObject({
      _meta: { ui: { resourceUri: "ui://excalidraw/mcp-app.html" } },
    });
    expect(
      (result as unknown as { _meta: { ui: Record<string, unknown> } })._meta
        .ui,
    ).not.toHaveProperty("mcpServerId");
  });

  test("does not attach the UI resource for an all-tools agent when the target tool is not accessible", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      accessAllTools: true,
    });
    // Another organization's catalog: not visible to the user, so the dynamic
    // fallback must not attach its UI resource — the boundary the widening
    // must respect.
    const otherOrg = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({
      organizationId: otherOrg.id,
    });
    await makeTool({
      name: "excalidraw__create_view",
      catalogId: catalog.id,
      meta: { _meta: { ui: { resourceUri: "ui://excalidraw/mcp-app.html" } } },
    });

    const result = await buildArchestraToolOutput({
      response: archestraResponse,
      toolName: "archestra__run_tool",
      toolArguments: {
        tool_name: "excalidraw__create_view",
        tool_args: { elements: "[]" },
      },
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
    });

    expect(result).toBe("Diagram displayed!");
  });

  test("returns plain text when the dispatched target has no UI resource", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent();
    const catalog = await makeInternalMcpCatalog();
    const targetTool = await makeTool({
      name: "context7__search",
      catalogId: catalog.id,
      meta: null,
    });
    await makeAgentTool(agent.id, targetTool.id);

    const result = await buildArchestraToolOutput({
      response: archestraResponse,
      toolName: "archestra__run_tool",
      toolArguments: { tool_name: "context7__search", tool_args: {} },
      agentId: agent.id,
    });

    expect(result).toBe("Diagram displayed!");
  });

  test("preserves a structured auth error (with credential scope) for a run_tool dispatch so chat renders the rich card", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const archestraError = {
      type: "auth_expired" as const,
      message: 'Expired or invalid authentication for "GitHub"',
      catalogId: "cat_1",
      catalogName: "GitHub",
      serverId: "srv_1",
      reauthUrl: "http://localhost:3000/mcp/registry?reauth=cat_1&server=srv_1",
      credentialScope: "team" as const,
      credentialTeamName: "Platform Team",
    };

    const result = await buildArchestraToolOutput({
      response: {
        content: [{ type: "text" as const, text: archestraError.message }],
        isError: true,
        _meta: { archestraError },
        structuredContent: { archestraError },
      },
      toolName: "archestra__run_tool",
      toolArguments: { tool_name: "github__whoami", tool_args: {} },
      agentId: agent.id,
    });

    // Rich shape (not a bare string) so extractMcpToolError finds the structured
    // error and the frontend renders the scoped re-auth card.
    expect(result).toMatchObject({
      content: archestraError.message,
      _meta: {
        archestraError: {
          type: "auth_expired",
          credentialScope: "team",
          credentialTeamName: "Platform Team",
        },
      },
      structuredContent: { archestraError: { type: "auth_expired" } },
    });
  });

  test("still returns plain text for a run_tool dispatch error without a structured Archestra error", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const result = await buildArchestraToolOutput({
      response: {
        content: [{ type: "text" as const, text: "Error: rate limited." }],
        isError: true,
      },
      toolName: "archestra__run_tool",
      toolArguments: { tool_name: "github__whoami", tool_args: {} },
      agentId: agent.id,
    });

    expect(result).toBe("Error: rate limited.");
  });
});

describe("throwIfApprovalRequired", () => {
  const { resolveApprovalPolicyTarget, throwIfApprovalRequired } =
    toolBuilderTest;

  test("does not throw when tool has no require_approval policy", async ({
    makeTool,
    makeToolPolicy,
  }) => {
    const tool = await makeTool({ name: "allowed-tool" });
    await makeToolPolicy(tool.id, {
      action: "allow_when_context_is_untrusted",
      conditions: [],
    });

    await expect(
      throwIfApprovalRequired("allowed-tool", {}),
    ).resolves.toBeUndefined();
  });

  test("throws when tool has require_approval policy", async ({
    makeTool,
    makeToolPolicy,
  }) => {
    const tool = await makeTool({ name: "restricted-tool" });
    await makeToolPolicy(tool.id, {
      action: "require_approval",
      conditions: [],
    });

    await expect(
      throwIfApprovalRequired("restricted-tool", {}),
    ).rejects.toThrow(TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON);
  });

  test("throws for run_tool when target tool requires approval", async ({
    makeTool,
    makeToolPolicy,
  }) => {
    const tool = await makeTool({ name: "wrapped-restricted-tool" });
    await makeToolPolicy(tool.id, {
      action: "require_approval",
      conditions: [
        { key: "destination", operator: "equal", value: "external" },
      ],
    });

    await expect(
      throwIfApprovalRequired(getArchestraToolFullName("run_tool"), {
        tool_name: tool.name,
        tool_args: { destination: "external" },
      }),
    ).rejects.toThrow(TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON);
  });

  test("does not throw when tool is not found in DB", async () => {
    await expect(
      throwIfApprovalRequired("nonexistent-tool", {}),
    ).resolves.toBeUndefined();
  });

  test("resolves approval policy target from run_tool arguments", () => {
    expect(
      resolveApprovalPolicyTarget(getArchestraToolFullName("run_tool"), {
        tool_name: "workspace__export",
        tool_args: { destination: "external" },
      }),
    ).toEqual({
      toolName: "workspace__export",
      toolInput: { destination: "external" },
    });

    expect(
      resolveApprovalPolicyTarget("workspace__export", {
        destination: "external",
      }),
    ).toEqual({
      toolName: "workspace__export",
      toolInput: { destination: "external" },
    });
  });
});
