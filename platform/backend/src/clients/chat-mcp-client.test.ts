import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { vi } from "vitest";
import { TeamTokenModel } from "@/models";
import { describe, expect, test } from "@/test";
import * as chatClient from "./chat-mcp-client";

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
