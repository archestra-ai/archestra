// biome-ignore-all lint/suspicious/noExplicitAny: test

import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { vi } from "vitest";
import {
  ChatApiKeyModel,
  ConversationModel,
  OrganizationModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

describe("chat tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;
  let userId: string;
  let organizationId: string;

  beforeEach(
    async ({
      makeAgent,
      makeUser,
      makeOrganization,
      makeMember,
      makeSecret,
      makeChatApiKey,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      userId = user.id;
      organizationId = org.id;
      const secret = await makeSecret();
      const orgWideApiKey = await makeChatApiKey(organizationId, secret.id, {
        provider: "openai",
      });
      vi.spyOn(ChatApiKeyModel, "findById").mockImplementation(async (id) => {
        if (id === orgWideApiKey.id) {
          return orgWideApiKey;
        }
        return null;
      });
      testAgent = await makeAgent({
        name: "Test Agent",
        agentType: "agent",
        organizationId,
      });
      mockContext = {
        agent: { id: testAgent.id, name: testAgent.name },
        userId,
        organizationId,
      };
    },
  );

  test("todo_write returns error when todos is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}todo_write`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__todo_write",
    );
    expect((result.content[0] as any).text).toContain("todos:");
  });

  test("todo_write succeeds with valid todos", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}todo_write`,
      {
        todos: [
          { id: 1, content: "Test task", status: "pending" },
          { id: 2, content: "Another task", status: "completed" },
        ],
      },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ success: true, todoCount: 2 });
    expect((result.content[0] as any).text).toContain(
      "Successfully wrote 2 todo item(s)",
    );
  });

  test("swap_agent returns error when agent_name is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_agent`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__swap_agent",
    );
    expect((result.content[0] as any).text).toContain("agent_name:");
  });

  test("swap_agent returns error when conversation context is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_agent`,
      { agent_name: "Some Agent" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "requires conversation context",
    );
  });

  test("artifact_write returns error when content is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}artifact_write`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Validation error in archestra__artifact_write",
    );
    expect((result.content[0] as any).text).toContain("content:");
  });

  test("artifact_write returns error when conversation context is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}artifact_write`,
      { content: "# My Artifact" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "requires conversation context",
    );
  });

  test("artifact_write succeeds with real conversation context", async ({
    makeConversation,
  }) => {
    const conversation = await makeConversation(testAgent.id, {
      userId: userId,
      organizationId: organizationId,
    });

    const contextWithConvo: ArchestraContext = {
      ...mockContext,
      conversationId: conversation.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}artifact_write`,
      { content: "# Test Artifact\n\nSome **markdown** content." },
      contextWithConvo,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      success: true,
      characterCount: "# Test Artifact\n\nSome **markdown** content.".length,
    });
    expect((result.content[0] as any).text).toContain(
      "Successfully updated conversation artifact",
    );
  });

  test("swap_agent succeeds with real conversation and target agent", async ({
    makeAgent,
    makeConversation,
    makeSecret,
    makeChatApiKey,
  }) => {
    const secret = await makeSecret();
    const targetApiKey = await makeChatApiKey(organizationId, secret.id, {
      provider: "anthropic",
    });
    vi.spyOn(ChatApiKeyModel, "findById").mockImplementation(async (id) => {
      if (id === targetApiKey.id) {
        return targetApiKey;
      }
      return null;
    });

    const targetAgent = await makeAgent({
      name: "Swap Target Agent",
      agentType: "agent",
      organizationId: organizationId,
      llmApiKeyId: targetApiKey.id,
      llmModel: "claude-3-5-sonnet",
    });

    const conversation = await makeConversation(testAgent.id, {
      userId: userId,
      organizationId: organizationId,
    });

    const contextWithConvo: ArchestraContext = {
      ...mockContext,
      conversationId: conversation.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_agent`,
      { agent_name: "Swap Target Agent" },
      contextWithConvo,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      success: true,
      agent_id: targetAgent.id,
      agent_name: "Swap Target Agent",
    });
    const parsed = result.structuredContent as {
      success: boolean;
      agent_id: string;
      agent_name: string;
    };
    expect(parsed.success).toBe(true);
    expect(parsed.agent_id).toBe(targetAgent.id);
    expect(parsed.agent_name).toBe("Swap Target Agent");

    const updatedConversation = await ConversationModel.findById({
      id: conversation.id,
      userId,
      organizationId,
    });
    expect(updatedConversation?.agentId).toBe(targetAgent.id);
    expect(updatedConversation?.selectedModel).toBe("claude-3-5-sonnet");
    expect(updatedConversation?.selectedProvider).toBe("anthropic");
    expect(updatedConversation?.chatApiKeyId).toBe(targetApiKey.id);
  });

  test("swap_agent returns error when swapping to same agent", async ({
    makeConversation,
  }) => {
    const conversation = await makeConversation(testAgent.id, {
      userId: userId,
      organizationId: organizationId,
    });

    const contextWithConvo: ArchestraContext = {
      ...mockContext,
      conversationId: conversation.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_agent`,
      { agent_name: testAgent.name },
      contextWithConvo,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Already using agent");
  });

  test("swap_to_default_agent returns error when conversation context is missing", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_to_default_agent`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "requires conversation context",
    );
  });

  test("swap_to_default_agent returns error when no default agent configured", async ({
    makeConversation,
  }) => {
    const conversation = await makeConversation(testAgent.id, {
      userId: userId,
      organizationId: organizationId,
    });

    const contextWithConvo: ArchestraContext = {
      ...mockContext,
      conversationId: conversation.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_to_default_agent`,
      {},
      contextWithConvo,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "No default agent is configured",
    );
  });

  test("swap_to_default_agent succeeds when on non-default agent", async ({
    makeAgent,
    makeConversation,
    makeSecret,
    makeChatApiKey,
  }) => {
    const secret = await makeSecret();
    const defaultApiKey = await makeChatApiKey(organizationId, secret.id, {
      provider: "openai",
    });
    vi.spyOn(ChatApiKeyModel, "findById").mockImplementation(async (id) => {
      if (id === defaultApiKey.id) {
        return defaultApiKey;
      }
      return null;
    });

    const defaultAgent = await makeAgent({
      name: "Default Router Agent",
      agentType: "agent",
      organizationId: organizationId,
      llmApiKeyId: defaultApiKey.id,
      llmModel: "gpt-4o",
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: defaultAgent.id,
    });

    const specialistAgent = await makeAgent({
      name: "Specialist Agent",
      agentType: "agent",
      organizationId: organizationId,
    });

    const conversation = await makeConversation(specialistAgent.id, {
      userId: userId,
      organizationId: organizationId,
    });

    const contextWithConvo: ArchestraContext = {
      ...mockContext,
      agent: { id: specialistAgent.id, name: specialistAgent.name },
      conversationId: conversation.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_to_default_agent`,
      {},
      contextWithConvo,
    );
    expect(result.isError).toBe(false);
    const parsed = result.structuredContent as {
      success: boolean;
      agent_id: string;
      agent_name: string;
    };
    expect(parsed.success).toBe(true);
    expect(parsed.agent_id).toBe(defaultAgent.id);
    expect(parsed.agent_name).toBe("Default Router Agent");

    const updatedConversation = await ConversationModel.findById({
      id: conversation.id,
      userId,
      organizationId,
    });
    expect(updatedConversation?.agentId).toBe(defaultAgent.id);
    expect(updatedConversation?.selectedModel).toBe("gpt-4o");
    expect(updatedConversation?.selectedProvider).toBe("openai");
    expect(updatedConversation?.chatApiKeyId).toBe(defaultApiKey.id);
  });

  test("swap_agent cannot swap to inaccessible team-scoped agent", async ({
    makeAgent,
    makeConversation,
    makeUser,
    makeOrganization,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeSecret,
    makeChatApiKey,
  }) => {
    // Create a separate non-admin member for this test
    const memberOrg = await makeOrganization();
    const memberUser = await makeUser();
    await makeMember(memberUser.id, memberOrg.id, { role: "member" });

    const secret = await makeSecret();
    const apiKey = await makeChatApiKey(memberOrg.id, secret.id, {
      provider: "openai",
    });
    vi.spyOn(ChatApiKeyModel, "findById").mockImplementation(async (id) => {
      if (id === apiKey.id) return apiKey;
      return null;
    });

    const teamA = await makeTeam(memberOrg.id, memberUser.id, {
      name: "Team A",
    });
    const teamB = await makeTeam(memberOrg.id, memberUser.id, {
      name: "Team B",
    });
    await makeTeamMember(teamA.id, memberUser.id);
    // memberUser is NOT a member of teamB

    const accessibleAgent = await makeAgent({
      name: "Accessible Agent",
      agentType: "agent",
      organizationId: memberOrg.id,
      scope: "team",
      teams: [teamA.id],
    });

    await makeAgent({
      name: "Inaccessible Agent",
      agentType: "agent",
      organizationId: memberOrg.id,
      scope: "team",
      teams: [teamB.id],
    });

    const conversation = await makeConversation(accessibleAgent.id, {
      userId: memberUser.id,
      organizationId: memberOrg.id,
    });

    const memberContext: ArchestraContext = {
      agent: { id: accessibleAgent.id, name: accessibleAgent.name },
      userId: memberUser.id,
      organizationId: memberOrg.id,
      conversationId: conversation.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_agent`,
      { agent_name: "Inaccessible Agent" },
      memberContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("No agent found");
  });

  test("swap_to_default_agent returns error when already on default agent", async ({
    makeConversation,
  }) => {
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: testAgent.id,
    });

    const conversation = await makeConversation(testAgent.id, {
      userId: userId,
      organizationId: organizationId,
    });

    const contextWithConvo: ArchestraContext = {
      ...mockContext,
      conversationId: conversation.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_to_default_agent`,
      {},
      contextWithConvo,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Already using the default agent",
    );
  });
});
