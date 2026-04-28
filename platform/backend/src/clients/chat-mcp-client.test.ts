import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  getArchestraToolFullName,
  TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
  TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_WHOAMI_SHORT_NAME,
} from "@shared";
import { jsonSchema, type Tool } from "ai";
import { beforeEach, vi } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { TeamTokenModel } from "@/models";
import ToolModel from "@/models/tool";
import { resolveSessionExternalIdpToken } from "@/services/identity-providers/session-token";
import { describe, expect, test } from "@/test";
import * as chatClient from "./chat-mcp-client";
import { mcpToolToModelOutput } from "./chat-mcp-client";
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
    executeToolCall: vi.fn(),
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
  vi.mocked(mcpClient.executeToolCall).mockReset();
  vi.mocked(resolveSessionExternalIdpToken).mockResolvedValue(null);
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
  const { normalizeJsonSchema } = chatClient.__test;

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

      const tools = await chatClient.getChatMcpTools({
        agentName: agent.name,
        agentId: agent.id,
        userId: user.id,
        organizationId: org.id,
        conversationId: "conv-1",
      });

      expect(expiredClient.ping).not.toHaveBeenCalled();
      expect(expiredClient.close).toHaveBeenCalledTimes(1);
      expect(tools).toEqual({});

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

    // getChatMcpTools should detect dead client via ping, discard it,
    // and attempt to create a fresh client (which will fail in test env,
    // resulting in empty tools - but the key behavior is ping was called)
    const tools = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
    });

    // Ping should have been called on the dead client
    expect(deadClient.ping).toHaveBeenCalledTimes(1);
    // close() should have been called to clean up resources before cache removal
    expect(deadClient.close).toHaveBeenCalledTimes(1);
    // listTools should NOT have been called on the dead client
    expect(deadClient.listTools).not.toHaveBeenCalled();
    // Tools will be empty since we can't create a real client in tests
    expect(tools).toEqual({});

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache(cacheKey);
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

      await vi.advanceTimersByTimeAsync(5_000);
      const tools = await toolsPromise;

      expect(hangingClient.ping).toHaveBeenCalledTimes(1);
      expect(hangingClient.close).toHaveBeenCalledTimes(1);
      expect(hangingClient.listTools).not.toHaveBeenCalled();
      expect(tools).toEqual({});

      chatClient.clearChatMcpClient(agent.id);
      await chatClient.__test.clearToolCache(cacheKey);
    } finally {
      vi.useRealTimers();
    }
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
    globalToolPolicy: "permissive" as const,
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
    vi.mocked(mcpClient.executeToolCall).mockResolvedValueOnce(
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

    const result = await chatClient.__test.executeMcpTool(baseCtx);
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
    vi.mocked(mcpClient.executeToolCall).mockResolvedValueOnce(
      mockResult({
        content: [
          { type: "text", text: "Error line 1" },
          { type: "text", text: "Error line 2" },
        ],
      }),
    );

    const result = await chatClient.__test.executeMcpTool(baseCtx);
    expect(result.content).toBe("Error line 1\nError line 2");
  });

  test("falls back to JSON.stringify for non-text content items", async () => {
    vi.mocked(mcpClient.executeToolCall).mockResolvedValueOnce(
      mockResult({
        content: [{ type: "image", data: "base64..." }],
      }),
    );

    const result = await chatClient.__test.executeMcpTool(baseCtx);
    expect(result.content).toBe(
      JSON.stringify({ type: "image", data: "base64..." }),
    );
  });

  test("returns error string when content is not an array", async () => {
    vi.mocked(mcpClient.executeToolCall).mockResolvedValueOnce(
      mockResult({ content: null, error: "Something failed" }),
    );

    const result = await chatClient.__test.executeMcpTool(baseCtx);
    expect(result.content).toBe("Something failed");
  });

  test("returns fallback message when no content and no error", async () => {
    vi.mocked(mcpClient.executeToolCall).mockResolvedValueOnce(
      mockResult({ content: null }),
    );

    const result = await chatClient.__test.executeMcpTool(baseCtx);
    expect(result.content).toBe("Tool execution failed");
  });

  test("preserves structured error metadata for auth-expired tool errors", async () => {
    vi.mocked(mcpClient.executeToolCall).mockResolvedValueOnce(
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

    const result = await chatClient.__test.executeMcpTool(baseCtx);

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

    vi.mocked(mcpClient.executeToolCall).mockResolvedValueOnce({
      id: "call-1",
      name: "test_tool",
      content: [{ type: "text", text: "ARCH_TEST = secret-value" }],
      isError: false,
    } as never);

    await makeTrustedDataPolicy(tool.id, {
      conditions: [],
      action: "mark_as_untrusted",
    });

    const result = await chatClient.__test.executeMcpTool({
      ...baseCtx,
      agentId: agent.id,
      globalToolPolicy: "restrictive",
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
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Chat Run Tool Agent",
    });

    const conversationId = "conversation-1";
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
    vi.mocked(mcpClient.executeToolCall).mockResolvedValueOnce({
      content: [{ type: "text", text: "Sentry organizations" }],
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
        tool_name: "sentry__find_organizations",
        tool_args: {},
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal AI SDK execution context for this unit test
      { messages: [] } as any,
    );

    expect(result).toBe("Sentry organizations");
    expect(mcpClient.executeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "sentry__find_organizations",
        arguments: {},
      }),
      agent.id,
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

  test("returns empty when enabledToolIds is empty array", async () => {
    const tools = {
      github__list_repos: makeMockTool(),
    };

    const result = await filterToolsByEnabledIds(tools, []);
    expect(Object.keys(result)).toHaveLength(0);
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
  }) => {
    const agent = await makeAgent();

    const mockTools = [
      {
        id: "tool-1",
        name: "server__get-stats",
        description: "Get stats",
        parameters: {},
        meta: { _meta: { ui: { resourceUri: "resource://server/stats-ui" } } },
      },
      {
        id: "tool-2",
        name: "server__get-info",
        description: "Get info",
        parameters: {},
        meta: null, // no UI
      },
      {
        id: "tool-3",
        name: "server__show-chart",
        description: "Show chart",
        parameters: {},
        meta: { _meta: { ui: { resourceUri: "resource://server/chart-ui" } } },
      },
    ];

    const spy = vi
      .spyOn(ToolModel, "getMcpToolsByAgent")
      // biome-ignore lint/suspicious/noExplicitAny: test mock data
      .mockResolvedValueOnce(mockTools as any);

    const result = await chatClient.getChatMcpToolUiResourceUris(agent.id);

    expect(result).toEqual({
      "server__get-stats": "resource://server/stats-ui",
      "server__show-chart": "resource://server/chart-ui",
    });
    expect(result).not.toHaveProperty("server__get-info");

    spy.mockRestore();
  });

  test("returns empty record when no tools have a UI resource URI", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const mockTools = [
      {
        id: "tool-1",
        name: "server__query",
        description: "Query",
        parameters: {},
        meta: { annotations: { audience: ["assistant"] } }, // no _meta.ui
      },
    ];

    const spy = vi
      .spyOn(ToolModel, "getMcpToolsByAgent")
      // biome-ignore lint/suspicious/noExplicitAny: test mock data
      .mockResolvedValueOnce(mockTools as any);

    const result = await chatClient.getChatMcpToolUiResourceUris(agent.id);

    expect(result).toEqual({});

    spy.mockRestore();
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
});

describe("throwIfApprovalRequired", () => {
  const { throwIfApprovalRequired } = chatClient.__test;

  test("does not throw when globalToolPolicy is permissive", async () => {
    await expect(
      throwIfApprovalRequired("some-tool", {}, "permissive"),
    ).resolves.toBeUndefined();
  });

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
      throwIfApprovalRequired("allowed-tool", {}, "restrictive"),
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
      throwIfApprovalRequired("restricted-tool", {}, "restrictive"),
    ).rejects.toThrow(TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON);
  });

  test("does not throw when tool is not found in DB", async () => {
    await expect(
      throwIfApprovalRequired("nonexistent-tool", {}, "restrictive"),
    ).resolves.toBeUndefined();
  });
});
