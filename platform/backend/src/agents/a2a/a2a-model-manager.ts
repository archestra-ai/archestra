import type { UIMessage } from "ai";
import z from "zod";
import {
  A2AArtifactModel,
  A2AContextModel,
  A2AMessageModel,
  A2ATaskApprovalRequestModel,
  A2ATaskModel,
} from "@/models";
import { A2AMessageIdExistsError } from "@/models/a2a-message";
import type { A2AArtifact, A2AContext, A2AMessage, A2ATask } from "@/types";
import { type A2AActor, A2AError, A2AErrorKind } from "./a2a-base";
import {
  type A2AArchestraApprovalRequest,
  A2AArchestraApprovalRequestSchema,
  type A2AArchestraTaskApprovalDecision,
  type A2AProtocolArtifact,
  type A2AProtocolMessage,
  type A2AProtocolPart,
  A2AProtocolRole,
  type A2AProtocolTask,
  type A2AProtocolTaskState,
} from "./a2a-protocol";

export type A2ATaskWithData = A2ATask & {
  approvalRequests: A2AArchestraApprovalRequest[];
  history: A2AMessage[];
  statusMessage?: A2AMessage;
  artifacts?: A2AArtifact[];
};

/**
 * Context/task lookups are actor-owned by default. Trusted internal callers
 * that authorize access themselves (the chatops manager verifies channel
 * membership and agent access before executing) may share one context across
 * several actors — e.g. a Telegram group thread where every linked member
 * talks to the same conversation.
 */
interface A2AContextAccessOptions {
  trustedActorAccess?: boolean;
}

export class A2AContextManager {
  static async findAndValidateContext(
    contextId: string,
    actor: A2AActor,
    options?: A2AContextAccessOptions,
  ): Promise<A2AContext> {
    const context = await A2AContextModel.findById(contextId);
    if (
      !context ||
      (!options?.trustedActorAccess &&
        (context.actorKind !== actor.kind || context.actorId !== actor.id))
    ) {
      throw new A2AError(A2AErrorKind.ContextNotFound);
    }
    return context;
  }

  static async createContext(actor: A2AActor): Promise<A2AContext> {
    return await A2AContextModel.create({
      actorKind: actor.kind,
      actorId: actor.id,
    });
  }

  static async addMessageToContext(params: {
    context: A2AContext;
    message: A2AProtocolMessage;
    uiMessage: UIMessage;
  }): Promise<{
    context: A2AContext;
    dbMessage: A2AMessage;
    protocolMessage: A2AProtocolMessage;
  }> {
    const { context, message, uiMessage } = params;
    if (message.contextId && message.contextId !== context.id) {
      // This should never happen.
      throw new Error(
        "[A2AModelManager] Message contextId does not match the context",
      );
    }
    message.contextId = context.id;
    try {
      const dbMessage = await A2AMessageModel.createWithId({
        id: message.messageId,
        contextId: context.id,
        role: message.role,
        parts: message.parts || [],
        content: uiMessage,
      });
      return { context, dbMessage, protocolMessage: message };
    } catch (error) {
      if (error instanceof A2AMessageIdExistsError) {
        throw new A2AError(A2AErrorKind.MessageIdAlreadyExists);
      }
      throw error;
    }
  }

  /**
   * Return context messages from the db but override with the provided messages if there are id matches.
   * This is required when some messages are recently updated and not yet reflected in the db,
   * to avoid stale data reading.
   */
  static async getContextMessagesWithOverrides(params: {
    context: A2AContext;
    override: A2AMessage[];
  }): Promise<A2AMessage[]> {
    const { context, override } = params;
    const messages = await A2AMessageModel.findByContextId(context.id);
    const overrideMap: Record<string, A2AMessage> = {};
    override.forEach((m) => {
      overrideMap[m.id] = m;
    });
    return messages.map((m) => {
      if (overrideMap[m.id]) {
        return overrideMap[m.id];
      }
      return m;
    });
  }
}

export class A2ATaskManager {
  static toProtocolTask(
    task: A2ATaskWithData,
    options?: {
      /**
       * A2A `history_length`: undefined = full history, 0 = omit the field
       * entirely, N > 0 = at most the N most recent messages.
       */
      historyLength?: number;
      /** When false the `artifacts` field is omitted entirely (ListTasks). */
      includeArtifacts?: boolean;
    },
  ): A2AProtocolTask {
    const { historyLength, includeArtifacts = true } = options ?? {};

    // A FAILED/CANCELED task carries its reason as the status message when no
    // agent message describes the outcome (the spec's TaskStatus.message is
    // exactly this: an update relevant to the status).
    const statusMessage = task.statusMessage
      ? getA2AProtocolMessageByA2AModelMessage(task.statusMessage)
      : task.statusReason
        ? {
            messageId: `${task.id}-status`,
            contextId: task.contextId,
            taskId: task.id,
            role: A2AProtocolRole.Agent,
            parts: [{ text: task.statusReason }],
          }
        : undefined;

    const history =
      historyLength === 0
        ? undefined
        : historyLength !== undefined
          ? task.history.slice(-historyLength)
          : task.history;

    return {
      id: task.id,
      contextId: task.contextId,
      status: {
        state: task.state,
        message: statusMessage,
        ...(task.stateChangedAt
          ? { timestamp: task.stateChangedAt.toISOString() }
          : {}),
      },
      ...(includeArtifacts && task.artifacts?.length
        ? { artifacts: task.artifacts.map(toProtocolArtifact) }
        : {}),
      ...(history
        ? { history: history.map(getA2AProtocolMessageByA2AModelMessage) }
        : {}),
      metadata: {
        approvalRequests: z
          .array(A2AArchestraApprovalRequestSchema)
          .parse(task.approvalRequests),
      },
    };
  }

  static async findAndValidateTaskWithContext(
    taskId: string,
    context: A2AContext | undefined,
    actor: A2AActor,
    options?: A2AContextAccessOptions,
  ): Promise<{ task: A2ATaskWithData; context: A2AContext }> {
    const task = await A2ATaskModel.findById(taskId);
    if (!task) {
      throw new A2AError(A2AErrorKind.TaskNotFound);
    }
    if (!context) {
      context = await A2AContextManager.findAndValidateContext(
        task.contextId,
        actor,
        options,
      );
    }
    if (context.id !== task.contextId) {
      throw new A2AError(A2AErrorKind.TaskContextMismatch);
    }

    return { task: await A2ATaskManager.loadTaskWithData(task), context };
  }

  /**
   * Load a task's associated data (approvals, history, artifacts) WITHOUT
   * authorization — for callers that already validated access, e.g. a run
   * refreshing its own task after a lifecycle transition.
   */
  static async loadTaskWithData(task: A2ATask): Promise<A2ATaskWithData> {
    const [approvalRequestRows, history, artifacts] = await Promise.all([
      A2ATaskApprovalRequestModel.findByTaskId(task.id)
        // Sort for deterministic persistence
        .then((reqs) =>
          reqs.sort((a, b) => a.approvalId.localeCompare(b.approvalId)),
        ),
      A2AMessageModel.findByTaskId(task.id),
      A2AArtifactModel.findByTaskId(task.id),
    ]);
    const approvalRequests = z
      .array(A2AArchestraApprovalRequestSchema)
      .parse(approvalRequestRows);

    // The status message is the latest AGENT message: surfacing whatever
    // happens to be last would hand a just-appended USER turn back as the
    // task's status (and ChatOps renders status messages verbatim).
    const statusMessage = [...history]
      .reverse()
      .find((m) => m.role === A2AProtocolRole.Agent);

    return { ...task, approvalRequests, history, statusMessage, artifacts };
  }

  /** {@link loadTaskWithData} by id; throws TaskNotFound when the row is gone. */
  static async loadTaskWithDataById(taskId: string): Promise<A2ATaskWithData> {
    const task = await A2ATaskModel.findById(taskId);
    if (!task) {
      throw new A2AError(A2AErrorKind.TaskNotFound);
    }
    return await A2ATaskManager.loadTaskWithData(task);
  }

  static async createTask(params: {
    context: A2AContext;
    actor: A2AActor;
    state: A2AProtocolTaskState;
    approvalRequests: A2AArchestraApprovalRequest[];
    agentId?: string;
    options?: A2AContextAccessOptions;
  }): Promise<A2ATaskWithData> {
    const {
      context,
      actor,
      state,
      approvalRequests: approvalRequestInput,
    } = params;

    // Sort for deterministic persistence
    const approvalRequests = [...approvalRequestInput].sort((a, b) =>
      a.approvalId.localeCompare(b.approvalId),
    );

    if (
      !params.options?.trustedActorAccess &&
      (context.actorKind !== actor.kind || context.actorId !== actor.id)
    ) {
      // This should never happen. Context is always validated or created for the same actor.
      throw new Error(
        "[A2AModelManager] Actor is not the owner of the context when creating task",
      );
    }

    const task = await A2ATaskModel.create({
      contextId: context.id,
      state,
      agentId: params.agentId,
    });

    await A2ATaskApprovalRequestModel.bulkCreate({
      taskId: task.id,
      approvalRequests,
    });
    return { ...task, approvalRequests, history: [], artifacts: [] };
  }

  static async addMessageToTask(params: {
    task: A2ATaskWithData;
    message: A2AProtocolMessage;
    uiMessage: UIMessage;
  }): Promise<{
    task: A2ATaskWithData;
    dbMessage: A2AMessage;
    protocolMessage: A2AProtocolMessage;
  }> {
    const { task, message, uiMessage } = params;

    if (message.taskId && message.taskId !== task.id) {
      // This should never happen.
      throw new Error(
        "[A2AModelManager] Message taskId does not match the task",
      );
    }
    message.taskId = task.id;
    if (message.contextId && message.contextId !== task.contextId) {
      // This should never happen.
      throw new Error(
        "[A2AModelManager] Message contextId does not match the task's contextId",
      );
    }
    message.contextId = task.contextId;

    if (
      task.history.length > 0 &&
      (task.history[task.history.length - 1].content as UIMessage).id ===
        uiMessage.id
    ) {
      // We need to update the last message instead of creating a new one
      const history = [
        ...task.history.slice(0, -1),
        {
          ...task.history[task.history.length - 1],
          parts: message.parts || [],
          content: uiMessage,
        },
      ];
      const statusMessage =
        history[history.length - 1].role === A2AProtocolRole.Agent
          ? history[history.length - 1]
          : task.statusMessage;
      await A2AMessageModel.updateContentAndParts(
        task.history[task.history.length - 1].id,
        uiMessage,
        message.parts || [],
      );
      return {
        task: { ...task, history, statusMessage },
        dbMessage: task.history[task.history.length - 1],
        protocolMessage: message,
      };
    }

    try {
      const modelMessage = await A2AMessageModel.createWithId({
        id: message.messageId,
        contextId: task.contextId,
        taskId: task.id,
        role: message.role,
        parts: message.parts || [],
        content: uiMessage,
      });
      const statusMessage =
        modelMessage.role === A2AProtocolRole.Agent
          ? modelMessage
          : task.statusMessage;
      const history = [...task.history, modelMessage];
      return {
        task: { ...task, history, statusMessage },
        dbMessage: modelMessage,
        protocolMessage: message,
      };
    } catch (error) {
      if (error instanceof A2AMessageIdExistsError) {
        throw new A2AError(A2AErrorKind.MessageIdAlreadyExists);
      }
      throw error;
    }
  }

  static async addApprovalRequestsToTask(
    task: A2ATaskWithData,
    approvalRequests: A2AArchestraApprovalRequest[],
  ): Promise<A2ATaskWithData> {
    await A2ATaskApprovalRequestModel.bulkCreate({
      taskId: task.id,
      approvalRequests,
    });
    return { ...task, approvalRequests };
  }

  static async updateTaskApprovalDecisions(params: {
    task: A2ATaskWithData;
    approvalDecisions: A2AArchestraTaskApprovalDecision[];
  }): Promise<A2ATaskWithData> {
    const { task, approvalDecisions } = params;
    await A2ATaskApprovalRequestModel.updateTaskApprovalDecisions({
      taskId: task.id,
      approvalDecisions,
    });

    // Update the task object with new approval decisions locally to avoid stale data reading
    const approvalDecisionsMap: Record<
      string,
      A2AArchestraTaskApprovalDecision
    > = {};
    approvalDecisions.forEach((d) => {
      approvalDecisionsMap[d.approvalId] = d;
    });
    const updatedApprovalRequests = task.approvalRequests.map((req) => {
      const decision = approvalDecisionsMap[req.approvalId];
      if (decision) {
        return { ...req, approved: decision.approved, resolved: true };
      }
      return req;
    });

    return { ...task, approvalRequests: updatedApprovalRequests };
  }

  static async removeTaskApprovalRequests(
    task: A2ATaskWithData,
  ): Promise<A2ATaskWithData> {
    await A2ATaskApprovalRequestModel.deleteByTaskId(task.id);
    return { ...task, approvalRequests: [] };
  }

  static async updateTaskState(
    task: A2ATaskWithData,
    state: A2AProtocolTaskState,
  ): Promise<A2ATaskWithData> {
    const updated = await A2ATaskModel.updateState(task.id, state);
    // Merge the refreshed row so callers hold the real persisted state (e.g.
    // stateChangedAt) rather than a stale in-memory copy.
    return updated ? { ...task, ...updated } : { ...task, state };
  }
}

export function getApprovalRequestsMap(
  approvalRequests: A2AArchestraApprovalRequest[],
): Record<string, A2AArchestraApprovalRequest> {
  const map: Record<string, A2AArchestraApprovalRequest> = {};
  approvalRequests.forEach((r) => {
    map[r.approvalId] = r;
  });
  return map;
}

function getA2AProtocolMessageByA2AModelMessage(
  message: A2AMessage,
): A2AProtocolMessage {
  return {
    messageId: message.id,
    contextId: message.contextId,
    taskId: message.taskId || undefined,
    role: message.role as A2AProtocolRole,
    parts: message.parts as A2AProtocolPart[],
  };
}

function toProtocolArtifact(artifact: A2AArtifact): A2AProtocolArtifact {
  return {
    artifactId: artifact.id,
    name: artifact.name,
    ...(artifact.description ? { description: artifact.description } : {}),
    parts: artifact.parts,
    ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
  };
}
