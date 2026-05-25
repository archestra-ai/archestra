import type { UIMessageChunk } from "ai";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import ActiveChatRunModel from "@/models/chat-active-run";
import { expect, test } from "@/test";

test("allows only one running active chat run per conversation", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });

  const first = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  const second = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });

  expect(first).not.toBeNull();
  expect(second).toBeNull();
});

test("appends and reads ordered active chat run events", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const run = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });

  const chunks: UIMessageChunk[] = [
    { type: "start" },
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: "hello" },
  ];
  await ActiveChatRunModel.appendEvents({
    runId: run?.id ?? "",
    seq: 1,
    payloads: chunks,
  });
  await ActiveChatRunModel.appendEvents({
    runId: run?.id ?? "",
    seq: 2,
    payloads: [{ type: "finish", finishReason: "stop" }],
  });

  const events = await ActiveChatRunModel.readEventsAfter({
    runId: run?.id ?? "",
    seq: 0,
  });
  const laterEvents = await ActiveChatRunModel.readEventsAfter({
    runId: run?.id ?? "",
    seq: 1,
  });

  expect(events.map((event) => event.seq)).toEqual([1, 2]);
  expect(events[0]?.payloads).toEqual(chunks);
  expect(laterEvents.map((event) => event.payloads)).toEqual([
    [{ type: "finish", finishReason: "stop" }],
  ]);
});

test("updates stopRequestedAt on the running active chat run", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });

  const stopped = await ActiveChatRunModel.requestStop({
    conversationId: conversation.id,
    organizationId: organization.id,
  });

  expect(stopped?.stopRequestedAt).toBeInstanceOf(Date);
});

test("does not stop a running active chat run in a different organization", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const otherOrganization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });

  const stopped = await ActiveChatRunModel.requestStop({
    conversationId: conversation.id,
    organizationId: otherOrganization.id,
  });
  const run = await ActiveChatRunModel.findRunningByConversation(
    conversation.id,
  );

  expect(stopped).toBeNull();
  expect(run?.stopRequestedAt).toBeNull();
});

test("marks stale running runs failed and deletes old terminal runs", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const run = await ActiveChatRunModel.create({
    conversationId: conversation.id,
    userId: user.id,
    organizationId: organization.id,
  });

  await db
    .update(schema.chatActiveRunsTable)
    .set({ updatedAt: new Date(Date.now() - 10_000) })
    .where(eq(schema.chatActiveRunsTable.id, run?.id ?? ""));

  await ActiveChatRunModel.markStaleRunningAsFailed(1_000);
  const failedRun = await ActiveChatRunModel.findById(run?.id ?? "");
  expect(failedRun?.status).toBe("failed");

  await db
    .update(schema.chatActiveRunsTable)
    .set({ updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
    .where(eq(schema.chatActiveRunsTable.id, run?.id ?? ""));

  const deleted = await ActiveChatRunModel.deleteTerminalOlderThan(
    60 * 60 * 1000,
  );
  expect(deleted).toBe(1);
});
