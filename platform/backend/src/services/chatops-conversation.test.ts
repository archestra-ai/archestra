import type { UIMessage } from "ai";
import {
  ChatOpsChannelBindingModel,
  ChatOpsThreadConversationModel,
  ConversationModel,
  MessageModel,
} from "@/models";
import {
  collectProviderMessageIds,
  filterHistoryForChatOpsContext,
  ingestProviderDelta,
  persistChatOpsAssistantTurn,
  persistChatOpsUserTurn,
  resolveOrCreateThreadConversation,
} from "@/services/chatops-conversation";
import { expect, test } from "@/test";
import type { ChatMessage } from "@/types";

async function makeBinding(organizationId: string) {
  return await ChatOpsChannelBindingModel.create({
    organizationId,
    provider: "slack",
    channelId: `C${crypto.randomUUID().slice(0, 8)}`,
    workspaceId: "T123",
  });
}

test("resolveOrCreateThreadConversation creates an owned conversation and reuses it", async ({
  makeAgent,
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const owner = await makeUser();
  const other = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const binding = await makeBinding(org.id);

  const first = await resolveOrCreateThreadConversation({
    bindingId: binding.id,
    organizationId: org.id,
    effectiveThreadId: "1700.100",
    provider: "slack",
    senderUserId: owner.id,
    agentId: agent.id,
    seedTitle: "  deploy   the fix please  ",
  });
  expect(first.senderIsOwner).toBe(true);
  expect(first.conversation.userId).toBe(owner.id);
  expect(first.conversation.agentId).toBe(agent.id);
  expect(first.conversation.origin).toBe("chatops:slack");
  expect(first.conversation.title).toBe("deploy the fix please");

  // second invocation in the same thread, different sender: reused, not owner
  const second = await resolveOrCreateThreadConversation({
    bindingId: binding.id,
    organizationId: org.id,
    effectiveThreadId: "1700.100",
    provider: "slack",
    senderUserId: other.id,
    agentId: agent.id,
    seedTitle: "ignored",
  });
  expect(second.conversation.id).toBe(first.conversation.id);
  expect(second.senderIsOwner).toBe(false);
});

test("concurrent resolveOrCreate settles on one conversation and drops the orphan", async ({
  makeAgent,
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const binding = await makeBinding(org.id);

  const [a, b] = await Promise.all([
    resolveOrCreateThreadConversation({
      bindingId: binding.id,
      organizationId: org.id,
      effectiveThreadId: "race-thread",
      provider: "slack",
      senderUserId: user.id,
      agentId: agent.id,
      seedTitle: "racer a",
    }),
    resolveOrCreateThreadConversation({
      bindingId: binding.id,
      organizationId: org.id,
      effectiveThreadId: "race-thread",
      provider: "slack",
      senderUserId: user.id,
      agentId: agent.id,
      seedTitle: "racer b",
    }),
  ]);

  expect(a.conversation.id).toBe(b.conversation.id);
  const mapping = await ChatOpsThreadConversationModel.findByBindingAndThread(
    binding.id,
    "race-thread",
  );
  expect(mapping?.conversationId).toBe(a.conversation.id);
});

test("ingestProviderDelta persists attributed rows once and advances the cursor", async ({
  makeAgent,
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const binding = await makeBinding(org.id);
  const { mapping, conversation } = await resolveOrCreateThreadConversation({
    bindingId: binding.id,
    organizationId: org.id,
    effectiveThreadId: "delta-thread",
    provider: "slack",
    senderUserId: user.id,
    agentId: agent.id,
    seedTitle: "delta",
  });

  const entries = [
    {
      providerMessageId: "1700.201",
      providerTs: "1700.201",
      text: "hot take from a teammate",
      authorName: "Sam",
    },
    {
      providerMessageId: "1700.202",
      providerTs: "1700.202",
      text: "another one",
      authorName: "Alex",
    },
  ];
  await ingestProviderDelta({
    mapping,
    provider: "slack",
    entries,
    existingProviderMessageIds: new Set(),
  });

  const rows = await MessageModel.findByConversation(conversation.id);
  expect(rows).toHaveLength(2);
  const contents = rows.map((r) => r.content as ChatMessage);
  expect(collectProviderMessageIds(contents)).toEqual(
    new Set(["1700.201", "1700.202"]),
  );
  expect(
    (contents[0].metadata as { chatops: { authorName: string } }).chatops
      .authorName,
  ).toBe("Sam");

  const reloaded = await ChatOpsThreadConversationModel.findByBindingAndThread(
    binding.id,
    "delta-thread",
  );
  expect(reloaded?.lastSyncedProviderTs).toBe("1700.202");

  // duplicate webhook delivery: same entries, ids now known → no new rows
  await ingestProviderDelta({
    mapping: reloaded ?? mapping,
    provider: "slack",
    entries,
    existingProviderMessageIds: collectProviderMessageIds(contents),
  });
  expect(await MessageModel.findByConversation(conversation.id)).toHaveLength(
    2,
  );
});

test("assistant turn persists once and approval mutations update in place", async ({
  makeAgent,
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const binding = await makeBinding(org.id);
  const { conversation } = await resolveOrCreateThreadConversation({
    bindingId: binding.id,
    organizationId: org.id,
    effectiveThreadId: "turn-thread",
    provider: "slack",
    senderUserId: user.id,
    agentId: agent.id,
    seedTitle: "turns",
  });

  await persistChatOpsUserTurn({
    conversationId: conversation.id,
    messageId: "user-msg-1",
    text: "restart the deploy",
    provider: "slack",
    providerMessageId: "1700.301",
    authorName: "Joey",
    authorUserId: user.id,
  });

  const assistantId = crypto.randomUUID();
  const approvalRequested: UIMessage = {
    id: assistantId,
    role: "assistant",
    parts: [
      { type: "text", text: "I need approval to restart" },
      {
        type: "tool-restart_deploy",
        toolCallId: "call_1",
        state: "approval-requested",
        approval: { id: "approval-1" },
      } as never,
    ],
  };
  await persistChatOpsAssistantTurn({
    conversationId: conversation.id,
    assistantMessage: approvalRequested,
    provider: "slack",
    contextScope: "provider",
  });

  // the decision mutates the same assistant message: updated in place
  const approvalResolved: UIMessage = {
    id: assistantId,
    role: "assistant",
    parts: [
      { type: "text", text: "Restarted." },
      {
        type: "tool-restart_deploy",
        toolCallId: "call_1",
        state: "output-available",
        output: { type: "text", value: "ok" },
      } as never,
    ],
  };
  await persistChatOpsAssistantTurn({
    conversationId: conversation.id,
    assistantMessage: approvalResolved,
    provider: "slack",
    contextScope: "provider",
  });

  const rows = await MessageModel.findByConversation(conversation.id);
  expect(rows).toHaveLength(2);
  const assistantRow = rows.find((r) => r.role === "assistant");
  const content = assistantRow?.content as ChatMessage;
  expect(
    content.parts?.some(
      (p) => p.type === "text" && (p as { text: string }).text === "Restarted.",
    ),
  ).toBe(true);
  expect(
    (content.metadata as { chatops: { contextScope: string } }).chatops
      .contextScope,
  ).toBe("provider");
});

test("filterHistoryForChatOpsContext enforces the channel-leak guard", () => {
  const slackUser: ChatMessage = {
    id: "1",
    role: "user",
    parts: [{ type: "text", text: "from slack" }],
    metadata: { chatops: { source: "chatops:slack" } },
  };
  const slackAssistantProvider: ChatMessage = {
    id: "2",
    role: "assistant",
    parts: [{ type: "text", text: "provider-scoped reply" }],
    metadata: {
      chatops: { source: "chatops:slack", contextScope: "provider" },
    },
  };
  const slackAssistantFull: ChatMessage = {
    id: "3",
    role: "assistant",
    parts: [{ type: "text", text: "reply that saw web context" }],
    metadata: { chatops: { source: "chatops:slack", contextScope: "full" } },
  };
  const webUser: ChatMessage = {
    id: "4",
    role: "user",
    parts: [{ type: "text", text: "private web turn" }],
  };
  const webAssistant: ChatMessage = {
    id: "5",
    role: "assistant",
    parts: [{ type: "text", text: "private web reply" }],
  };
  const messages = [
    slackUser,
    slackAssistantProvider,
    slackAssistantFull,
    webUser,
    webAssistant,
  ];

  // owner sees everything
  expect(
    filterHistoryForChatOpsContext({
      messages,
      provider: "slack",
      senderIsOwner: true,
      isDm: false,
    }),
  ).toEqual(messages);

  // DMs are unrestricted
  expect(
    filterHistoryForChatOpsContext({
      messages,
      provider: "slack",
      senderIsOwner: false,
      isDm: true,
    }),
  ).toEqual(messages);

  // a non-owner in a channel gets only provider-born rows
  expect(
    filterHistoryForChatOpsContext({
      messages,
      provider: "slack",
      senderIsOwner: false,
      isDm: false,
    }),
  ).toEqual([slackUser, slackAssistantProvider]);
});

test("empty assistant turns are not persisted", async ({
  makeAgent,
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const binding = await makeBinding(org.id);
  const { conversation } = await resolveOrCreateThreadConversation({
    bindingId: binding.id,
    organizationId: org.id,
    effectiveThreadId: "empty-thread",
    provider: "slack",
    senderUserId: user.id,
    agentId: agent.id,
    seedTitle: "empty",
  });

  await persistChatOpsAssistantTurn({
    conversationId: conversation.id,
    assistantMessage: { id: "a1", role: "assistant", parts: [] },
    provider: "slack",
    contextScope: "full",
  });
  expect(await MessageModel.findByConversation(conversation.id)).toHaveLength(
    0,
  );
});

test("web continuation surface: chatops conversation is owner-readable with a live agent", async ({
  makeAgent,
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  const binding = await makeBinding(org.id);
  const { conversation } = await resolveOrCreateThreadConversation({
    bindingId: binding.id,
    organizationId: org.id,
    effectiveThreadId: "web-thread",
    provider: "slack",
    senderUserId: user.id,
    agentId: agent.id,
    seedTitle: "continue me on web",
  });

  const loaded = await ConversationModel.findById({
    id: conversation.id,
    userId: user.id,
    organizationId: org.id,
  });
  expect(loaded?.agentId).toBe(agent.id);
  expect(loaded?.origin).toBe("chatops:slack");
});
