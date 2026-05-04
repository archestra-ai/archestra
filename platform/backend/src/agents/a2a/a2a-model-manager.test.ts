import { describe, expect, test } from "@/test";
import { type A2AActor, A2AErrorKind } from "./a2a-base";
import {
  A2AContextManager,
  A2ATaskManager,
  type A2ATaskWithData,
  getApprovalRequestsMap,
} from "./a2a-model-manager";
import { A2AProtocolRole, A2AProtocolTaskState } from "./a2a-protocol";

const actor: A2AActor = {
  kind: "user",
  id: "test-user",
  organizationId: "test-org",
};

async function createEmptyTask() {
  const context = await A2AContextManager.createContext(actor);
  const task = await A2ATaskManager.createTask({
    context,
    actor,
    state: A2AProtocolTaskState.Submitted,
    approvalRequests: [],
  });

  return { context, task };
}

describe("A2AContextManager", () => {
  test("createContext and findAndValidateContext", async () => {
    const context = await A2AContextManager.createContext(actor);

    expect(context.actorKind).toBe(actor.kind);
    expect(context.actorId).toBe(actor.id);
    expect(
      await A2AContextManager.findAndValidateContext(context.id, actor),
    ).toMatchObject({
      id: context.id,
      actorKind: actor.kind,
      actorId: actor.id,
    });
    await expect(
      A2AContextManager.findAndValidateContext(context.id, {
        ...actor,
        id: "other-user",
      }),
    ).rejects.toMatchObject({ kind: A2AErrorKind.ContextNotFound });
  });
});

describe("A2ATaskManager", () => {
  test("toProtocolTask", () => {
    const task = {
      id: "task-1",
      contextId: "context-1",
      state: A2AProtocolTaskState.Working,
      approvalRequests: [
        {
          approvalId: "approval-2",
          toolCallId: "tool-call-2",
          toolName: "Test Tool 2",
          approved: false,
          resolved: false,
        },
        {
          approvalId: "approval-1",
          toolCallId: "tool-call-1",
          toolName: "Test Tool 1",
          approved: true,
          resolved: true,
        },
      ],
      history: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies A2ATaskWithData;

    expect(A2ATaskManager.toProtocolTask(task)).toEqual({
      id: task.id,
      contextId: task.contextId,
      status: {
        message: undefined,
        state: A2AProtocolTaskState.Working,
      },
      history: [],
      metadata: {
        approvalRequests: task.approvalRequests,
      },
    });
  });

  test("getApprovalRequestsMap", () => {
    const task = {
      id: "task-1",
      contextId: "context-1",
      state: A2AProtocolTaskState.Working,
      approvalRequests: [
        {
          approvalId: "approval-2",
          toolCallId: "tool-call-2",
          toolName: "Test Tool 2",
          approved: false,
          resolved: false,
        },
        {
          approvalId: "approval-1",
          toolCallId: "tool-call-1",
          toolName: "Test Tool 1",
          approved: true,
          resolved: true,
        },
      ],
      history: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies A2ATaskWithData;
    expect(getApprovalRequestsMap(task.approvalRequests)).toEqual({
      "approval-2": task.approvalRequests[0],
      "approval-1": task.approvalRequests[1],
    });
  });

  test("createTask sorts approval requests and loads them without a preloaded context", async () => {
    const context = await A2AContextManager.createContext(actor);

    const task = await A2ATaskManager.createTask({
      context,
      actor,
      state: A2AProtocolTaskState.Submitted,
      approvalRequests: [
        {
          approvalId: "approval-2",
          toolCallId: "tool-call-2",
          toolName: "Test Tool 2",
          approved: false,
          resolved: false,
        },
        {
          approvalId: "approval-1",
          toolCallId: "tool-call-1",
          toolName: "Test Tool 1",
          approved: false,
          resolved: false,
        },
      ],
    });

    expect(task.approvalRequests.map(({ approvalId }) => approvalId)).toEqual([
      "approval-1",
      "approval-2",
    ]);

    const loaded = await A2ATaskManager.findAndValidateTaskWithContext(
      task.id,
      undefined,
      actor,
    );
    expect(loaded.context.id).toBe(context.id);
    expect(loaded.task.state).toBe(A2AProtocolTaskState.Submitted);
    expect(
      loaded.task.approvalRequests.map(({ approvalId }) => approvalId),
    ).toEqual(["approval-1", "approval-2"]);
  });

  test("addApprovalRequestsToTask", async () => {
    const { context, task } = await createEmptyTask();
    const withApprovals = await A2ATaskManager.addApprovalRequestsToTask(task, [
      {
        approvalId: "approval-1",
        toolCallId: "tool-call-1",
        toolName: "Test Tool 1",
        approved: false,
        resolved: false,
      },
      {
        approvalId: "approval-2",
        toolCallId: "tool-call-2",
        toolName: "Test Tool 2",
        approved: false,
        resolved: false,
      },
    ]);
    expect(
      withApprovals.approvalRequests.map(({ approvalId }) => approvalId),
    ).toEqual(["approval-1", "approval-2"]);

    expect(
      (
        await A2ATaskManager.findAndValidateTaskWithContext(
          task.id,
          context,
          actor,
        )
      ).task.approvalRequests,
    ).toHaveLength(2);
  });

  test("addMessageToTask", async () => {
    let { context, task } = await createEmptyTask();
    task = await A2ATaskManager.addMessageToTask({
      task,
      message: {
        messageId: "message-1",
        role: A2AProtocolRole.Agent,
        parts: [{ text: "Msg1" }],
      },
      uiMessage: {
        id: "ui-message-1",
        role: "assistant",
        parts: [{ type: "text", text: "UI Msg1" }],
      },
    });

    expect(task.history).toEqual([
      {
        id: expect.any(String),
        contextId: context.id,
        taskId: task.id,
        role: A2AProtocolRole.Agent,
        parts: [{ text: "Msg1" }],
        content: {
          id: "ui-message-1",
          role: "assistant",
          parts: [{ type: "text", text: "UI Msg1" }],
        },
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
    ]);
    expect(task.statusMessage).toEqual(task.history[0]);
    expect(
      (
        await A2ATaskManager.findAndValidateTaskWithContext(
          task.id,
          context,
          actor,
        )
      ).task,
    ).toEqual(task);

    // Replace
    task = await A2ATaskManager.addMessageToTask({
      task,
      message: {
        messageId: "message-1",
        role: A2AProtocolRole.Agent,
        parts: [{ text: "Msg1" }, { text: "Msg1-UPD" }],
      },
      uiMessage: {
        id: "ui-message-1",
        role: "assistant",
        parts: [
          { type: "text", text: "UI Msg1" },
          { type: "text", text: "UI Msg1-UPD" },
        ],
      },
    });

    expect(task.history).toEqual([
      {
        id: expect.any(String),
        contextId: context.id,
        taskId: task.id,
        role: A2AProtocolRole.Agent,
        parts: [{ text: "Msg1" }, { text: "Msg1-UPD" }],
        content: {
          id: "ui-message-1",
          role: "assistant",
          parts: [
            { type: "text", text: "UI Msg1" },
            { type: "text", text: "UI Msg1-UPD" },
          ],
        },
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      },
    ]);
    expect(task.statusMessage).toEqual(task.history[0]);
    // UpdatedAt is not updated locally.
    expect(
      (
        await A2ATaskManager.findAndValidateTaskWithContext(
          task.id,
          context,
          actor,
        )
      ).task,
    ).toEqual({
      ...task,
      history: task.history.map((message) => ({
        ...message,
        updatedAt: expect.any(Date),
      })),
      statusMessage: { ...task.statusMessage, updatedAt: expect.any(Date) },
    });
  });

  test("updateTaskState", async () => {
    const { context, task } = await createEmptyTask();
    const updated = await A2ATaskManager.updateTaskState(
      task,
      A2AProtocolTaskState.Completed,
    );
    expect(updated.state).toBe(A2AProtocolTaskState.Completed);
    expect(
      (
        await A2ATaskManager.findAndValidateTaskWithContext(
          task.id,
          context,
          actor,
        )
      ).task.state,
    ).toBe(A2AProtocolTaskState.Completed);
  });

  test("removeTaskApprovalRequests", async () => {
    const context = await A2AContextManager.createContext(actor);
    const task = await A2ATaskManager.createTask({
      context,
      actor,
      state: A2AProtocolTaskState.Submitted,
      approvalRequests: [
        {
          approvalId: "approval-1",
          toolCallId: "tool-call-1",
          toolName: "Test Tool 1",
          approved: false,
          resolved: false,
        },
        {
          approvalId: "approval-2",
          toolCallId: "tool-call-2",
          toolName: "Test Tool 2",
          approved: false,
          resolved: false,
        },
      ],
    });

    const cleared = await A2ATaskManager.removeTaskApprovalRequests(task);
    expect(cleared.approvalRequests).toEqual([]);
    expect(
      (
        await A2ATaskManager.findAndValidateTaskWithContext(
          task.id,
          context,
          actor,
        )
      ).task.approvalRequests,
    ).toEqual([]);
  });

  test("updateTaskApprovalDecisions", async () => {
    const context = await A2AContextManager.createContext(actor);
    const task = await A2ATaskManager.createTask({
      context,
      actor,
      state: A2AProtocolTaskState.Unspecified,
      approvalRequests: [
        {
          approvalId: "approval-1",
          toolCallId: "tool-call-1",
          toolName: "Test Tool",
          approved: false,
          resolved: false,
        },
        {
          approvalId: "approval-2",
          toolCallId: "tool-call-2",
          toolName: "Test Tool 2",
          approved: false,
          resolved: false,
        },
        {
          approvalId: "approval-3",
          toolCallId: "tool-call-3",
          toolName: "Test Tool 3",
          approved: false,
          resolved: false,
        },
      ],
    });

    const updatedTask = await A2ATaskManager.updateTaskApprovalDecisions({
      task,
      approvalDecisions: [
        { approvalId: "approval-2", approved: false },
        { approvalId: "approval-3", approved: true },
      ],
    });

    expect(updatedTask.approvalRequests).toEqual([
      {
        approvalId: "approval-1",
        toolCallId: "tool-call-1",
        toolName: "Test Tool",
        approved: false,
        resolved: false,
      },
      {
        approvalId: "approval-2",
        toolCallId: "tool-call-2",
        toolName: "Test Tool 2",
        approved: false,
        resolved: true,
      },
      {
        approvalId: "approval-3",
        toolCallId: "tool-call-3",
        toolName: "Test Tool 3",
        approved: true,
        resolved: true,
      },
    ]);

    const taskFromDb = await A2ATaskManager.findAndValidateTaskWithContext(
      task.id,
      context,
      actor,
    );
    expect(taskFromDb.task.approvalRequests).toEqual(
      updatedTask.approvalRequests,
    );
  });
});
