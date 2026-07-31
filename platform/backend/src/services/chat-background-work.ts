import { executeA2AMessage } from "@/agents/a2a-executor";
import logger from "@/logging";
import { ConversationModel, MessageModel } from "@/models";
import ActiveChatRunModel from "@/models/chat-active-run";
import McpGatewayTaskModel from "@/models/mcp-gateway-task";
import { runToolCallMaybeTask } from "@/routes/mcp-gateway/tasks";
import type { McpGatewayTask } from "@/types/mcp-gateway-task";
import {
  broadcastConversationUpdated,
  broadcastConversationWake,
} from "@/websocket";

/**
 * Background work harness for chat conversations.
 *
 * Lets the model hand long-running work (today: subagent delegations) to a
 * durable MCP gateway task and keep control of the conversation. When the
 * task settles, the service waits for the conversation to go idle, persists a
 * harness notification message (role `user`, marked via metadata), and pushes
 * a `conversation_wake` websocket event. A client viewing the conversation
 * submits that notification as an ordinary turn — the model "regains control"
 * through the completely normal streaming path, so approvals, tool cards, and
 * persistence all behave exactly like a user-typed message.
 *
 * Durability: the notification is persisted before the wake is broadcast, so
 * a closed tab just means the result is waiting in the conversation. The task
 * row itself (cancel, TTL, reaper) is owned by the MCP tasks extension.
 */

const IDLE_POLL_INTERVAL_MS = 750;
const IDLE_WAIT_DEADLINE_MS = 15 * 60_000;

interface SpawnDelegationParams {
  conversationId: string;
  /** Parent (calling) agent — owns the task row. */
  agentId: string;
  targetAgentId: string;
  targetAgentName: string;
  /** Delegation tool name (`agent__<slug>`), recorded on the task row. */
  toolName: string;
  message: string;
  userId: string;
  organizationId: string;
  sessionId?: string;
  parentDelegationChain?: string;
}

class ChatBackgroundWorkService {
  /**
   * Run a delegation as a detached background task. Returns as soon as the
   * durable task row exists; the child agent keeps running on this replica
   * and the settle path delivers the result back into the conversation.
   */
  async spawnDelegation(
    params: SpawnDelegationParams,
  ): Promise<{ taskId: string }> {
    const principal = `user:${params.userId}`;

    const result = await runToolCallMaybeTask({
      eligible: true,
      // Detach immediately: the whole point is not to wait.
      thresholdMs: 1,
      agentId: params.agentId,
      principal,
      toolName: params.toolName,
      onSettled: ({ taskId }) => {
        void this.deliverSettledTask({ taskId, ...params }).catch((error) => {
          logger.error(
            { err: error, taskId, conversationId: params.conversationId },
            "Failed to deliver a settled background task to its conversation",
          );
        });
      },
      execute: async (signal) => {
        const res = await executeA2AMessage({
          agentId: params.targetAgentId,
          message: params.message,
          organizationId: params.organizationId,
          userId: params.userId,
          sessionId: params.sessionId,
          parentDelegationChain: params.parentDelegationChain,
          conversationId: params.conversationId,
          abortSignal: signal,
        });
        return { content: [{ type: "text", text: res.text }] };
      },
    });

    if (result?.resultType !== "task" || typeof result.task !== "object") {
      // The child somehow finished inside the 1ms threshold — the result came
      // back synchronously, so deliver it straight into the conversation.
      const text = extractContentText(result);
      await this.persistAndBroadcastNotification({
        conversationId: params.conversationId,
        userId: params.userId,
        organizationId: params.organizationId,
        taskId: `inline-${crypto.randomUUID()}`,
        status: "completed",
        agentName: params.targetAgentName,
        toolName: params.toolName,
        resultText: text,
      });
      return { taskId: "inline" };
    }

    const taskId = (result.task as { taskId: string }).taskId;
    logger.info(
      {
        taskId,
        conversationId: params.conversationId,
        targetAgentId: params.targetAgentId,
        toolName: params.toolName,
      },
      "Spawned background delegation task for chat conversation",
    );
    return { taskId };
  }

  // === Internal ===

  private async deliverSettledTask(
    params: SpawnDelegationParams & { taskId: string },
  ): Promise<void> {
    // The row is the source of truth — a concurrent cancel may have won over
    // the in-process outcome.
    const task = await McpGatewayTaskModel.getForPrincipal({
      taskId: params.taskId,
      agentId: params.agentId,
      principal: `user:${params.userId}`,
    });
    if (!task) {
      logger.warn(
        { taskId: params.taskId, conversationId: params.conversationId },
        "Settled background task row not found (expired?); dropping delivery",
      );
      return;
    }
    if (task.status === "working") {
      // The settle write itself failed; the row will expire. Nothing to say.
      logger.warn(
        { taskId: params.taskId },
        "Background task settled in-process but its row is still working; dropping delivery",
      );
      return;
    }
    if (task.status === "cancelled") {
      // The user cancelled it themselves — waking the model to announce that
      // is noise.
      return;
    }

    await this.persistAndBroadcastNotification({
      conversationId: params.conversationId,
      userId: params.userId,
      organizationId: params.organizationId,
      taskId: task.id,
      status: task.status === "completed" ? "completed" : "failed",
      agentName: params.targetAgentName,
      toolName: params.toolName,
      resultText: taskOutcomeText(task),
    });
  }

  private async persistAndBroadcastNotification(params: {
    conversationId: string;
    userId: string;
    organizationId: string;
    taskId: string;
    status: "completed" | "failed";
    agentName: string;
    toolName: string;
    resultText: string;
  }): Promise<void> {
    await this.waitForConversationIdle(params.conversationId);

    const messageId = `bg-task-${params.taskId}`;
    const headline =
      params.status === "completed"
        ? `[Background task completed] Subagent "${params.agentName}" finished.`
        : `[Background task failed] Subagent "${params.agentName}" failed.`;
    const text = `${headline}\n\n${params.resultText}\n\n(Relay the outcome to the user, connecting it to what they originally asked for.)`;
    const metadata = {
      backgroundTask: {
        taskId: params.taskId,
        status: params.status,
        agentName: params.agentName,
        toolName: params.toolName,
      },
    };

    await MessageModel.create({
      conversationId: params.conversationId,
      role: "user",
      content: {
        id: messageId,
        role: "user",
        parts: [{ type: "text", text }],
        metadata,
      },
    });

    const owner = await ConversationModel.getOwner(params.conversationId);
    const ownerUserId = owner?.userId ?? params.userId;
    const ownerOrgId = owner?.organizationId ?? params.organizationId;
    broadcastConversationUpdated(
      ownerUserId,
      ownerOrgId,
      params.conversationId,
    );
    broadcastConversationWake(ownerUserId, ownerOrgId, {
      conversationId: params.conversationId,
      messageId,
      text,
      metadata,
    });

    logger.info(
      {
        conversationId: params.conversationId,
        taskId: params.taskId,
        status: params.status,
      },
      "Delivered background task notification to conversation",
    );
  }

  /**
   * Wait until the conversation has no running chat turn, so the injected
   * notification can never interleave with an in-flight run's persistence.
   * After the deadline the notification is delivered anyway — it will be
   * picked up whenever the conversation is next opened.
   */
  private async waitForConversationIdle(conversationId: string): Promise<void> {
    const deadline = Date.now() + IDLE_WAIT_DEADLINE_MS;
    while (Date.now() < deadline) {
      const running =
        await ActiveChatRunModel.findRunningByConversation(conversationId);
      if (!running) return;
      await new Promise((resolve) =>
        setTimeout(resolve, IDLE_POLL_INTERVAL_MS),
      );
    }
    logger.warn(
      { conversationId },
      "Conversation stayed busy past the idle-wait deadline; delivering the background task notification anyway",
    );
  }
}

export const chatBackgroundWork = new ChatBackgroundWorkService();

function taskOutcomeText(task: McpGatewayTask): string {
  if (task.status === "completed") {
    const result = task.result;
    return extractContentText(
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : {},
    );
  }
  const error = task.error;
  const message =
    error &&
    typeof error === "object" &&
    !Array.isArray(error) &&
    typeof (error as Record<string, unknown>).message === "string"
      ? ((error as Record<string, unknown>).message as string)
      : "Unknown error";
  return `Error: ${message}`;
}

function extractContentText(result: Record<string, unknown>): string {
  const content = result?.content;
  if (!Array.isArray(content)) return JSON.stringify(result ?? {});
  const text = content
    .map((item) =>
      item && typeof item === "object" && "text" in item
        ? String((item as { text: unknown }).text)
        : JSON.stringify(item),
    )
    .join("\n");
  return text || "(empty result)";
}
