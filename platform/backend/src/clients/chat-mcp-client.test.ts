import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { vi } from "vitest";
import { TeamTokenModel } from "@/models";
import { describe, expect, test } from "@/test";
import * as chatClient from "./chat-mcp-client";

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
      userIsProfileAdmin: false,
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
      userIsProfileAdmin: false,
    });
    expect(Object.keys(first)).toEqual(["lookup_email"]);

    const second = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      userIsProfileAdmin: false,
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
