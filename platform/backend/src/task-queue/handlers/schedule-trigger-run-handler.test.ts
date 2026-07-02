import { vi } from "vitest";

vi.mock("@/auth");

const A2A_RESULT = {
  messageId: "msg-1",
  text: "done",
  finishReason: "stop",
  responseUiMessage: {
    id: "asst-1",
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
  ProjectModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  UserModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { handleScheduleTriggerRunExecution } from "./schedule-trigger-run-handler";

describe("handleScheduleTriggerRunExecution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(hasAnyAgentTypeAdminPermission).mockResolvedValue(false);
    mockExecuteA2AMessage.mockReset().mockResolvedValue(A2A_RESULT);
    mockCreateAndLinkRunConversation.mockReset();
    mockPersistRunConversationMessages.mockReset().mockResolvedValue(undefined);
    mockRecordRunConversationError.mockReset().mockResolvedValue(undefined);
    mockPersistRunUserMessage.mockReset().mockResolvedValue(undefined);
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
    mockCreateAndLinkRunConversation.mockResolvedValue({
      id: "conv-1",
      userId: actor.id,
    });

    await handleScheduleTriggerRunExecution({
      runId: run.id,
      triggerId: trigger.id,
    });

    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1" }),
    );
    const updated = await ScheduleTriggerRunModel.findById(run.id);
    expect(updated?.status).toBe("success");
    // Transcript comes from the executor's in-memory result — the user prompt and
    // the complete assistant turn — not reconstructed from interactions.
    expect(mockPersistRunConversationMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({ id: "conv-1" }),
        userText: trigger.messageTemplate,
        assistantMessage: expect.objectContaining({
          role: "assistant",
          parts: [{ type: "text", text: "done" }],
        }),
      }),
    );
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
    mockCreateAndLinkRunConversation.mockResolvedValue({
      id: "conv-1",
      userId: actor.id,
    });
    mockExecuteA2AMessage.mockRejectedValue(new Error("LLM provider down"));

    await handleScheduleTriggerRunExecution({
      runId: run.id,
      triggerId: trigger.id,
    });

    const updated = await ScheduleTriggerRunModel.findById(run.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("LLM provider down");
    expect(mockPersistRunConversationMessages).not.toHaveBeenCalled();
    // The failed run keeps its conversation: the scheduled prompt is persisted as
    // the user message (so the chat carries it and "Try again" can resend it)...
    expect(mockPersistRunUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({ id: "conv-1" }),
        userText: trigger.messageTemplate,
      }),
    );
    // ...and the error is recorded as a chat error so the run's chat shows an
    // inline error card. A plain Error (not a ProviderError) becomes the generic
    // fallback card carrying the message.
    expect(mockRecordRunConversationError).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
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
    mockCreateAndLinkRunConversation.mockResolvedValue({
      id: "conv-1",
      userId: actor.id,
    });
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
