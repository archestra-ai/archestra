import { executeA2AMessage } from "@/agents/a2a-executor";
import logger from "@/logging";
import { ConversationModel } from "@/models";
import McpGatewayTaskModel from "@/models/mcp-gateway-task";
import { runToolCallMaybeTask } from "@/routes/mcp-gateway/tasks";
import { conversationWakeService } from "@/services/conversation-wake";
import type { McpGatewayTask } from "@/types/mcp-gateway-task";
import { trackBackgroundWork } from "@/utils/background-work";

/**
 * Background work harness for chat conversations.
 *
 * Lets the model hand long-running work (today: subagent delegations) to a
 * durable MCP gateway task and keep control of the conversation. When the
 * task settles, the service composes a harness notification and hands it
 * to `conversationWakeService`, which persists it (role `user`, marked via
 * metadata), pushes a `conversation_wake` websocket event, and guarantees a
 * wake turn runs: a viewing browser resubmits it as an ordinary streaming
 * turn, and with no browser around the wake service runs the turn headlessly.
 *
 * Durability: the conversation linkage and delivery context live ON the task
 * row (`conversation_id`, `context`), so delivery never depends on in-process
 * closures — the replica that settles the task delivers, and the reaper
 * delivers a failure notification for tasks whose replica died (see
 * `deliverReapedTask`). The row itself (cancel, TTL) is owned by the MCP
 * tasks extension.
 *
 * Locked chats are refused everywhere in this path: their messages are
 * encrypted under a browser-held key no server-side writer can obtain, so a
 * notification write would silently downgrade the conversation's encryption.
 */

/**
 * Background delegations exist for long-running work, so they outlive the
 * extension's default 30-minute row TTL by design.
 */
const BACKGROUND_DELEGATION_TTL_MS = 24 * 60 * 60 * 1000;

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
  /**
   * Caller's environment, so the child run is billed to it — mirrors the
   * synchronous delegation path.
   */
  callerEnvironmentId?: string | null;
  /** Whether the parent context was still trusted at the delegation boundary. */
  parentContextIsTrusted?: boolean;
  /** What kind of delegation spawned this task (defaults to "delegation"). */
  kind?: "delegation" | "skill";
}

type SpawnDelegationResult =
  /** Detached: the durable task row exists and the child keeps running. */
  | { kind: "task"; taskId: string }
  /** The child finished inside the detach threshold — result came back synchronously. */
  | { kind: "inline"; resultText: string };

class ChatBackgroundWorkService {
  /**
   * Run a delegation as a detached background task. Returns as soon as the
   * durable task row exists; the child agent keeps running on this replica
   * and the settle path delivers the result back into the conversation.
   */
  async spawnDelegation(
    params: SpawnDelegationParams,
  ): Promise<SpawnDelegationResult> {
    const lockInfo = await ConversationModel.getLockedChatKeyInfo(
      params.conversationId,
    );
    if (!lockInfo) {
      throw new Error("Conversation not found.");
    }
    if (lockInfo.lockedChat) {
      // A settled task could never deliver here (see module doc), so refuse
      // up front instead of losing the result later.
      throw new Error(
        "Background delegation is not available in locked chats.",
      );
    }

    const principal = `user:${params.userId}`;

    const result = await runToolCallMaybeTask({
      eligible: true,
      // Detach immediately: the whole point is not to wait.
      thresholdMs: 1,
      ttlMs: BACKGROUND_DELEGATION_TTL_MS,
      agentId: params.agentId,
      principal,
      toolName: params.toolName,
      conversationId: params.conversationId,
      context: {
        kind: params.kind ?? "delegation",
        targetAgentName: params.targetAgentName,
      },
      onSettled: ({ taskId }) => {
        // Registered as background work so graceful shutdown (and the test
        // harness's teardown) can drain an in-flight delivery — it now spans
        // the wake grace window and possibly a whole headless turn.
        trackBackgroundWork(
          this.deliverSettledTask({
            taskId,
            agentId: params.agentId,
            principal,
          }).catch((error) => {
            logger.error(
              { err: error, taskId, conversationId: params.conversationId },
              "Failed to deliver a settled background task to its conversation",
            );
          }),
        );
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
          // Mirrors the synchronous delegation path: bill the child run to
          // the caller's environment and propagate the trust boundary. The
          // parent's isolationKey is deliberately NOT shared — the child
          // outlives the parent turn, so it must not depend on a scope the
          // parent may clean up.
          callerEnvironmentId: params.callerEnvironmentId,
          parentContextIsTrusted: params.parentContextIsTrusted,
          abortSignal: signal,
        });
        return { content: [{ type: "text", text: res.text }] };
      },
    });

    if (result?.resultType !== "task" || typeof result.task !== "object") {
      // The child finished inside the threshold: no task row, no notification
      // — the caller returns the result to the model directly, exactly like a
      // synchronous delegation.
      return { kind: "inline", resultText: extractContentText(result) };
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
    return { kind: "task", taskId };
  }

  /**
   * Deliver the failure notification for a task row the reaper just flipped
   * to `failed` (its executing replica died before settling). Only rows that
   * carry a conversation link are deliverable; anything else is a plain
   * gateway task and is not ours.
   */
  async deliverReapedTask(task: McpGatewayTask): Promise<void> {
    if (!task.conversationId || !task.context) return;
    await this.deliverFromRow(task);
  }

  // === Internal ===

  private async deliverSettledTask(params: {
    taskId: string;
    agentId: string;
    principal: string;
  }): Promise<void> {
    // The row is the source of truth — a concurrent cancel may have won over
    // the in-process outcome.
    const task = await McpGatewayTaskModel.getForPrincipal({
      taskId: params.taskId,
      agentId: params.agentId,
      principal: params.principal,
    });
    if (!task) {
      logger.warn(
        { taskId: params.taskId },
        "Settled background task row not found (expired?); dropping delivery",
      );
      return;
    }
    await this.deliverFromRow(task);
  }

  /**
   * Row-driven delivery: everything needed to compose and route the
   * notification comes from the task row itself, so this works identically
   * for the settling replica and the reaper.
   */
  private async deliverFromRow(task: McpGatewayTask): Promise<void> {
    if (!task.conversationId || !task.context) {
      logger.warn(
        { taskId: task.id },
        "Background task row has no conversation linkage; dropping delivery",
      );
      return;
    }
    if (task.status === "working") {
      // The settle write itself failed; the row will expire and the reaper
      // delivers the failure then. Nothing to say now.
      logger.warn(
        { taskId: task.id },
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
      conversationId: task.conversationId,
      taskId: task.id,
      status: task.status === "completed" ? "completed" : "failed",
      agentName: task.context.targetAgentName,
      toolName: task.toolName,
      resultText: taskOutcomeText(task),
      fallbackUserId: userIdFromPrincipal(task.principal),
    });
  }

  private async persistAndBroadcastNotification(params: {
    conversationId: string;
    taskId: string;
    status: "completed" | "failed";
    agentName: string;
    toolName: string;
    resultText: string;
    /** Used for broadcast scoping only if the owner lookup comes up empty. */
    fallbackUserId: string | null;
  }): Promise<void> {
    const headline =
      params.status === "completed"
        ? `[Background task completed] Subagent "${params.agentName}" finished.`
        : `[Background task failed] Subagent "${params.agentName}" failed.`;
    const delivered = await conversationWakeService.deliver({
      conversationId: params.conversationId,
      messageId: `bg-task-${params.taskId}`,
      text: `${headline}\n\n${params.resultText}\n\n(Relay the outcome to the user, connecting it to what they originally asked for.)`,
      metadata: {
        backgroundTask: {
          taskId: params.taskId,
          status: params.status,
          agentName: params.agentName,
          toolName: params.toolName,
        },
      },
      fallbackUserId: params.fallbackUserId,
    });
    if (delivered) {
      logger.info(
        {
          conversationId: params.conversationId,
          taskId: params.taskId,
          status: params.status,
        },
        "Delivered background task notification to conversation",
      );
    }
  }
}

export const chatBackgroundWork = new ChatBackgroundWorkService();

function userIdFromPrincipal(principal: string): string | null {
  return principal.startsWith("user:") ? principal.slice("user:".length) : null;
}

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
