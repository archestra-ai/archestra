import { ApiError } from "@shared";
import AgentModel from "@/models/agent";
import ConversationModel from "@/models/conversation";
import InteractionModel from "@/models/interaction";
import ScheduleTriggerModel from "@/models/schedule-trigger";
import { describe, expect, test } from "@/test";
import { scheduleTriggerConverterService } from "./converter";

describe("scheduleTriggerConverterService linked conversation", () => {
  test("stores linkedConversationId when replyInSameConversation is true", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Linked conv",
      selectedModel: "gpt-4o",
    });

    const trigger =
      await scheduleTriggerConverterService.createFromConversation({
        conversationId: conversation.id,
        userId: user.id,
        organizationId: org.id,
        cronExpression: "0 9 * * 1",
        timezone: "UTC",
        name: "Linked task",
        messageTemplate: "Do the thing",
        agentId: agent.id,
        enabled: true,
        replyInSameConversation: true,
      });

    expect(trigger.linkedConversationId).toBe(conversation.id);

    const loaded = await ScheduleTriggerModel.findById(trigger.id);
    expect(loaded?.linkedConversationId).toBe(conversation.id);
  });

  test("rejects replyInSameConversation when agent never participated in conversation", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agentA = await makeInternalAgent({ organizationId: org.id });
    const agentB = await makeInternalAgent({ organizationId: org.id });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agentA.id,
      title: "Conv A",
      selectedModel: "gpt-4o",
    });

    await expect(
      scheduleTriggerConverterService.createFromConversation({
        conversationId: conversation.id,
        userId: user.id,
        organizationId: org.id,
        cronExpression: "0 9 * * 1",
        timezone: "UTC",
        messageTemplate: "Do the thing",
        agentId: agentB.id,
        replyInSameConversation: true,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApiError &&
        err.statusCode === 400 &&
        err.message.includes(
          "must be the current chat agent or one that has previously participated",
        ),
    );
  });

  test("accepts replyInSameConversation when agent is in interaction history but not current conversation agent", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const historicalAgent = await makeInternalAgent({ organizationId: org.id });
    const currentAgent = await makeInternalAgent({ organizationId: org.id });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: currentAgent.id,
      title: "Swapped chat",
      selectedModel: "gpt-4o",
    });

    await InteractionModel.create({
      profileId: historicalAgent.id,
      userId: user.id,
      sessionId: conversation.id,
      request: { model: "gpt-4", messages: [] },
      response: {
        id: "r",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      },
      type: "openai:chatCompletions",
    });

    const trigger =
      await scheduleTriggerConverterService.createFromConversation({
        conversationId: conversation.id,
        userId: user.id,
        organizationId: org.id,
        cronExpression: "0 9 * * 1",
        timezone: "UTC",
        name: "Historical agent task",
        messageTemplate: "Do the thing",
        agentId: historicalAgent.id,
        replyInSameConversation: true,
      });

    expect(trigger.agentId).toBe(historicalAgent.id);
    expect(trigger.linkedConversationId).toBe(conversation.id);
  });

  test("rejects replyInSameConversation when conversation has no agent", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const conversationAgent = await makeInternalAgent({
      organizationId: org.id,
    });
    const schedulingAgent = await makeInternalAgent({
      organizationId: org.id,
    });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: conversationAgent.id,
      title: "No agent",
      selectedModel: "gpt-4o",
    });

    await AgentModel.delete(conversationAgent.id);

    await expect(
      scheduleTriggerConverterService.createFromConversation({
        conversationId: conversation.id,
        userId: user.id,
        organizationId: org.id,
        cronExpression: "0 9 * * 1",
        timezone: "UTC",
        messageTemplate: "Do the thing",
        agentId: schedulingAgent.id,
        replyInSameConversation: true,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApiError &&
        err.statusCode === 400 &&
        err.message.includes("This conversation has no agent history"),
    );
  });

  test("isAgentValidForLinkedConversation returns true for current and historical agents, false for outsiders", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const currentAgent = await makeInternalAgent({ organizationId: org.id });
    const historicalAgent = await makeInternalAgent({ organizationId: org.id });
    const outsiderAgent = await makeInternalAgent({ organizationId: org.id });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: currentAgent.id,
      title: "Mixed history chat",
      selectedModel: "gpt-4o",
    });

    await InteractionModel.create({
      profileId: historicalAgent.id,
      userId: user.id,
      sessionId: conversation.id,
      request: { model: "gpt-4", messages: [] },
      response: {
        id: "r",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      },
      type: "openai:chatCompletions",
    });

    await expect(
      scheduleTriggerConverterService.isAgentValidForLinkedConversation({
        linkedConversationId: conversation.id,
        agentId: currentAgent.id,
        actorUserId: user.id,
        organizationId: org.id,
      }),
    ).resolves.toBe(true);

    await expect(
      scheduleTriggerConverterService.isAgentValidForLinkedConversation({
        linkedConversationId: conversation.id,
        agentId: historicalAgent.id,
        actorUserId: user.id,
        organizationId: org.id,
      }),
    ).resolves.toBe(true);

    await expect(
      scheduleTriggerConverterService.isAgentValidForLinkedConversation({
        linkedConversationId: conversation.id,
        agentId: outsiderAgent.id,
        actorUserId: user.id,
        organizationId: org.id,
      }),
    ).resolves.toBe(false);
  });

  test("isAgentValidForLinkedConversation returns false when conversation is missing", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });

    await expect(
      scheduleTriggerConverterService.isAgentValidForLinkedConversation({
        linkedConversationId: "00000000-0000-4000-8000-00000000beef",
        agentId: agent.id,
        actorUserId: user.id,
        organizationId: org.id,
      }),
    ).resolves.toBe(false);
  });

  test("suggestForConversation prefers conversation.agentId over stale interaction history (swap_agent scenario)", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agentA = await makeInternalAgent({ organizationId: org.id });
    const agentB = await makeInternalAgent({ organizationId: org.id });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agentA.id,
      title: "Swap chat",
      selectedModel: "gpt-4o",
    });

    // Record past interactions with A (conversation was chatting with A).
    await InteractionModel.create({
      profileId: agentA.id,
      userId: user.id,
      sessionId: conversation.id,
      request: { model: "gpt-4", messages: [] },
      response: {
        id: "r",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      },
      type: "openai:chatCompletions",
    });

    // Simulate swap_agent: mutate conversation.agentId to B without touching
    // interactions (this is how the real MCP tool behaves).
    await ConversationModel.update(conversation.id, user.id, org.id, {
      agentId: agentB.id,
    });

    const suggestion =
      await scheduleTriggerConverterService.suggestForConversation({
        conversationId: conversation.id,
        userId: user.id,
        organizationId: org.id,
      });

    expect(suggestion.suggestedAgentId).toBe(agentB.id);
    expect(suggestion.reason).toBe("current-conversation-agent");
  });

  test("createFromConversation with replyInSameConversation uses conversation.agentId after swap", async ({
    makeUser,
    makeOrganization,
    makeInternalAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agentA = await makeInternalAgent({ organizationId: org.id });
    const agentB = await makeInternalAgent({ organizationId: org.id });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agentA.id,
      title: "Swap chat",
      selectedModel: "gpt-4o",
    });

    await InteractionModel.create({
      profileId: agentA.id,
      userId: user.id,
      sessionId: conversation.id,
      request: { model: "gpt-4", messages: [] },
      response: {
        id: "r",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      },
      type: "openai:chatCompletions",
    });

    await ConversationModel.update(conversation.id, user.id, org.id, {
      agentId: agentB.id,
    });

    const trigger =
      await scheduleTriggerConverterService.createFromConversation({
        conversationId: conversation.id,
        userId: user.id,
        organizationId: org.id,
        cronExpression: "0 9 * * 1",
        timezone: "UTC",
        name: "Swap task",
        messageTemplate: "Do the thing",
        replyInSameConversation: true,
      });

    expect(trigger.agentId).toBe(agentB.id);
    expect(trigger.linkedConversationId).toBe(conversation.id);
  });
});
