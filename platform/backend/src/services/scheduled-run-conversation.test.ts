import ConversationModel from "@/models/conversation";
import MessageModel from "@/models/message";
import ScheduleTriggerModel from "@/models/schedule-trigger";
import { projectService } from "@/services/project";
import {
  appendRunMessagesToConversation,
  ensureTriggerConversation,
  syncRunArtifactToConversation,
} from "@/services/scheduled-run-conversation";
import { expect, test } from "@/test";

test("ensureTriggerConversation wraps all of a schedule's runs into one chat", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeInternalAgent,
  makeScheduleTrigger,
}) => {
  const org = await makeOrganization();
  const actor = await makeUser();
  await makeMember(actor.id, org.id, { role: "admin" });
  const agent = await makeInternalAgent({ organizationId: org.id });
  const trigger = await makeScheduleTrigger({
    organizationId: org.id,
    actorUserId: actor.id,
    agentId: agent.id,
  });

  const conversation = await ensureTriggerConversation({
    trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });

  // Unscoped schedule -> a user-scoped chat (this is what lets its files nest
  // under <email>/<conversationId>/ instead of the flat headless bucket).
  expect(conversation.projectId).toBeNull();
  expect(conversation.origin).toBe("schedule_trigger");
  expect(conversation.userId).toBe(actor.id);

  const linked = await ScheduleTriggerModel.findById(trigger.id);
  expect(linked?.chatConversationId).toBe(conversation.id);

  // A later run (or a UI click) reuses the same conversation — never a second.
  const again = await ensureTriggerConversation({
    trigger: linked ?? trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });
  expect(again.id).toBe(conversation.id);

  const all = await ConversationModel.findAll(actor.id, org.id);
  expect(all).toHaveLength(1);
});

test("ensureTriggerConversation scopes a project schedule's chat to the project", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeInternalAgent,
  makeScheduleTrigger,
}) => {
  const org = await makeOrganization();
  const actor = await makeUser();
  await makeMember(actor.id, org.id, { role: "admin" });
  const agent = await makeInternalAgent({ organizationId: org.id });
  const project = await projectService.create({
    organizationId: org.id,
    userId: actor.id,
    name: "runs",
    description: null,
  });
  const trigger = await makeScheduleTrigger({
    organizationId: org.id,
    actorUserId: actor.id,
    agentId: agent.id,
    projectId: project.id,
  });

  const conversation = await ensureTriggerConversation({
    trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });

  expect(conversation.projectId).toBe(project.id);
});

test("appendRunMessagesToConversation accumulates each run's turn, ordered by run start", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeInternalAgent,
  makeScheduleTrigger,
  makeScheduleTriggerRun,
  makeInteraction,
}) => {
  const org = await makeOrganization();
  const actor = await makeUser();
  await makeMember(actor.id, org.id, { role: "admin" });
  const agent = await makeInternalAgent({ organizationId: org.id });
  const trigger = await makeScheduleTrigger({
    organizationId: org.id,
    actorUserId: actor.id,
    agentId: agent.id,
  });
  const conversation = await ensureTriggerConversation({
    trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });

  const earlierRun = await makeScheduleTriggerRun(trigger.id, {
    organizationId: org.id,
  });
  const laterRun = await makeScheduleTriggerRun(trigger.id, {
    organizationId: org.id,
  });
  await makeInteraction(agent.id, { sessionId: `scheduled-${earlierRun.id}` });
  await makeInteraction(agent.id, { sessionId: `scheduled-${laterRun.id}` });

  // Append the later run FIRST to prove ordering is by the run's own start time,
  // not by append order. Stamp explicit start times so the assertion is
  // deterministic regardless of how close the rows were created.
  await appendRunMessagesToConversation({
    conversation,
    trigger,
    run: { ...laterRun, startedAt: new Date(2_000) },
  });
  const afterFirst = await MessageModel.findByConversation(conversation.id);
  expect(afterFirst.length).toBeGreaterThan(0);

  await appendRunMessagesToConversation({
    conversation,
    trigger,
    run: { ...earlierRun, startedAt: new Date(1_000) },
  });
  const afterSecond = await MessageModel.findByConversation(conversation.id);

  // Both runs' turns are present (the old "skip if messages exist" bail is gone)
  // and the earlier run sorts first even though it was appended last.
  expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
  expect(afterSecond[0]?.createdAt.getTime()).toBe(1_000);
});

test("appendRunMessagesToConversation is a no-op when the run produced nothing", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeInternalAgent,
  makeScheduleTrigger,
  makeScheduleTriggerRun,
}) => {
  const org = await makeOrganization();
  const actor = await makeUser();
  await makeMember(actor.id, org.id, { role: "admin" });
  const agent = await makeInternalAgent({ organizationId: org.id });
  const trigger = await makeScheduleTrigger({
    organizationId: org.id,
    actorUserId: actor.id,
    agentId: agent.id,
  });
  const conversation = await ensureTriggerConversation({
    trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });
  const run = await makeScheduleTriggerRun(trigger.id, {
    organizationId: org.id,
  });

  await appendRunMessagesToConversation({
    conversation,
    trigger,
    run,
  });

  const messages = await MessageModel.findByConversation(conversation.id);
  expect(messages).toHaveLength(0);
});

test("syncRunArtifactToConversation surfaces the run's artifact on the chat", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeInternalAgent,
  makeScheduleTrigger,
  makeScheduleTriggerRun,
}) => {
  const org = await makeOrganization();
  const actor = await makeUser();
  await makeMember(actor.id, org.id, { role: "admin" });
  const agent = await makeInternalAgent({ organizationId: org.id });
  const trigger = await makeScheduleTrigger({
    organizationId: org.id,
    actorUserId: actor.id,
    agentId: agent.id,
  });
  const conversation = await ensureTriggerConversation({
    trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });
  const run = await makeScheduleTriggerRun(trigger.id, {
    organizationId: org.id,
  });

  await syncRunArtifactToConversation({
    conversation,
    run: { ...run, artifact: "# Weekly summary" },
    organizationId: org.id,
  });

  const updated = await ConversationModel.findByIdInOrganization({
    id: conversation.id,
    organizationId: org.id,
  });
  expect(updated?.artifact).toBe("# Weekly summary");
});
