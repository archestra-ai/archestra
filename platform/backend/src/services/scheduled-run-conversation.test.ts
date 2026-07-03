import { ChatErrorCode } from "@archestra/shared";
import ConversationModel from "@/models/conversation";
import ConversationChatErrorModel from "@/models/conversation-chat-error";
import InteractionModel from "@/models/interaction";
import MessageModel from "@/models/message";
import ScheduleTriggerRunModel from "@/models/schedule-trigger-run";
import { projectService } from "@/services/project";
import {
  backfillRunConversationMessages,
  createAndLinkRunConversation,
  ensureFailedRunErrorVisible,
  persistRunConversationMessages,
  persistRunUserMessage,
  recordRunConversationError,
} from "@/services/scheduled-run-conversation";
import { expect, test } from "@/test";
import { THINKING_ONLY_NOTICE } from "@/utils/strip-thinking-blocks";

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

test("backfillRunConversationMessages strips inline <thinking> blocks from the reconstructed transcript", async ({
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

  const conversation = await createAndLinkRunConversation({
    run,
    trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });

  // The stored interaction carries the model's raw output, including inline
  // thinking tags that bypass the A2A executor's sanitization.
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
            content: "Here is a joke.<thinking>pick a good one</thinking> Ha!",
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
  const assistant = messages.find((m) => m.role === "assistant");
  const parts = (
    assistant?.content as { parts?: { type: string; text?: string }[] }
  ).parts;
  const text = (parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
  expect(text).not.toContain("<thinking>");
  expect(text).not.toContain("pick a good one");
  expect(text).toContain("Here is a joke.");
  expect(text).toContain("Ha!");
});

test("backfillRunConversationMessages substitutes a notice for a thinking-only assistant turn", async ({
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

  const conversation = await createAndLinkRunConversation({
    run,
    trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });

  // The whole assistant answer was inline thinking, so stripping empties it.
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
            content: "<thinking>I can't think of one</thinking>",
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
  const assistant = messages.find((m) => m.role === "assistant");
  const parts = (
    assistant?.content as { parts?: { type: string; text?: string }[] }
  ).parts;
  const text = (parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
  expect(text).not.toContain("<thinking>");
  expect(text).toBe(THINKING_ONLY_NOTICE);
});

test("persistRunConversationMessages writes [user, assistant] from the executor result, once", async ({
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
  const conversation = await createAndLinkRunConversation({
    run,
    trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });

  // A complete assistant turn as the AI SDK hands it back: a tool call plus the
  // final answer text, all in one message.
  const assistantMessage = {
    id: "asst-1",
    role: "assistant" as const,
    parts: [
      {
        type: "dynamic-tool" as const,
        toolName: "archestra__save_file",
        toolCallId: "call-1",
        state: "output-available" as const,
        input: { path: "joke.txt" },
        output: "Overwrote joke.txt",
      },
      { type: "text" as const, text: "I wrote a joke and saved it." },
    ],
  } as unknown as Parameters<
    typeof persistRunConversationMessages
  >[0]["assistantMessage"];

  await persistRunConversationMessages({
    conversation,
    userText: trigger.messageTemplate,
    assistantMessage,
  });

  const messages = await MessageModel.findByConversation(conversation.id);
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);

  const userContent = messages[0].content as {
    parts: Array<{ text?: string }>;
  };
  expect(userContent.parts[0].text).toBe("write a joke");

  // The final answer text — the thing the old interaction-reconstruction dropped —
  // is present, alongside the tool-call part.
  const asstContent = messages[1].content as {
    parts: Array<{ type: string; text?: string }>;
  };
  expect(
    asstContent.parts.some(
      (p) => p.type === "text" && p.text === "I wrote a joke and saved it.",
    ),
  ).toBe(true);
  expect(asstContent.parts.some((p) => p.type === "dynamic-tool")).toBe(true);

  // Idempotent: a second call (e.g. lazy view-path racing) does not duplicate.
  await persistRunConversationMessages({
    conversation,
    userText: trigger.messageTemplate,
    assistantMessage,
  });
  expect(await MessageModel.findByConversation(conversation.id)).toHaveLength(
    2,
  );
});

test("recordRunConversationError records a failed run's error on its kept conversation", async ({
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

  await recordRunConversationError({
    conversationId: conversation.id,
    error: {
      code: ChatErrorCode.ServerError,
      message: "Connection error.",
      isRetryable: true,
    },
  });

  // The conversation is KEPT, with the structured error recorded as a chat error.
  expect(
    await ConversationModel.findByIdInOrganization({
      id: conversation.id,
      organizationId: org.id,
    }),
  ).not.toBeNull();
  const errors = await ConversationChatErrorModel.findByConversation(
    conversation.id,
  );
  expect(errors).toHaveLength(1);
  expect(errors[0]?.error.message).toBe("Connection error.");
  expect(errors[0]?.error.code).toBe(ChatErrorCode.ServerError);
  expect(errors[0]?.error.isRetryable).toBe(true);
});

test("persistRunUserMessage writes the prompt as a user message, once", async ({
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
  const conversation = await createAndLinkRunConversation({
    run,
    trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });

  await persistRunUserMessage({
    conversation,
    userText: trigger.messageTemplate,
  });

  const messages = await MessageModel.findByConversation(conversation.id);
  expect(messages.map((m) => m.role)).toEqual(["user"]);
  const userContent = messages[0].content as {
    parts: Array<{ text?: string }>;
  };
  expect(userContent.parts[0].text).toBe("write a joke");

  // Idempotent: a second call (or the lazy view path) does not duplicate.
  await persistRunUserMessage({
    conversation,
    userText: trigger.messageTemplate,
  });
  expect(await MessageModel.findByConversation(conversation.id)).toHaveLength(
    1,
  );
});

test("ensureFailedRunErrorVisible surfaces a failed run's error on an empty conversation, once", async ({
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
  // A skip / pre-execution failure: the run is failed with an error but never
  // executed, so it has no transcript.
  await ScheduleTriggerRunModel.markCompleted({
    runId: run.id,
    status: "failed",
    error: "Skipped: previous run was still in progress",
  });
  const failedRun = await ScheduleTriggerRunModel.findById(run.id);
  if (!failedRun) throw new Error("run not found");
  const conversation = await createAndLinkRunConversation({
    run: failedRun,
    trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });

  await ensureFailedRunErrorVisible({ conversation, run: failedRun, trigger });

  // The chat now carries the prompt + the run's error as a chat error, so it
  // renders the prompt + an inline error card rather than a blank thread.
  const messages = await MessageModel.findByConversation(conversation.id);
  expect(messages.map((m) => m.role)).toEqual(["user"]);
  const userContent = messages[0].content as {
    parts: Array<{ text?: string }>;
  };
  expect(userContent.parts[0].text).toBe("write a joke");
  const errors = await ConversationChatErrorModel.findByConversation(
    conversation.id,
  );
  expect(errors).toHaveLength(1);
  expect(errors[0]?.error.message).toBe(
    "Skipped: previous run was still in progress",
  );

  // Idempotent: a second call does not duplicate the prompt or the error.
  await ensureFailedRunErrorVisible({ conversation, run: failedRun, trigger });
  expect(await MessageModel.findByConversation(conversation.id)).toHaveLength(
    1,
  );
  expect(
    await ConversationChatErrorModel.findByConversation(conversation.id),
  ).toHaveLength(1);
});

test("ensureFailedRunErrorVisible leaves a run that already has a transcript untouched", async ({
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
  await ScheduleTriggerRunModel.markCompleted({
    runId: run.id,
    status: "failed",
    error: "some error",
  });
  const failedRun = await ScheduleTriggerRunModel.findById(run.id);
  if (!failedRun) throw new Error("run not found");
  const conversation = await createAndLinkRunConversation({
    run: failedRun,
    trigger,
    ownerUserId: actor.id,
    organizationId: org.id,
  });
  // A transcript already exists (e.g. backfilled from interactions) — the helper
  // must not graft an error card on top of it.
  await persistRunUserMessage({ conversation, userText: "write a joke" });

  await ensureFailedRunErrorVisible({ conversation, run: failedRun, trigger });

  expect(
    await ConversationChatErrorModel.findByConversation(conversation.id),
  ).toHaveLength(0);
});
