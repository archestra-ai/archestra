import {
  ChatOpsChannelBindingModel,
  ChatOpsThreadConversationModel,
  ConversationModel,
} from "@/models";
import { expect, test } from "@/test";

async function makeBinding(organizationId: string) {
  return await ChatOpsChannelBindingModel.create({
    organizationId,
    provider: "slack",
    channelId: `C${crypto.randomUUID().slice(0, 8)}`,
    workspaceId: "T123",
  });
}

test("createIfAbsent inserts once and returns the winner on conflict", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent();
  const binding = await makeBinding(org.id);
  const conversationA = await makeConversation(agent.id, {
    organizationId: org.id,
  });
  const conversationB = await makeConversation(agent.id, {
    organizationId: org.id,
  });

  const first = await ChatOpsThreadConversationModel.createIfAbsent({
    bindingId: binding.id,
    threadId: "1700000000.000100",
    conversationId: conversationA.id,
  });
  expect(first.created).toBe(true);
  expect(first.mapping.conversationId).toBe(conversationA.id);

  // a racing creator loses and adopts the winner's conversation
  const second = await ChatOpsThreadConversationModel.createIfAbsent({
    bindingId: binding.id,
    threadId: "1700000000.000100",
    conversationId: conversationB.id,
  });
  expect(second.created).toBe(false);
  expect(second.mapping.conversationId).toBe(conversationA.id);

  // a different thread in the same binding maps independently
  const other = await ChatOpsThreadConversationModel.createIfAbsent({
    bindingId: binding.id,
    threadId: "1700000000.000200",
    conversationId: conversationB.id,
  });
  expect(other.created).toBe(true);
});

test("advanceLastSyncedProviderTs is compare-and-set", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent();
  const binding = await makeBinding(org.id);
  const conversation = await makeConversation(agent.id, {
    organizationId: org.id,
  });
  const { mapping } = await ChatOpsThreadConversationModel.createIfAbsent({
    bindingId: binding.id,
    threadId: "thread-1",
    conversationId: conversation.id,
  });

  // fresh mapping: expected null cursor advances
  expect(
    await ChatOpsThreadConversationModel.advanceLastSyncedProviderTs({
      id: mapping.id,
      expectedTs: null,
      newTs: "100",
    }),
  ).toBe(true);

  // stale expectation (still null) must not clobber the newer cursor
  expect(
    await ChatOpsThreadConversationModel.advanceLastSyncedProviderTs({
      id: mapping.id,
      expectedTs: null,
      newTs: "50",
    }),
  ).toBe(false);

  // matching expectation advances
  expect(
    await ChatOpsThreadConversationModel.advanceLastSyncedProviderTs({
      id: mapping.id,
      expectedTs: "100",
      newTs: "200",
    }),
  ).toBe(true);

  const reloaded = await ChatOpsThreadConversationModel.findByBindingAndThread(
    binding.id,
    "thread-1",
  );
  expect(reloaded?.lastSyncedProviderTs).toBe("200");
});

test("mapping cascades away with its conversation", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent();
  const binding = await makeBinding(org.id);
  const conversation = await makeConversation(agent.id, {
    organizationId: org.id,
  });
  await ChatOpsThreadConversationModel.createIfAbsent({
    bindingId: binding.id,
    threadId: "thread-2",
    conversationId: conversation.id,
  });

  await ConversationModel.delete(
    conversation.id,
    conversation.userId,
    conversation.organizationId,
  );

  expect(
    await ChatOpsThreadConversationModel.findByBindingAndThread(
      binding.id,
      "thread-2",
    ),
  ).toBeNull();
});
