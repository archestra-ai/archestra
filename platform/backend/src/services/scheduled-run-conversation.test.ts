import ConversationModel from "@/models/conversation";
import InteractionModel from "@/models/interaction";
import MessageModel from "@/models/message";
import ScheduleTriggerRunModel from "@/models/schedule-trigger-run";
import { projectService } from "@/services/project";
import {
  backfillRunConversationMessages,
  createAndLinkRunConversation,
} from "@/services/scheduled-run-conversation";
import { expect, test } from "@/test";

test("createAndLinkRunConversation makes a project-scoped, schedule-origin chat and links it once", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  makeScheduleTrigger,
  makeScheduleTriggerRun,
}) => {
  const org = await makeOrganization();
  const actor = await makeUser();
  await makeMember(actor.id, org.id, { role: "admin" });
  const agent = await makeAgent({ organizationId: org.id, authorId: actor.id });
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
  const run = await makeScheduleTriggerRun(trigger.id, {
    organizationId: org.id,
    runKind: "due",
  });

  const conversation = await createAndLinkRunConversation({
    run,
    trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });

  expect(conversation.projectId).toBe(project.id);
  expect(conversation.origin).toBe("schedule_trigger");

  const linked = await ScheduleTriggerRunModel.findById(run.id);
  expect(linked?.chatConversationId).toBe(conversation.id);

  // A second call (e.g. the lazy view racing the handler) must not create a
  // second conversation — it returns the already-linked one.
  const again = await createAndLinkRunConversation({
    run: linked ?? run,
    trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });
  expect(again.id).toBe(conversation.id);

  const all = await ConversationModel.findAll(actor.id, org.id);
  expect(all.filter((c) => c.projectId === project.id)).toHaveLength(1);
});

test("backfillRunConversationMessages materializes chat messages from a run's interactions, once", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  makeScheduleTrigger,
  makeScheduleTriggerRun,
}) => {
  const org = await makeOrganization();
  const actor = await makeUser();
  await makeMember(actor.id, org.id, { role: "admin" });
  const agent = await makeAgent({ organizationId: org.id, authorId: actor.id });
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
    messageTemplate: "write a joke",
  });
  const run = await makeScheduleTriggerRun(trigger.id, {
    organizationId: org.id,
    runKind: "due",
  });

  // The conversation is created up front (handler path) with no messages.
  const conversation = await createAndLinkRunConversation({
    run,
    trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });
  expect(await MessageModel.findByConversation(conversation.id)).toHaveLength(
    0,
  );

  // The A2A executor persists an interaction under the run's session, not chat
  // messages.
  await InteractionModel.create({
    profileId: agent.id,
    userId: actor.id,
    sessionId: `scheduled-${run.id}`,
    request: {
      model: "gpt-4",
      messages: [{ role: "user", content: "write a joke" }],
    },
    response: {
      id: "resp-1",
      object: "chat.completion",
      created: Date.now(),
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Why did the chicken cross the road?",
            refusal: null,
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    },
    type: "openai:chatCompletions",
  });

  await backfillRunConversationMessages({
    conversation,
    trigger,
    run,
    ownerUserId: actor.id,
  });

  const messages = await MessageModel.findByConversation(conversation.id);
  expect(messages.length).toBeGreaterThan(0);

  // Idempotent: a second backfill (e.g. via the lazy view route) is a no-op once
  // messages exist, so the transcript isn't duplicated.
  await backfillRunConversationMessages({
    conversation,
    trigger,
    run,
    ownerUserId: actor.id,
  });
  expect(await MessageModel.findByConversation(conversation.id)).toHaveLength(
    messages.length,
  );
});
