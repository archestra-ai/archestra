import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { vi } from "vitest";
import { TeamTokenModel } from "@/models";
import { describe, expect, test } from "@/test";
import * as chatClient from "./chat-mcp-client";

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

    // Check that second call returns the same cached tools (by value)
    // Note: With cacheManager, object identity may differ but values should match
    expect(second).toEqual(first);
    expect(Object.keys(second)).toEqual(["lookup_email"]);
    // Most importantly, listTools should only be called once due to caching
    expect(mockClient.listTools).toHaveBeenCalledTimes(1);

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache(cacheKey);
  });
});
