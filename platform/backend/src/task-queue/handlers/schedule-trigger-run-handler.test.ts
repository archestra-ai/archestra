import type { UIMessageChunk } from "ai";
import { vi } from "vitest";
import type { executeA2AMessage } from "@/agents/a2a-executor";

vi.mock("@/auth");

const A2A_RESULT = {
  messageId: "msg-1",
  text: "done",
  finishReason: "stop",
  responseUiMessage: {
    id: "a0000000-0000-4000-8000-000000000001",
    role: "assistant",
    parts: [{ type: "text", text: "done" }],
  },
};

const mockExecuteA2AMessage = vi.hoisted(() => vi.fn());
vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: mockExecuteA2AMessage,
}));

const mockCreateAndLinkRunConversation = vi.hoisted(() => vi.fn());
const mockPersistRunConversationMessages = vi.hoisted(() => vi.fn());
const mockRecordRunConversationError = vi.hoisted(() => vi.fn());
const mockPersistRunUserMessage = vi.hoisted(() => vi.fn());
vi.mock("@/services/scheduled-run-conversation", () => ({
  createAndLinkRunConversation: mockCreateAndLinkRunConversation,
  persistRunConversationMessages: mockPersistRunConversationMessages,
  persistRunUserMessage: mockPersistRunUserMessage,
  recordRunConversationError: mockRecordRunConversationError,
}));

import { hasAnyAgentTypeAdminPermission } from "@/auth";
import {
  MessageModel,
  ProjectModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  UserModel,
} from "@/models";
import ActiveChatRunModel from "@/models/chat-active-run";
import { activeChatRunService } from "@/services/active-chat-run";
import { beforeEach, describe, expect, test } from "@/test";
import { handleScheduleTriggerRunExecution } from "./schedule-trigger-run-handler";

describe("handleScheduleTriggerRunExecution", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(hasAnyAgentTypeAdminPermission).mockResolvedValue(false);
    mockExecuteA2AMessage.mockReset().mockResolvedValue(A2A_RESULT);
    const actual = await vi.importActual<
      typeof import("@/services/scheduled-run-conversation")
    >("@/services/scheduled-run-conversation");
    mockCreateAndLinkRunConversation
      .mockReset()
      .mockImplementation(actual.createAndLinkRunConversation);
    mockPersistRunConversationMessages
      .mockReset()
      .mockImplementation(actual.persistRunConversationMessages);
    mockRecordRunConversationError
      .mockReset()
      .mockImplementation(actual.recordRunConversationError);
    mockPersistRunUserMessage
      .mockReset()
      .mockImplementation(actual.persistRunUserMessage);
  });

  test("executes A2A message and marks run as success", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const trigger = await makeScheduleTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: actor.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id);

    await handleScheduleTriggerRunExecution({
      runId: run.id,
      triggerId: trigger.id,
    });

    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: agent.id,
        message: trigger.messageTemplate,
        organizationId: org.id,
        userId: actor.id,
        sessionId: `scheduled-${run.id}`,
        source: "schedule-trigger",
      }),
    );
    const updated = await ScheduleTriggerRunModel.findById(run.id);
    expect(updated?.status).toBe("success");
    expect(updated?.error).toBeNull();
  });

  test("marks run as failed when trigger no longer exists", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const trigger = await makeScheduleTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: actor.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id);
    // Simulate the trigger being deleted between run pickup and lookup.
    vi.spyOn(ScheduleTriggerModel, "findById").mockResolvedValue(null);

    await handleScheduleTriggerRunExecution({
      runId: run.id,
      triggerId: trigger.id,
    });

    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
    const updated = await ScheduleTriggerRunModel.findById(run.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("Trigger no longer exists");
  });

  test("marks run as failed when actor user no longer exists", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const trigger = await makeScheduleTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: actor.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id);
    // Simulate the actor being deleted between scheduling and execution.
    vi.spyOn(UserModel, "getById").mockResolvedValue(null as never);

    await handleScheduleTriggerRunExecution({
      runId: run.id,
      triggerId: trigger.id,
    });

    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
    const updated = await ScheduleTriggerRunModel.findById(run.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("Scheduled trigger actor no longer exists");
  });

  test("marks run as failed when actor lost agent access", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const otherUser = await makeUser();
    // A personal agent owned by someone else — the actor has no access to it.
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      systemPrompt: "You are a test agent",
      scope: "personal",
      authorId: otherUser.id,
    });
    const trigger = await makeScheduleTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: actor.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id);

    await handleScheduleTriggerRunExecution({
      runId: run.id,
      triggerId: trigger.id,
    });

    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
    const updated = await ScheduleTriggerRunModel.findById(run.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe(
      "Scheduled trigger actor no longer has access to the target agent",
    );
  });

  test("marks run as failed when executeA2AMessage throws", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const trigger = await makeScheduleTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: actor.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id);
    mockExecuteA2AMessage.mockRejectedValue(new Error("LLM provider down"));

    await handleScheduleTriggerRunExecution({
      runId: run.id,
      triggerId: trigger.id,
    });

    const updated = await ScheduleTriggerRunModel.findById(run.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("LLM provider down");
  });

  test("skips execution when run is not in running state", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const trigger = await makeScheduleTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: actor.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id);
    // Move the run out of the running state before the handler picks it up.
    await ScheduleTriggerRunModel.markCompleted({
      runId: run.id,
      status: "success",
    });

    await handleScheduleTriggerRunExecution({
      runId: run.id,
      triggerId: trigger.id,
    });

    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
    const updated = await ScheduleTriggerRunModel.findById(run.id);
    expect(updated?.status).toBe("success");
  });

  test("throws when payload is missing runId", async () => {
    await expect(
      handleScheduleTriggerRunExecution({ triggerId: "trigger-1" }),
    ).rejects.toThrow("Missing runId");
  });

  test("persists the run transcript from the executor result on a successful project-scoped run", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: actor.id,
      name: `Project ${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeInternalAgent({ organizationId: org.id });
    const trigger = await makeScheduleTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: actor.id,
      projectId: project.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id);

    await handleScheduleTriggerRunExecution({
      runId: run.id,
      triggerId: trigger.id,
    });

    const conversation =
      await mockCreateAndLinkRunConversation.mock.results[0].value;
    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: conversation.id }),
    );
    const updated = await ScheduleTriggerRunModel.findById(run.id);
    expect(updated?.status).toBe("success");
    // Transcript comes from the executor's in-memory result — the user prompt and
    // the complete assistant turn — not reconstructed from interactions.
    expect(mockPersistRunConversationMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({ id: conversation.id }),
        userText: trigger.messageTemplate,
        assistantMessage: expect.objectContaining({
          role: "assistant",
          parts: [{ type: "text", text: "done" }],
        }),
      }),
    );
  });

  test("publishes text and tool events before completion and replays after disconnect", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: actor.id,
      name: "Streaming schedule",
    });
    const agent = await makeInternalAgent({ organizationId: org.id });
    const trigger = await makeScheduleTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: actor.id,
      projectId: project.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: A2A_RESULT.responseUiMessage.id },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Checking now" },
      {
        type: "tool-input-available",
        toolCallId: "tool-1",
        toolName: "lookup",
        input: { query: "status" },
      },
    ];
    let executionParams: Parameters<typeof executeA2AMessage>[0] | undefined;
    mockExecuteA2AMessage.mockImplementation(
      async (params: Parameters<typeof executeA2AMessage>[0]) => {
        executionParams = params;
        for (const chunk of chunks) await params.onUiMessageChunk?.(chunk);
        await gate;
        await params.onUiMessageChunk?.({
          type: "tool-output-available",
          toolCallId: "tool-1",
          output: "ready",
        });
        await params.onUiMessageChunk?.({ type: "text-end", id: "text-1" });
        await params.onUiMessageChunk?.({
          type: "finish",
          finishReason: "stop",
        });
        return A2A_RESULT;
      },
    );
    const execution = handleScheduleTriggerRunExecution({ runId: run.id });
    try {
      await vi.waitFor(() =>
        expect(executionParams?.conversationId).toBeDefined(),
      );
      const conversationId = executionParams?.conversationId;
      if (!conversationId) throw new Error("Missing run conversation");
      const active =
        await ActiveChatRunModel.findRunningByConversation(conversationId);
      if (!active) throw new Error("Missing active run");
      expect(
        (await MessageModel.findByConversation(conversationId)).map(
          (message) => message.role,
        ),
      ).toEqual(["user"]);
      const reader = activeChatRunService
        .createReplayStream(active.id)
        .getReader();
      for (const chunk of chunks)
        expect((await reader.read()).value).toEqual(chunk);
      expect((await ScheduleTriggerRunModel.findById(run.id))?.status).toBe(
        "running",
      );
      await reader.cancel();
      expect(executionParams?.abortSignal?.aborted).toBe(false);

      // Duplicate delivery must neither execute again nor settle the live run.
      await handleScheduleTriggerRunExecution({ runId: run.id });
      expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
      expect((await ScheduleTriggerRunModel.findById(run.id))?.status).toBe(
        "running",
      );

      release();
      await execution;
      expect((await ActiveChatRunModel.findById(active.id))?.status).toBe(
        "completed",
      );
      expect(
        (await MessageModel.findByConversation(conversationId)).map(
          (message) => message.role,
        ),
      ).toEqual(["user", "assistant"]);
      const replay = activeChatRunService
        .createReplayStream(active.id)
        .getReader();
      const replayed: UIMessageChunk[] = [];
      while (true) {
        const { done, value } = await replay.read();
        if (done) break;
        replayed.push(value);
      }
      expect(replayed).toEqual([
        ...chunks,
        {
          type: "tool-output-available",
          toolCallId: "tool-1",
          output: "ready",
        },
        { type: "text-end", id: "text-1" },
        { type: "finish", finishReason: "stop" },
      ]);
      expect((await ScheduleTriggerRunModel.findById(run.id))?.status).toBe(
        "success",
      );
    } finally {
      release();
      await execution;
    }
  });

  test("stopping the chat settles the run as cancelled, keeping partial output without an error", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: actor.id,
      name: "Stop schedule test",
    });
    const agent = await makeInternalAgent({ organizationId: org.id });
    const trigger = await makeScheduleTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: actor.id,
      projectId: project.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id);
    let executionParams: Parameters<typeof executeA2AMessage>[0] | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockExecuteA2AMessage.mockImplementation(
      async (params: Parameters<typeof executeA2AMessage>[0]) => {
        executionParams = params;
        params.abortSignal?.addEventListener("abort", release, { once: true });
        await gate;
        return A2A_RESULT;
      },
    );
    const execution = handleScheduleTriggerRunExecution({ runId: run.id });
    try {
      await vi.waitFor(() =>
        expect(executionParams?.conversationId).toBeDefined(),
      );
      const conversationId = executionParams?.conversationId;
      if (!conversationId) throw new Error("Missing run conversation");
      await activeChatRunService.requestStop({
        conversationId,
        organizationId: org.id,
      });
      await vi.waitFor(() =>
        expect(executionParams?.abortSignal?.aborted).toBe(true),
      );
      await execution;
      expect(await ScheduleTriggerRunModel.findById(run.id)).toMatchObject({
        status: "cancelled",
        error: null,
      });
      expect(
        await ActiveChatRunModel.findRunningByConversation(conversationId),
      ).toBeNull();
      expect(mockRecordRunConversationError).not.toHaveBeenCalled();
      expect(
        (await MessageModel.findByConversation(conversationId)).map(
          (message) => message.role,
        ),
      ).toEqual(["user", "assistant"]);
    } finally {
      release();
      await execution;
    }
  });

  test("does not persist messages for an unscoped run", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    const trigger = await makeScheduleTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: actor.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id);

    await handleScheduleTriggerRunExecution({
      runId: run.id,
      triggerId: trigger.id,
    });

    expect(mockCreateAndLinkRunConversation).not.toHaveBeenCalled();
    expect(mockPersistRunConversationMessages).not.toHaveBeenCalled();
  });

  test("does not persist messages when a project-scoped run fails", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: actor.id,
      name: `Project ${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeInternalAgent({ organizationId: org.id });
    const trigger = await makeScheduleTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: actor.id,
      projectId: project.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id);
    mockExecuteA2AMessage.mockRejectedValue(new Error("LLM provider down"));

    await handleScheduleTriggerRunExecution({
      runId: run.id,
      triggerId: trigger.id,
    });

    const conversation =
      await mockCreateAndLinkRunConversation.mock.results[0].value;
    const updated = await ScheduleTriggerRunModel.findById(run.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("LLM provider down");
    expect(mockPersistRunConversationMessages).not.toHaveBeenCalled();
    // The failed run keeps its conversation: the scheduled prompt is persisted as
    // the user message (so the chat carries it and "Try again" can resend it)...
    expect(mockPersistRunUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({ id: conversation.id }),
        userText: trigger.messageTemplate,
      }),
    );
    // ...and the error is recorded as a chat error so the run's chat shows an
    // inline error card. A plain Error (not a ProviderError) becomes the generic
    // fallback card carrying the message.
    expect(mockRecordRunConversationError).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.id,
        error: expect.objectContaining({ message: "LLM provider down" }),
      }),
    );
  });

  test("a persist failure does not fail the run", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const org = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, org.id);
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: actor.id,
      name: `Project ${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeInternalAgent({ organizationId: org.id });
    const trigger = await makeScheduleTrigger({
      organizationId: org.id,
      agentId: agent.id,
      actorUserId: actor.id,
      projectId: project.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id);
    mockPersistRunConversationMessages.mockRejectedValue(
      new Error("persist blew up"),
    );

    await expect(
      handleScheduleTriggerRunExecution({
        runId: run.id,
        triggerId: trigger.id,
      }),
    ).resolves.toBeUndefined();

    const updated = await ScheduleTriggerRunModel.findById(run.id);
    expect(updated?.status).toBe("success");
  });
});
