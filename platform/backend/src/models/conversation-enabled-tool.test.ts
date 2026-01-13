import { describe, expect, test } from "@/test";
import ConversationModel from "./conversation";
import ConversationEnabledToolModel from "./conversation-enabled-tool";

describe("ConversationEnabledToolModel", () => {
  test("returns todo_write and artifact_write tools enabled by default", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });

    // Seed and assign Archestra tools to the agent
    await seedAndAssignArchestraTools(agent.id);

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Test Conversation",
      selectedModel: "claude-3-haiku-20240307",
    });

    const enabledTools = await ConversationEnabledToolModel.findByConversation(
      conversation.id,
    );

    // Should have todo_write and artifact_write enabled by default
    expect(enabledTools).toHaveLength(2);
  });

  test("hasCustomSelection returns true for new conversation (Archestra tools disabled by default)", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });

    // Seed and assign Archestra tools to the agent
    await seedAndAssignArchestraTools(agent.id);

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Test Conversation",
      selectedModel: "claude-3-haiku-20240307",
    });

    const hasCustom = await ConversationEnabledToolModel.hasCustomSelection(
      conversation.id,
    );

    // New conversations have custom selection because Archestra tools are disabled by default
    expect(hasCustom).toBe(true);
  });

  test("can set enabled tools for a conversation", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeTool,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });
    const tool1 = await makeTool({ name: "tool1" });
    const tool2 = await makeTool({ name: "tool2" });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Test Conversation",
      selectedModel: "claude-3-haiku-20240307",
    });

    await ConversationEnabledToolModel.setEnabledTools(conversation.id, [
      tool1.id,
      tool2.id,
    ]);

    const enabledTools = await ConversationEnabledToolModel.findByConversation(
      conversation.id,
    );

    expect(enabledTools).toHaveLength(2);
    expect(enabledTools).toContain(tool1.id);
    expect(enabledTools).toContain(tool2.id);
  });

  test("hasCustomSelection returns true after setting tools", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeTool,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });
    const tool = await makeTool({ name: "tool1" });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Test Conversation",
      selectedModel: "claude-3-haiku-20240307",
    });

    await ConversationEnabledToolModel.setEnabledTools(conversation.id, [
      tool.id,
    ]);

    const hasCustom = await ConversationEnabledToolModel.hasCustomSelection(
      conversation.id,
    );

    expect(hasCustom).toBe(true);
  });

  test("setEnabledTools replaces existing selection", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeTool,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });
    const tool1 = await makeTool({ name: "tool1" });
    const tool2 = await makeTool({ name: "tool2" });
    const tool3 = await makeTool({ name: "tool3" });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Test Conversation",
      selectedModel: "claude-3-haiku-20240307",
    });

    // First set
    await ConversationEnabledToolModel.setEnabledTools(conversation.id, [
      tool1.id,
      tool2.id,
    ]);

    // Replace with different set
    await ConversationEnabledToolModel.setEnabledTools(conversation.id, [
      tool2.id,
      tool3.id,
    ]);

    const enabledTools = await ConversationEnabledToolModel.findByConversation(
      conversation.id,
    );

    expect(enabledTools).toHaveLength(2);
    expect(enabledTools).not.toContain(tool1.id);
    expect(enabledTools).toContain(tool2.id);
    expect(enabledTools).toContain(tool3.id);
  });

  test("clearCustomSelection removes all enabled tool entries", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeTool,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });
    const tool = await makeTool({ name: "tool1" });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Test Conversation",
      selectedModel: "claude-3-haiku-20240307",
    });

    await ConversationEnabledToolModel.setEnabledTools(conversation.id, [
      tool.id,
    ]);

    // Verify it was set
    let hasCustom = await ConversationEnabledToolModel.hasCustomSelection(
      conversation.id,
    );
    expect(hasCustom).toBe(true);

    // Clear it
    await ConversationEnabledToolModel.clearCustomSelection(conversation.id);

    // Verify it was cleared
    hasCustom = await ConversationEnabledToolModel.hasCustomSelection(
      conversation.id,
    );
    expect(hasCustom).toBe(false);

    const enabledTools = await ConversationEnabledToolModel.findByConversation(
      conversation.id,
    );
    expect(enabledTools).toEqual([]);
  });

  test("setEnabledTools with empty array maintains custom selection", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeTool,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });
    const tool = await makeTool({ name: "tool1" });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Test Conversation",
      selectedModel: "claude-3-haiku-20240307",
    });

    await ConversationEnabledToolModel.setEnabledTools(conversation.id, [
      tool.id,
    ]);

    // Set to empty array - this still maintains custom selection (to explicitly disable all tools)
    await ConversationEnabledToolModel.setEnabledTools(conversation.id, []);

    const hasCustom = await ConversationEnabledToolModel.hasCustomSelection(
      conversation.id,
    );
    // Should still have custom selection, just with zero tools enabled
    expect(hasCustom).toBe(true);
  });

  test("findByConversations returns map of tool IDs per conversation", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeTool,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });
    const tool1 = await makeTool({ name: "tool1" });
    const tool2 = await makeTool({ name: "tool2" });

    const conversation1 = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Conversation 1",
      selectedModel: "claude-3-haiku-20240307",
    });

    const conversation2 = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Conversation 2",
      selectedModel: "claude-3-haiku-20240307",
    });

    // Set different tools for each conversation
    await ConversationEnabledToolModel.setEnabledTools(conversation1.id, [
      tool1.id,
    ]);
    await ConversationEnabledToolModel.setEnabledTools(conversation2.id, [
      tool2.id,
    ]);

    const toolsMap = await ConversationEnabledToolModel.findByConversations([
      conversation1.id,
      conversation2.id,
    ]);

    expect(toolsMap.get(conversation1.id)).toContain(tool1.id);
    expect(toolsMap.get(conversation1.id)).not.toContain(tool2.id);
    expect(toolsMap.get(conversation2.id)).toContain(tool2.id);
    expect(toolsMap.get(conversation2.id)).not.toContain(tool1.id);
  });

  test("findByConversations returns todo_write and artifact_write for conversations by default", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });

    // Seed and assign Archestra tools to the agent
    await seedAndAssignArchestraTools(agent.id);

    const conversation1 = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Conversation 1",
      selectedModel: "claude-3-haiku-20240307",
    });

    const conversation2 = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Conversation 2",
      selectedModel: "claude-3-haiku-20240307",
    });

    const toolsMap = await ConversationEnabledToolModel.findByConversations([
      conversation1.id,
      conversation2.id,
    ]);

    // Should have todo_write and artifact_write enabled by default
    expect(toolsMap.get(conversation1.id)).toHaveLength(2);
    expect(toolsMap.get(conversation2.id)).toHaveLength(2);
  });

  test("findByConversations returns empty map for empty input", async () => {
    const toolsMap = await ConversationEnabledToolModel.findByConversations([]);

    expect(toolsMap.size).toBe(0);
  });

  test("isolates enabled tools between conversations", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeTool,
    seedAndAssignArchestraTools,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });
    const tool1 = await makeTool({ name: "tool1" });
    const tool2 = await makeTool({ name: "tool2" });

    // Seed and assign Archestra tools to the agent
    await seedAndAssignArchestraTools(agent.id);

    const conversation1 = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Conversation 1",
      selectedModel: "claude-3-haiku-20240307",
    });

    const conversation2 = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Conversation 2",
      selectedModel: "claude-3-haiku-20240307",
    });

    // Set tools for conversation 1 only
    await ConversationEnabledToolModel.setEnabledTools(conversation1.id, [
      tool1.id,
      tool2.id,
    ]);

    // Conversation 1 should have the tools
    const tools1 = await ConversationEnabledToolModel.findByConversation(
      conversation1.id,
    );
    expect(tools1).toHaveLength(2);

    // Conversation 2 has custom selection with todo_write and artifact_write by default
    const tools2 = await ConversationEnabledToolModel.findByConversation(
      conversation2.id,
    );
    expect(tools2).toHaveLength(2); // todo_write and artifact_write

    const hasCustom1 = await ConversationEnabledToolModel.hasCustomSelection(
      conversation1.id,
    );
    const hasCustom2 = await ConversationEnabledToolModel.hasCustomSelection(
      conversation2.id,
    );

    expect(hasCustom1).toBe(true);
    // Conversation 2 also has custom selection due to default Archestra tool disabling
    expect(hasCustom2).toBe(true);
  });
});
