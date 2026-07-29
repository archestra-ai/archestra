import { vi } from "vitest";
import {
  A2AArtifactModel,
  A2AMessageModel,
  A2ATaskModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import { type A2AActor, A2AError, A2AErrorKind } from "./a2a-base";
import { buildApprovalDecisionSendMessageRequest } from "./a2a-helper";
import { A2AManager } from "./a2a-manager";
import { A2AContextManager, A2ATaskManager } from "./a2a-model-manager";
import {
  type A2AProtocolPart,
  A2AProtocolRole,
  type A2AProtocolSendMessageResponse,
  A2AProtocolTaskState,
} from "./a2a-protocol";

const { executeA2AMessage } = vi.hoisted(() => ({
  executeA2AMessage: vi.fn(),
}));

vi.mock("@/agents/a2a-executor.ts", () => ({
  executeA2AMessage,
}));

const actor: A2AActor = {
  id: "actor1",
  kind: "user",
  organizationId: "org1",
};

const otherActor: A2AActor = {
  id: "actor2",
  kind: "user",
  organizationId: "org1",
};

function fullManager() {
  return new A2AManager({ taskMode: "full" });
}

async function sendMessage(params: {
  manager: A2AManager;
  agentId: string;
  parts?: A2AProtocolPart[];
  contextId?: string;
  taskId?: string;
  taskRun?: { createTask: boolean; detached: boolean };
  onDetachedTaskRun?: (info: { taskId: string; followFromSeq: number }) => void;
}): Promise<A2AProtocolSendMessageResponse> {
  return await params.manager.sendMessage({
    actor,
    agentId: params.agentId,
    request: {
      message: {
        messageId: crypto.randomUUID(),
        role: A2AProtocolRole.User,
        ...(params.contextId ? { contextId: params.contextId } : {}),
        ...(params.taskId ? { taskId: params.taskId } : {}),
        parts: params.parts ?? [{ text: "Hello!" }],
      },
    },
    taskRun: params.taskRun,
    onDetachedTaskRun: params.onDetachedTaskRun,
  });
}

function mockExecutorText(text: string) {
  executeA2AMessage.mockImplementation(
    async (args: { onTextDelta?: (d: string) => void }) => {
      const messageId = crypto.randomUUID();
      args.onTextDelta?.(text);
      return {
        messageId,
        text,
        finishReason: "stop",
        responseUiMessage: {
          id: messageId,
          role: "assistant",
          parts: [{ type: "text", text }],
        },
      };
    },
  );
}

/**
 * Executor that blocks until released (or rejects on abort). `release`
 * awaits the (asynchronous, detached) executor invocation before resolving
 * it, so tests can release immediately after the send returns.
 */
function mockExecutorGated() {
  let release: ((text: string) => void) | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  executeA2AMessage.mockImplementation(
    (args: { abortSignal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        args.abortSignal?.addEventListener("abort", () =>
          reject(new Error("run aborted")),
        );
        release = (text: string) => {
          const messageId = crypto.randomUUID();
          resolve({
            messageId,
            text,
            finishReason: "stop",
            responseUiMessage: {
              id: messageId,
              role: "assistant",
              parts: [{ type: "text", text }],
            },
          });
        };
        markStarted();
      }),
  );
  return {
    release: async (text: string) => {
      await started;
      release?.(text);
    },
  };
}

async function waitForState(
  taskId: string,
  state: A2AProtocolTaskState,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await A2ATaskModel.findById(taskId);
    if (task?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const task = await A2ATaskModel.findById(taskId);
  throw new Error(
    `Task ${taskId} never reached ${state} (currently ${task?.state})`,
  );
}

describe("A2AManager full task mode", () => {
  test("blocking tasked run walks SUBMITTED -> WORKING -> COMPLETED with artifact, events, and timestamps", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "agent1", teams: [] });
    const manager = fullManager();
    mockExecutorText("The answer");

    const response = await sendMessage({
      manager,
      agentId: agent.id,
      taskRun: { createTask: true, detached: false },
    });

    if (!response.task) throw new Error("expected a task response");
    expect(response.task.status.state).toBe(A2AProtocolTaskState.Completed);
    expect(response.task.status.timestamp).toEqual(expect.any(String));

    // The final answer is materialized as a text artifact.
    expect(response.task.artifacts).toEqual([
      {
        artifactId: expect.any(String),
        name: "agent-response",
        parts: [{ text: "The answer" }],
      },
    ]);

    // History carries the user turn and the agent answer, task-bound.
    expect(response.task.history).toEqual([
      expect.objectContaining({
        role: A2AProtocolRole.User,
        parts: [{ text: "Hello!" }],
      }),
      expect.objectContaining({
        role: A2AProtocolRole.Agent,
        parts: [{ text: "The answer" }],
      }),
    ]);

    // The durable event log ends with the artifact seal + terminal status,
    // committed atomically with the terminal state.
    const events = await manager.readTaskEventsAfter({
      taskId: response.task.id,
      afterSeq: 0,
    });
    if (!events) throw new Error("expected events");
    expect(events.state).toBe(A2AProtocolTaskState.Completed);
    const seqs = events.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const payloads = events.events.map((e) => e.payload);
    expect(payloads[0]?.statusUpdate?.status.state).toBe(
      A2AProtocolTaskState.Working,
    );
    const last = payloads[payloads.length - 1];
    expect(last?.statusUpdate?.status.state).toBe(
      A2AProtocolTaskState.Completed,
    );
    const seal = payloads[payloads.length - 2];
    expect(seal?.artifactUpdate?.lastChunk).toBe(true);
    expect(seal?.artifactUpdate?.artifact.parts).toEqual([
      { text: "The answer" },
    ]);
  });

  test("executor failure persists TASK_STATE_FAILED with a reason and a terminal event", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "agent1", teams: [] });
    const manager = fullManager();
    executeA2AMessage.mockRejectedValue(new Error("provider exploded"));

    await expect(
      sendMessage({
        manager,
        agentId: agent.id,
        taskRun: { createTask: true, detached: false },
      }),
    ).rejects.toThrow("provider exploded");

    // The durable outcome is FAILED even though the blocking caller got the
    // error — detached observers (GetTask pollers) see the same truth.
    const list = await manager.listTasks({
      actor,
      agentId: agent.id,
      request: { status: "TASK_STATE_FAILED" },
    });
    expect(list.totalSize).toBe(1);
    const failed = list.tasks[0];
    expect(failed.status.state).toBe(A2AProtocolTaskState.Failed);
    // The failure reason is surfaced as the status message.
    expect(failed.status.message?.parts?.[0]?.text).toContain(
      "provider exploded",
    );

    const events = await manager.readTaskEventsAfter({
      taskId: failed.id,
      afterSeq: 0,
    });
    expect(
      events?.events.at(-1)?.payload.statusUpdate?.status.state,
    ).toBe(A2AProtocolTaskState.Failed);
  });

  test("cancelTask settles a running task first and the finishing run cannot overwrite it", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "agent1", teams: [] });
    const manager = fullManager();
    const gate = mockExecutorGated();

    let detached: { taskId: string } | undefined;
    const response = await sendMessage({
      manager,
      agentId: agent.id,
      taskRun: { createTask: true, detached: true },
      onDetachedTaskRun: (info) => {
        detached = info;
      },
    });
    if (!response.task || !detached) throw new Error("expected detached task");
    const taskId = detached.taskId;
    await waitForState(taskId, A2AProtocolTaskState.Working);

    const canceled = await manager.cancelTask({
      actor,
      agentId: agent.id,
      request: { id: taskId },
    });
    expect(canceled.status.state).toBe(A2AProtocolTaskState.Canceled);

    // Even if the run "finishes" after cancellation, the completion CAS
    // loses and its outputs roll back.
    await gate.release("too late");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const row = await A2ATaskModel.findById(taskId);
    expect(row?.state).toBe("TASK_STATE_CANCELED");
    expect(await A2AArtifactModel.findByTaskId(taskId)).toEqual([]);
    const agentMessages = (await A2AMessageModel.findByTaskId(taskId)).filter(
      (m) => m.role === A2AProtocolRole.Agent,
    );
    expect(agentMessages).toEqual([]);

    // Canceling a canceled (terminal) task is TaskNotCancelable (-32002).
    const err = await manager
      .cancelTask({ actor, agentId: agent.id, request: { id: taskId } })
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toBeInstanceOf(A2AError);
    expect((err as A2AError).kind).toBe(A2AErrorKind.TaskNotCancelable);
    expect((err as A2AError).code).toBe(-32002);
  });

  test("messages to terminal or running tasks are rejected with UnsupportedOperation (-32004)", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "agent1", teams: [] });
    const manager = fullManager();

    // Terminal task.
    mockExecutorText("done");
    const completed = await sendMessage({
      manager,
      agentId: agent.id,
      taskRun: { createTask: true, detached: false },
    });
    if (!completed.task) throw new Error("expected task");

    const errTerminal = await sendMessage({
      manager,
      agentId: agent.id,
      contextId: completed.task.contextId,
      taskId: completed.task.id,
      parts: [{ text: "follow-up" }],
    }).then(
      () => null,
      (e) => e,
    );
    expect(errTerminal).toBeInstanceOf(A2AError);
    expect((errTerminal as A2AError).kind).toBe(
      A2AErrorKind.UnsupportedOperation,
    );
    expect((errTerminal as A2AError).code).toBe(-32004);

    // Running task.
    const gate = mockExecutorGated();
    let detached: { taskId: string } | undefined;
    const running = await sendMessage({
      manager,
      agentId: agent.id,
      taskRun: { createTask: true, detached: true },
      onDetachedTaskRun: (info) => {
        detached = info;
      },
    });
    if (!running.task || !detached) throw new Error("expected detached task");
    await waitForState(detached.taskId, A2AProtocolTaskState.Working);

    const errRunning = await sendMessage({
      manager,
      agentId: agent.id,
      contextId: running.task.contextId,
      taskId: detached.taskId,
      parts: [{ text: "impatient follow-up" }],
    }).then(
      () => null,
      (e) => e,
    );
    expect(errRunning).toBeInstanceOf(A2AError);
    expect((errRunning as A2AError).kind).toBe(
      A2AErrorKind.UnsupportedOperation,
    );

    await gate.release("finished");
    await waitForState(detached.taskId, A2AProtocolTaskState.Completed);
  });

  test("detached run (returnImmediately) hands back the task before the answer exists, then completes", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "agent1", teams: [] });
    const manager = fullManager();
    const gate = mockExecutorGated();

    let watermark: number | undefined;
    let taskId: string | undefined;
    const response = await sendMessage({
      manager,
      agentId: agent.id,
      taskRun: { createTask: true, detached: true },
      onDetachedTaskRun: (info) => {
        taskId = info.taskId;
        watermark = info.followFromSeq;
      },
    });
    if (!response.task || !taskId) throw new Error("expected detached task");
    expect(watermark).toBe(0);
    // The snapshot is handed back before any run outcome exists.
    expect(response.task.status.state).toBe(A2AProtocolTaskState.Submitted);
    expect(response.task.artifacts).toBeUndefined();

    await gate.release("the eventual answer");
    await waitForState(taskId, A2AProtocolTaskState.Completed);

    // GetTask (the polling surface) serves the settled outcome.
    const polled = await manager.getTask({
      actor,
      agentId: agent.id,
      request: { id: taskId },
    });
    expect(polled.status.state).toBe(A2AProtocolTaskState.Completed);
    expect(polled.artifacts?.[0]?.parts).toEqual([
      { text: "the eventual answer" },
    ]);

    // historyLength=0 omits history entirely per spec.
    const noHistory = await manager.getTask({
      actor,
      agentId: agent.id,
      request: { id: taskId, historyLength: 0 },
    });
    expect(noHistory.history).toBeUndefined();
  });

  test("approval flow: interrupt, cancel while input-required clears approvals", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "agent1", teams: [] });
    const manager = fullManager();
    const approvalMessageId = crypto.randomUUID();
    executeA2AMessage.mockResolvedValue({
      responseUiMessage: {
        id: approvalMessageId,
        role: "assistant",
        parts: [
          {
            type: "tool-tool-1",
            state: "approval-requested",
            approval: { id: "approval-1" },
            toolCallId: "toolCall-1",
          },
        ],
      },
    });

    const response = await sendMessage({
      manager,
      agentId: agent.id,
      taskRun: { createTask: true, detached: false },
    });
    if (!response.task) throw new Error("expected task");
    expect(response.task.status.state).toBe(
      A2AProtocolTaskState.InputRequired,
    );
    expect(response.task.metadata?.approvalRequests).toHaveLength(1);

    const canceled = await manager.cancelTask({
      actor,
      agentId: agent.id,
      request: { id: response.task.id },
    });
    expect(canceled.status.state).toBe(A2AProtocolTaskState.Canceled);
    // Cancellation cleared the pending approval requests.
    expect(canceled.metadata?.approvalRequests).toEqual([]);

    // Approval decisions against the canceled task are rejected.
    const err = await manager
      .sendMessage({
        actor,
        agentId: agent.id,
        request: buildApprovalDecisionSendMessageRequest({
          taskId: response.task.id,
          approvalDecisions: [{ approvalId: "approval-1", approved: true }],
        }),
      })
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toBeInstanceOf(A2AError);
    expect((err as A2AError).kind).toBe(A2AErrorKind.UnsupportedOperation);
  });

  test("approval resume completes as a task response with the resumed answer", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "agent1", teams: [] });
    const manager = fullManager();
    const approvalMessageId = crypto.randomUUID();
    executeA2AMessage.mockResolvedValue({
      responseUiMessage: {
        id: approvalMessageId,
        role: "assistant",
        parts: [
          {
            type: "tool-tool-1",
            state: "approval-requested",
            approval: { id: "approval-1" },
            toolCallId: "toolCall-1",
          },
        ],
      },
    });

    const interrupted = await sendMessage({
      manager,
      agentId: agent.id,
      taskRun: { createTask: true, detached: false },
    });
    if (!interrupted.task) throw new Error("expected task");

    // The resumed run finalizes the same UI message with the tool result.
    executeA2AMessage.mockResolvedValue({
      messageId: approvalMessageId,
      text: "tool ran, here is the result",
      finishReason: "stop",
      responseUiMessage: {
        id: approvalMessageId,
        role: "assistant",
        parts: [{ type: "text", text: "tool ran, here is the result" }],
      },
    });

    const resumed = await manager.sendMessage({
      actor,
      agentId: agent.id,
      request: buildApprovalDecisionSendMessageRequest({
        taskId: interrupted.task.id,
        approvalDecisions: [{ approvalId: "approval-1", approved: true }],
      }),
    });

    // Full task mode returns the completed TASK (spec's one-way door), not a
    // bare message.
    if (!resumed.task) throw new Error("expected task response");
    expect(resumed.message).toBeUndefined();
    expect(resumed.task.id).toBe(interrupted.task.id);
    expect(resumed.task.status.state).toBe(A2AProtocolTaskState.Completed);
    expect(resumed.task.metadata?.approvalRequests).toEqual([]);
  });

  test("task access is agent-bound; unknown and foreign tasks are indistinguishable", async ({
    makeAgent,
  }) => {
    const agentA = await makeAgent({ name: "agentA", teams: [] });
    const agentB = await makeAgent({ name: "agentB", teams: [] });
    const manager = fullManager();
    mockExecutorText("bound answer");

    const response = await sendMessage({
      manager,
      agentId: agentA.id,
      taskRun: { createTask: true, detached: false },
    });
    if (!response.task) throw new Error("expected task");

    // Same actor, different agent: TaskNotFound, not a distinguishable error.
    for (const attempt of [
      () =>
        manager.getTask({
          actor,
          agentId: agentB.id,
          request: { id: response.task?.id ?? "" },
        }),
      () =>
        manager.cancelTask({
          actor,
          agentId: agentB.id,
          request: { id: response.task?.id ?? "" },
        }),
      () =>
        manager.subscribeToTask({
          actor,
          agentId: agentB.id,
          request: { id: response.task?.id ?? "" },
        }),
    ]) {
      const err = await attempt().then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(A2AError);
      expect((err as A2AError).kind).toBe(A2AErrorKind.TaskNotFound);
      expect((err as A2AError).code).toBe(-32001);
    }

    // A pre-migration task with no agent binding stays reachable through the
    // actor/context ownership check alone.
    const legacyContext = await A2AContextManager.createContext(actor);
    const legacyTask = await A2ATaskModel.create({
      contextId: legacyContext.id,
      state: "TASK_STATE_INPUT_REQUIRED",
    });
    const canceled = await manager.cancelTask({
      actor,
      agentId: agentA.id,
      request: { id: legacyTask.id },
    });
    expect(canceled.status.state).toBe(A2AProtocolTaskState.Canceled);
  });

  test("subscribeToTask rejects terminal tasks and hands live tasks a watermark-bound snapshot", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "agent1", teams: [] });
    const manager = fullManager();
    const gate = mockExecutorGated();

    let detached: { taskId: string } | undefined;
    await sendMessage({
      manager,
      agentId: agent.id,
      taskRun: { createTask: true, detached: true },
      onDetachedTaskRun: (info) => {
        detached = info;
      },
    });
    if (!detached) throw new Error("expected detached task");
    await waitForState(detached.taskId, A2AProtocolTaskState.Working);

    const subscription = await manager.subscribeToTask({
      actor,
      agentId: agent.id,
      request: { id: detached.taskId },
    });
    expect(subscription.task.id).toBe(detached.taskId);
    expect(subscription.watermark).toBeGreaterThanOrEqual(1);

    await gate.release("subscribed answer");
    await waitForState(detached.taskId, A2AProtocolTaskState.Completed);

    // Events strictly after the watermark end with the terminal status; two
    // independent readers observe the identical sequence.
    const [readA, readB] = await Promise.all([
      manager.readTaskEventsAfter({
        taskId: detached.taskId,
        afterSeq: subscription.watermark,
      }),
      manager.readTaskEventsAfter({
        taskId: detached.taskId,
        afterSeq: subscription.watermark,
      }),
    ]);
    expect(readA).toEqual(readB);
    expect(
      readA?.events.at(-1)?.payload.statusUpdate?.status.state,
    ).toBe(A2AProtocolTaskState.Completed);

    const err = await manager
      .subscribeToTask({
        actor,
        agentId: agent.id,
        request: { id: detached.taskId },
      })
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toBeInstanceOf(A2AError);
    expect((err as A2AError).kind).toBe(A2AErrorKind.UnsupportedOperation);
  });

  test("listTasks paginates on a stable cursor, filters, and never leaks across actors", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "agent1", teams: [] });
    const manager = fullManager();
    mockExecutorText("answer");

    const taskIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await sendMessage({
        manager,
        agentId: agent.id,
        parts: [{ text: `question ${i}` }],
        taskRun: { createTask: true, detached: false },
      });
      if (!response.task) throw new Error("expected task");
      taskIds.push(response.task.id);
    }

    // Another actor's task in the same org must not appear.
    const foreignManager = fullManager();
    await foreignManager.sendMessage({
      actor: otherActor,
      agentId: agent.id,
      request: {
        message: {
          messageId: crypto.randomUUID(),
          role: A2AProtocolRole.User,
          parts: [{ text: "foreign" }],
        },
      },
      taskRun: { createTask: true, detached: false },
    });

    const page1 = await manager.listTasks({
      actor,
      agentId: agent.id,
      request: { pageSize: 2 },
    });
    expect(page1.totalSize).toBe(3);
    expect(page1.tasks).toHaveLength(2);
    expect(page1.nextPageToken).not.toBe("");
    // Ordered by status change desc: latest first, artifacts omitted, history
    // omitted by default (historyLength defaults to 0 on ListTasks).
    expect(page1.tasks[0].id).toBe(taskIds[2]);
    expect(page1.tasks[0].artifacts).toBeUndefined();
    expect(page1.tasks[0].history).toBeUndefined();

    const page2 = await manager.listTasks({
      actor,
      agentId: agent.id,
      request: { pageSize: 2, pageToken: page1.nextPageToken },
    });
    expect(page2.tasks.map((t) => t.id)).toEqual([taskIds[0]]);

    // Pages never overlap or skip.
    const allIds = [...page1.tasks, ...page2.tasks].map((t) => t.id);
    expect(new Set(allIds).size).toBe(3);
    expect(allIds).toEqual([taskIds[2], taskIds[1], taskIds[0]]);

    // Status filter.
    const completedOnly = await manager.listTasks({
      actor,
      agentId: agent.id,
      request: { status: "TASK_STATE_COMPLETED" },
    });
    expect(completedOnly.totalSize).toBe(3);

    // includeArtifacts=true serves the artifacts.
    const withArtifacts = await manager.listTasks({
      actor,
      agentId: agent.id,
      request: { pageSize: 1, includeArtifacts: true },
    });
    expect(withArtifacts.tasks[0].artifacts).toHaveLength(1);

    // Invalid cursor is rejected as -32602.
    const err = await manager
      .listTasks({
        actor,
        agentId: agent.id,
        request: { pageToken: "not-a-cursor" },
      })
      .then(
        () => null,
        (e) => e,
      );
    expect(err).toBeInstanceOf(A2AError);
    expect((err as A2AError).kind).toBe(A2AErrorKind.InvalidPageToken);
  });

  test("approval-only managers (chatops) are unaffected: plain sends return messages and create no tasks", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "agent1", teams: [] });
    const manager = new A2AManager(); // default approval-only mode
    mockExecutorText("plain answer");

    const before = await A2ATaskModel.getTotalCount();
    const response = await manager.sendMessage({
      actor,
      agentId: agent.id,
      request: {
        message: {
          messageId: crypto.randomUUID(),
          role: A2AProtocolRole.User,
          parts: [{ text: "Hello!" }],
        },
      },
    });
    expect(response.task).toBeUndefined();
    expect(response.message?.parts).toEqual([{ text: "plain answer" }]);
    expect(await A2ATaskModel.getTotalCount()).toBe(before);
  });
});
