import {
  TOOL_GET_TASK_FULL_NAME,
  TOOL_LIST_AGENT_RUNS_FULL_NAME,
  TOOL_POST_TASK_FILE_FULL_NAME,
  TOOL_START_TASK_FULL_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import * as a2aExecutor from "@/agents/a2a-executor";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import {
  A2AContextModel,
  A2AMessageModel,
  A2ATaskModel,
  AgentRunModel,
  AgentTeamModel,
  ChatOpsChannelBindingModel,
} from "@/models";
import { RouteCategory } from "@/observability/tracing";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

describe("task tools", () => {
  let callingAgent: Agent;
  let actorId: string;
  let organizationId: string;
  let context: ArchestraContext;

  beforeEach(
    async ({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
      seedAndAssignArchestraTools,
    }) => {
      const organization = await makeOrganization();
      const actor = await makeUser();
      await makeMember(actor.id, organization.id, { role: "member" });
      actorId = actor.id;
      organizationId = organization.id;
      callingAgent = await makeAgent({
        organizationId,
        authorId: actorId,
        agentType: "agent",
        scope: "org",
      });
      await seedAndAssignArchestraTools(callingAgent.id);
      context = {
        agent: { id: callingAgent.id, name: callingAgent.name },
        agentId: callingAgent.id,
        userId: actorId,
        organizationId,
      };
    },
  );

  test("does not start work on a team Agent the actor cannot access", async ({
    makeAgent,
    makeTeam,
    makeUser,
  }) => {
    const owner = await makeUser();
    const team = await makeTeam(organizationId, owner.id);
    const target = await makeAgent({
      organizationId,
      authorId: owner.id,
      agentType: "agent",
      scope: "team",
    });
    await AgentTeamModel.syncAgentTeams(target.id, [team.id]);

    const result = await executeArchestraTool(
      TOOL_START_TASK_FULL_NAME,
      { agent_id: target.id, message: "Do the restricted work" },
      context,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "Agent not found",
    );
  });

  test("task controls remain callable without individual assignment", async ({
    makeAgent,
  }) => {
    const unassignedAgent = await makeAgent({
      organizationId,
      authorId: actorId,
      agentType: "mcp_gateway",
      scope: "org",
    });

    const result = await executeArchestraTool(
      TOOL_GET_TASK_FULL_NAME,
      { task_id: crypto.randomUUID() },
      {
        ...context,
        agent: { id: unassignedAgent.id, name: unassignedAgent.name },
        agentId: unassignedAgent.id,
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "Task not found",
    );
    expect((result.content[0] as { text: string }).text).not.toContain(
      "not assigned",
    );
  });

  test("preserves the originating chat thread on a delegated task", async ({
    makeAgent,
  }) => {
    const target = await makeAgent({
      organizationId,
      authorId: actorId,
      agentType: "agent",
      scope: "org",
    });
    vi.spyOn(a2aExecutor, "executeA2AMessage").mockResolvedValue({
      text: "Finished",
      messageId: crypto.randomUUID(),
      finishReason: "stop",
      responseUiMessage: {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text: "Finished" }],
      },
    });
    const sendMessage = vi.spyOn(A2AManager.prototype, "sendMessage");
    const chatContext: ArchestraContext = {
      ...context,
      sessionId: "slack:C123:T456",
      chatOpsBindingId: crypto.randomUUID(),
      chatOpsThreadId: "T456",
    };

    const result = await executeArchestraTool(
      TOOL_START_TASK_FULL_NAME,
      { agent_id: target.id, message: "Do the work" },
      chatContext,
    );

    expect(result.isError).not.toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: target.id,
        systemParams: {
          sessionId: chatContext.sessionId,
          routeCategory: RouteCategory.CHATOPS,
          completionTarget: {
            type: "chatops",
            bindingId: chatContext.chatOpsBindingId,
            threadId: chatContext.chatOpsThreadId,
          },
        },
        taskRun: { createTask: true, detached: true },
      }),
    );
  });

  async function seedChatopsTask(params: {
    actorUserId: string;
    withTarget: boolean;
    bindingId?: string;
    prompt?: string;
  }) {
    const a2aContext = await A2AContextModel.create({
      actorKind: "user",
      actorId: params.actorUserId,
    });
    const task = await A2ATaskModel.create({
      contextId: a2aContext.id,
      agentId: callingAgent.id,
      state: "TASK_STATE_WORKING",
    });
    if (params.prompt) {
      await A2AMessageModel.create({
        contextId: a2aContext.id,
        taskId: task.id,
        role: "ROLE_USER",
        parts: [{ text: params.prompt }],
        content: {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: params.prompt }],
        },
      });
    }
    await AgentRunModel.create({
      organizationId,
      taskId: task.id,
      agentId: callingAgent.id,
      actorKind: "user",
      actorId: params.actorUserId,
      actorUserId: params.actorUserId,
      workloadName: `test-${task.id.slice(0, 8)}`,
      backend: "kubernetes",
      runtimeScope: "test",
      completionTarget: params.withTarget
        ? {
            type: "chatops",
            bindingId:
              params.bindingId ?? "9c2b1f60-0000-4000-8000-000000000001",
            threadId: "1788208728.803109",
          }
        : null,
    });
    return task;
  }

  test("lists accessible Agent runs with live and thread links", async () => {
    const binding = await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "slack",
      channelId: "C01234567",
      workspaceId: "T01234567",
      channelName: "engineering",
      workspaceName: "Workspace",
      agentId: callingAgent.id,
    });
    const task = await seedChatopsTask({
      actorUserId: actorId,
      withTarget: true,
      bindingId: binding.id,
      prompt: "Add a character counter.",
    });

    const result = await executeArchestraTool(
      TOOL_LIST_AGENT_RUNS_FULL_NAME,
      { agent_ids: [callingAgent.id], limit: 20 },
      context,
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      summary: { total: 1, active: 1, by_state: { TASK_STATE_WORKING: 1 } },
      runs: [
        {
          task_id: task.id,
          prompt: "Add a character counter.",
          state: "TASK_STATE_WORKING",
          hard_deadline_at: expect.any(String),
          last_model_activity_at: null,
          attention_state: null,
          agent: { id: callingAgent.id, name: callingAgent.name },
          requester: { kind: "user", id: actorId },
          thread: {
            provider: "slack",
            channel_id: "C01234567",
            channel_name: "engineering",
            thread_id: "1788208728.803109",
            url: "https://app.slack.com/client/T01234567/C01234567/thread/C01234567-1788208728.803109",
          },
        },
      ],
    });
    expect(
      (
        result.structuredContent as {
          runs: Array<{ run_url: string }>;
        }
      ).runs[0]?.run_url,
    ).toMatch(new RegExp(`/chat/runs/${task.id}$`));
  });

  test("does not reveal runs for an inaccessible Agent", async ({
    makeAgent,
    makeUser,
  }) => {
    const otherUser = await makeUser();
    const privateAgent = await makeAgent({
      organizationId,
      authorId: otherUser.id,
      agentType: "agent",
      scope: "personal",
    });

    const result = await executeArchestraTool(
      TOOL_LIST_AGENT_RUNS_FULL_NAME,
      { agent_ids: [privateAgent.id] },
      context,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Agent not found");
  });

  test("post_task_file uploads into the task's chatops thread", async () => {
    const task = await seedChatopsTask({
      actorUserId: actorId,
      withTarget: true,
    });
    const upload = vi
      .spyOn(chatOpsManager, "uploadFileToBindingThread")
      .mockResolvedValue();

    const result = await executeArchestraTool(
      TOOL_POST_TASK_FILE_FULL_NAME,
      {
        task_id: task.id,
        filename: "demo.mp4",
        content_base64: Buffer.from("not-really-a-video").toString("base64"),
        comment: "demo recording",
      },
      context,
    );

    expect(result.isError).toBeFalsy();
    expect(upload).toHaveBeenCalledWith({
      bindingId: "9c2b1f60-0000-4000-8000-000000000001",
      threadId: "1788208728.803109",
      filename: "demo.mp4",
      data: Buffer.from("not-really-a-video"),
      comment: "demo recording",
    });
    upload.mockRestore();
  });

  test("post_task_file refuses a task with no messaging-channel thread", async () => {
    const task = await seedChatopsTask({
      actorUserId: actorId,
      withTarget: false,
    });
    const upload = vi
      .spyOn(chatOpsManager, "uploadFileToBindingThread")
      .mockResolvedValue();

    const result = await executeArchestraTool(
      TOOL_POST_TASK_FILE_FULL_NAME,
      {
        task_id: task.id,
        filename: "demo.mp4",
        content_base64: Buffer.from("x").toString("base64"),
      },
      context,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "does not report to a messaging-channel thread",
    );
    expect(upload).not.toHaveBeenCalled();
    upload.mockRestore();
  });

  test("post_task_file only serves the person the run acts as", async ({
    makeUser,
    makeMember,
  }) => {
    const otherUser = await makeUser();
    await makeMember(otherUser.id, organizationId, { role: "member" });
    const task = await seedChatopsTask({
      actorUserId: otherUser.id,
      withTarget: true,
    });
    const upload = vi
      .spyOn(chatOpsManager, "uploadFileToBindingThread")
      .mockResolvedValue();

    const result = await executeArchestraTool(
      TOOL_POST_TASK_FILE_FULL_NAME,
      {
        task_id: task.id,
        filename: "demo.mp4",
        content_base64: Buffer.from("x").toString("base64"),
      },
      context,
    );

    expect(result.isError).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    upload.mockRestore();
  });
});
