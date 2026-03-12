import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME } from "@shared";
import { jsonSchema, type Tool } from "ai";
import { vi } from "vitest";
import { TeamTokenModel } from "@/models";
import { describe, expect, test } from "@/test";
import * as chatClient from "./chat-mcp-client";
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
      userIsAgentAdmin: false,
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
});

describe("executeMcpTool error handling", () => {
  const baseCtx = {
    toolName: "test_tool",
    toolArguments: {},
    agentId: "agent-1",
    agentName: "Test Agent",
    userId: "user-1",
    organizationId: "org-1",
    userIsAgentAdmin: false,
    mcpGwToken: null,
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
      }),
    );

    const result = await chatClient.__test.executeMcpTool(baseCtx);
    expect(result).toBe("Auth required: install the server");
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
    expect(result).toBe("Error line 1\nError line 2");
  });

  test("falls back to JSON.stringify for non-text content items", async () => {
    vi.mocked(mcpClient.executeToolCall).mockResolvedValueOnce(
      mockResult({
        content: [{ type: "image", data: "base64..." }],
      }),
    );

    const result = await chatClient.__test.executeMcpTool(baseCtx);
    expect(result).toBe(JSON.stringify({ type: "image", data: "base64..." }));
  });

  test("returns error string when content is not an array", async () => {
    vi.mocked(mcpClient.executeToolCall).mockResolvedValueOnce(
      mockResult({ content: null, error: "Something failed" }),
    );

    const result = await chatClient.__test.executeMcpTool(baseCtx);
    expect(result).toBe("Something failed");
  });

  test("returns fallback message when no content and no error", async () => {
    vi.mocked(mcpClient.executeToolCall).mockResolvedValueOnce(
      mockResult({ content: null }),
    );

    const result = await chatClient.__test.executeMcpTool(baseCtx);
    expect(result).toBe("Tool execution failed");
  });
});

describe("chat-mcp-client tool caching", () => {
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
      userIsAgentAdmin: false,
    });
    expect(Object.keys(first)).toEqual(["lookup_email"]);

    const second = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      userIsAgentAdmin: false,
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

  test("archestra tools bypass custom selection filtering", async ({
    makeTool,
  }) => {
    // Create a real tool in the DB so getNamesByIds can find it
    const githubTool = await makeTool({ name: "github__list_repos" });

    const tools = {
      github__list_repos: makeMockTool(),
      [TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME]: makeMockTool("Query knowledge"),
      archestra__whoami: makeMockTool("Who am I"),
    };

    // Only enable the github tool — archestra tools should still pass through
    const result = await filterToolsByEnabledIds(tools, [githubTool.id]);

    expect(Object.keys(result)).toContain("github__list_repos");
    expect(Object.keys(result)).toContain(
      TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
    );
    expect(Object.keys(result)).toContain("archestra__whoami");
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
