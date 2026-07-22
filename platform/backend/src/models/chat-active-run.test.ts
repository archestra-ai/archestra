import type { UIMessageChunk } from "ai";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { ConversationModel } from "@/models";
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

test("readStatusAndEventsAfter returns the run status with events after seq in one read", async ({
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

  // No events yet: status still comes back with an empty event list.
  const empty = await ActiveChatRunModel.readStatusAndEventsAfter({
    runId: run?.id ?? "",
    seq: 0,
  });
  expect(empty).toEqual({ status: "running", events: [] });

  await ActiveChatRunModel.appendEvents({
    runId: run?.id ?? "",
    seq: 1,
    payloads: [{ type: "start" }],
  });
  await ActiveChatRunModel.appendEvents({
    runId: run?.id ?? "",
    seq: 2,
    payloads: [{ type: "finish", finishReason: "stop" }],
  });
  await ActiveChatRunModel.markTerminal({
    runId: run?.id ?? "",
    status: "completed",
  });

  const afterFirst = await ActiveChatRunModel.readStatusAndEventsAfter({
    runId: run?.id ?? "",
    seq: 1,
  });
  expect(afterFirst?.status).toBe("completed");
  expect(afterFirst?.events.map((event) => event.seq)).toEqual([2]);
  expect(afterFirst?.events[0]?.payloads).toEqual([
    { type: "finish", finishReason: "stop" },
  ]);

  const all = await ActiveChatRunModel.readStatusAndEventsAfter({
    runId: run?.id ?? "",
    seq: 0,
  });
  expect(all?.events.map((event) => event.seq)).toEqual([1, 2]);
});

test("readStatusAndEventsAfter returns null when the run row is gone", async ({
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

  await ConversationModel.delete(conversation.id, user.id, organization.id);

  await expect(
    ActiveChatRunModel.readStatusAndEventsAfter({
      runId: run?.id ?? "",
      seq: 0,
    }),
  ).resolves.toBeNull();
});

test("appends active chat run events without touching the run every time", async ({
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
  const oldUpdatedAt = new Date(Date.now() - 60 * 60 * 1000);
  await db
    .update(schema.chatActiveRunsTable)
    .set({ updatedAt: oldUpdatedAt })
    .where(eq(schema.chatActiveRunsTable.id, run?.id ?? ""));

  await ActiveChatRunModel.appendEvents({
    runId: run?.id ?? "",
    seq: 1,
    payloads: [{ type: "start" }],
  });
  const untouchedRun = await ActiveChatRunModel.findById(run?.id ?? "");
  expect(untouchedRun?.updatedAt.getTime()).toBe(oldUpdatedAt.getTime());

  await ActiveChatRunModel.appendEvents({
    runId: run?.id ?? "",
    seq: 2,
    payloads: [{ type: "finish", finishReason: "stop" }],
    touchRun: true,
  });
  const touchedRun = await ActiveChatRunModel.findById(run?.id ?? "");
  expect(touchedRun?.updatedAt.getTime()).toBeGreaterThan(
    oldUpdatedAt.getTime(),
  );
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

test("markTerminal does not overwrite an already-terminal run", async ({
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

  const completed = await ActiveChatRunModel.markTerminal({
    runId: run?.id ?? "",
    status: "completed",
  });
  expect(completed?.status).toBe("completed");

  // A late drain finishing after the run was already marked terminal must not
  // transition it again (e.g. reaper-set failed -> completed).
  const reMarked = await ActiveChatRunModel.markTerminal({
    runId: run?.id ?? "",
    status: "failed",
    error: "late drain",
  });
  expect(reMarked).toBeNull();

  const finalRun = await ActiveChatRunModel.findById(run?.id ?? "");
  expect(finalRun?.status).toBe("completed");
  expect(finalRun?.error).toBeNull();
});

test("markRunningAsFailedByIds fails only running runs", async ({
  makeAgent,
  makeConversation,
  makeOrganization,
  makeUser,
}) => {
  const user = await makeUser();
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const runningConversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });
  const completedConversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: organization.id,
  });

  const runningRun = await ActiveChatRunModel.create({
    conversationId: runningConversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  const completedRun = await ActiveChatRunModel.create({
    conversationId: completedConversation.id,
    userId: user.id,
    organizationId: organization.id,
  });
  await ActiveChatRunModel.markTerminal({
    runId: completedRun?.id ?? "",
    status: "completed",
  });

  const failedCount = await ActiveChatRunModel.markRunningAsFailedByIds({
    ids: [runningRun?.id ?? "", completedRun?.id ?? ""],
    error: "Server shut down before the chat stream completed.",
  });
  expect(failedCount).toBe(1);

  const formerlyRunning = await ActiveChatRunModel.findById(
    runningRun?.id ?? "",
  );
  expect(formerlyRunning?.status).toBe("failed");
  const stillCompleted = await ActiveChatRunModel.findById(
    completedRun?.id ?? "",
  );
  expect(stillCompleted?.status).toBe("completed");
});

test("markRunningAsFailedByIds is a no-op for an empty id list", async () => {
  expect(
    await ActiveChatRunModel.markRunningAsFailedByIds({
      ids: [],
      error: "unused",
    }),
  ).toBe(0);
});

test("appendEvents reports run_missing after the run row is cascade-deleted (non-touch path)", async ({
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

  await ConversationModel.delete(conversation.id, user.id, organization.id);

  // The run row is gone via cascade, so the insert hits the run_id FK. The model
  // must report this lifecycle race rather than throw a raw FK error that would
  // escape as an unhandled rejection.
  await expect(
    ActiveChatRunModel.appendEvents({
      runId: run?.id ?? "",
      seq: 1,
      payloads: [{ type: "start" }],
    }),
  ).resolves.toBe("run_missing");
});

test("appendEvents reports run_missing after the run row is cascade-deleted (touchRun path)", async ({
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

  await ConversationModel.delete(conversation.id, user.id, organization.id);

  // The transaction path (insert + run touch) must classify the FK identically.
  await expect(
    ActiveChatRunModel.appendEvents({
      runId: run?.id ?? "",
      seq: 1,
      payloads: [{ type: "start" }],
      touchRun: true,
    }),
  ).resolves.toBe("run_missing");
});

test("appendEvents reports appended for a live run on both write paths", async ({
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

  await expect(
    ActiveChatRunModel.appendEvents({
      runId: run?.id ?? "",
      seq: 1,
      payloads: [{ type: "start" }],
    }),
  ).resolves.toBe("appended");
  await expect(
    ActiveChatRunModel.appendEvents({
      runId: run?.id ?? "",
      seq: 2,
      payloads: [{ type: "finish", finishReason: "stop" }],
      touchRun: true,
    }),
  ).resolves.toBe("appended");
  // An empty payload is a no-op write, not a missing run.
  await expect(
    ActiveChatRunModel.appendEvents({
      runId: run?.id ?? "",
      seq: 3,
      payloads: [],
    }),
  ).resolves.toBe("appended");
});
