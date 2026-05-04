// biome-ignore-all lint/suspicious/noExplicitAny: test

import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { vi } from "vitest";
import {
  ChatOpsChannelBindingModel,
  ChatOpsThreadAgentOverrideModel,
  ConversationModel,
  LlmProviderApiKeyModel,
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
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      userId = user.id;
      organizationId = org.id;
      const secret = await makeSecret();
      const orgWideApiKey = await makeLlmProviderApiKey(
        organizationId,
        secret.id,
        {
          provider: "openai",
        },
      );
      vi.spyOn(LlmProviderApiKeyModel, "findById").mockImplementation(
        async (id) => {
          if (id === orgWideApiKey.id) {
            return orgWideApiKey;
          }
          return null;
        },
      );
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
      "Successfully updated artifact",
    );
  });

  test("swap_agent succeeds with real conversation and target agent", async ({
    makeAgent,
    makeConversation,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret();
    const targetApiKey = await makeLlmProviderApiKey(
      organizationId,
      secret.id,
      {
        provider: "anthropic",
      },
    );
    vi.spyOn(LlmProviderApiKeyModel, "findById").mockImplementation(
      async (id) => {
        if (id === targetApiKey.id) {
          return targetApiKey;
        }
        return null;
      },
    );

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

  test("swap_agent succeeds with chatops binding context", async ({
    makeAgent,
  }) => {
    const targetAgent = await makeAgent({
      name: "ChatOps Swap Target",
      agentType: "agent",
      organizationId,
    });

    const binding = await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "slack",
      channelId: "C-chatops-swap",
      workspaceId: "W-chatops-swap",
      agentId: testAgent.id,
    });

    const contextWithChatOpsBinding: ArchestraContext = {
      ...mockContext,
      chatOpsBindingId: binding.id,
      chatOpsThreadId: "thread-1234",
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_agent`,
      { agent_name: "ChatOps Swap Target" },
      contextWithChatOpsBinding,
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      success: true,
      agent_id: targetAgent.id,
      agent_name: "ChatOps Swap Target",
    });

    // Thread override should be created
    const override = await ChatOpsThreadAgentOverrideModel.findByThread(
      binding.id,
      "thread-1234",
    );
    expect(override?.agentId).toBe(targetAgent.id);

    // Channel binding should NOT be mutated
    const updatedBinding = await ChatOpsChannelBindingModel.findById(
      binding.id,
    );
    expect(updatedBinding?.agentId).toBe(testAgent.id);
  });

  test("swap_agent cannot assign personal agent to shared chatops channel", async ({
    makeAgent,
  }) => {
    const personalAgent = await makeAgent({
      name: "Personal ChatOps Target",
      agentType: "agent",
      organizationId,
      scope: "personal",
      authorId: userId,
    });

    const binding = await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "slack",
      channelId: "C-chatops-personal-blocked",
      workspaceId: "W-chatops-personal-blocked",
      agentId: testAgent.id,
      isDm: false,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_agent`,
      { agent_name: personalAgent.name },
      {
        ...mockContext,
        chatOpsBindingId: binding.id,
        chatOpsThreadId: "thread-personal-blocked",
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Personal agents cannot be assigned to channels",
    );

    const updatedBinding = await ChatOpsChannelBindingModel.findById(
      binding.id,
    );
    expect(updatedBinding?.agentId).toBe(testAgent.id);
  });

  test("swap_agent prefers chatops binding when both contexts are present", async ({
    makeAgent,
  }) => {
    const targetAgent = await makeAgent({
      name: "ChatOps Preferred Target",
      agentType: "agent",
      organizationId,
    });

    const binding = await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "slack",
      channelId: "C-chatops-both-contexts",
      workspaceId: "W-chatops-both-contexts",
      agentId: testAgent.id,
    });

    const contextWithBoth: ArchestraContext = {
      ...mockContext,
      conversationId: "synthetic-chatops-isolation-key",
      chatOpsBindingId: binding.id,
      chatOpsThreadId: "thread-both-contexts",
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_agent`,
      { agent_name: "ChatOps Preferred Target" },
      contextWithBoth,
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      success: true,
      agent_id: targetAgent.id,
      agent_name: "ChatOps Preferred Target",
    });

    // Thread override should be created (chatops binding path was taken)
    const override = await ChatOpsThreadAgentOverrideModel.findByThread(
      binding.id,
      "thread-both-contexts",
    );
    expect(override?.agentId).toBe(targetAgent.id);

    // Channel binding should NOT be mutated
    const updatedBinding = await ChatOpsChannelBindingModel.findById(
      binding.id,
    );
    expect(updatedBinding?.agentId).toBe(testAgent.id);
  });

  test("swap_agent returns structured state when swapping to same agent", async ({
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
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      success: false,
      code: "already_using_agent",
      archestraError: {
        type: "tool_state",
        code: "already_using_agent",
        toolName: "swap_agent",
      },
    });
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

  test("swap_to_default_agent returns structured state when no default agent configured", async ({
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
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      success: false,
      code: "no_default_agent",
      archestraError: {
        type: "tool_state",
        code: "no_default_agent",
        toolName: "swap_to_default_agent",
      },
    });
    expect((result.content[0] as any).text).toContain(
      "No default agent is configured",
    );
  });

  test("swap_to_default_agent succeeds when on non-default agent", async ({
    makeAgent,
    makeConversation,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret();
    const defaultApiKey = await makeLlmProviderApiKey(
      organizationId,
      secret.id,
      {
        provider: "openai",
      },
    );
    vi.spyOn(LlmProviderApiKeyModel, "findById").mockImplementation(
      async (id) => {
        if (id === defaultApiKey.id) {
          return defaultApiKey;
        }
        return null;
      },
    );

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

  test("swap_to_default_agent succeeds with chatops binding context", async ({
    makeAgent,
  }) => {
    const defaultAgent = await makeAgent({
      name: "ChatOps Default Agent",
      agentType: "agent",
      organizationId,
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: defaultAgent.id,
    });

    const binding = await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "ms-teams",
      channelId: "CH-chatops-default",
      workspaceId: "WS-chatops-default",
      agentId: testAgent.id,
    });

    const contextWithChatOpsBinding: ArchestraContext = {
      ...mockContext,
      chatOpsBindingId: binding.id,
      chatOpsThreadId: "thread-default-swap",
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_to_default_agent`,
      {},
      contextWithChatOpsBinding,
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      success: true,
      agent_id: defaultAgent.id,
      agent_name: "ChatOps Default Agent",
    });

    // Thread override should be created
    const override = await ChatOpsThreadAgentOverrideModel.findByThread(
      binding.id,
      "thread-default-swap",
    );
    expect(override?.agentId).toBe(defaultAgent.id);

    // Channel binding should NOT be mutated
    const updatedBinding = await ChatOpsChannelBindingModel.findById(
      binding.id,
    );
    expect(updatedBinding?.agentId).toBe(testAgent.id);
  });

  test("swap_to_default_agent cannot assign personal default agent to shared chatops channel", async ({
    makeAgent,
  }) => {
    const defaultAgent = await makeAgent({
      name: "Personal Default Agent",
      agentType: "agent",
      organizationId,
      scope: "personal",
      authorId: userId,
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: defaultAgent.id,
    });

    const binding = await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "ms-teams",
      channelId: "CH-chatops-personal-default-blocked",
      workspaceId: "WS-chatops-personal-default-blocked",
      agentId: testAgent.id,
      isDm: false,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_to_default_agent`,
      {},
      {
        ...mockContext,
        chatOpsBindingId: binding.id,
        chatOpsThreadId: "thread-personal-default-blocked",
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Personal agents cannot be assigned to channels",
    );

    const updatedBinding = await ChatOpsChannelBindingModel.findById(
      binding.id,
    );
    expect(updatedBinding?.agentId).toBe(testAgent.id);
  });

  test("swap_to_default_agent prefers chatops binding when both contexts are present", async ({
    makeAgent,
  }) => {
    const defaultAgent = await makeAgent({
      name: "ChatOps Preferred Default",
      agentType: "agent",
      organizationId,
    });
    await OrganizationModel.patch(organizationId, {
      defaultAgentId: defaultAgent.id,
    });

    const binding = await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "ms-teams",
      channelId: "CH-chatops-both-contexts",
      workspaceId: "WS-chatops-both-contexts",
      agentId: testAgent.id,
    });

    const contextWithBoth: ArchestraContext = {
      ...mockContext,
      conversationId: "synthetic-chatops-isolation-key",
      chatOpsBindingId: binding.id,
      chatOpsThreadId: "thread-both-default",
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}swap_to_default_agent`,
      {},
      contextWithBoth,
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      success: true,
      agent_id: defaultAgent.id,
      agent_name: "ChatOps Preferred Default",
    });

    // Thread override should be created (chatops binding path was taken)
    const override = await ChatOpsThreadAgentOverrideModel.findByThread(
      binding.id,
      "thread-both-default",
    );
    expect(override?.agentId).toBe(defaultAgent.id);

    // Channel binding should NOT be mutated
    const updatedBinding = await ChatOpsChannelBindingModel.findById(
      binding.id,
    );
    expect(updatedBinding?.agentId).toBe(testAgent.id);
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
    makeLlmProviderApiKey,
  }) => {
    // Create a separate non-admin member for this test
    const memberOrg = await makeOrganization();
    const memberUser = await makeUser();
    await makeMember(memberUser.id, memberOrg.id, { role: "member" });

    const secret = await makeSecret();
    const apiKey = await makeLlmProviderApiKey(memberOrg.id, secret.id, {
      provider: "openai",
    });
    vi.spyOn(LlmProviderApiKeyModel, "findById").mockImplementation(
      async (id) => {
        if (id === apiKey.id) return apiKey;
        return null;
      },
    );

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
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      success: false,
      code: "no_agent_found",
      archestraError: {
        type: "tool_state",
        code: "no_agent_found",
        toolName: "swap_agent",
      },
    });
    expect((result.content[0] as any).text).toContain("No agent found");
  });

  test("swap_to_default_agent returns structured state when already on default agent", async ({
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
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      success: false,
      code: "already_using_default_agent",
      archestraError: {
        type: "tool_state",
        code: "already_using_default_agent",
        toolName: "swap_to_default_agent",
      },
    });
    expect((result.content[0] as any).text).toContain(
      "Already using the default agent",
    );
  });
});
