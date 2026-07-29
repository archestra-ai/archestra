import {
  MCP_TASK_PART_TYPE,
  type McpTaskPartData,
  type McpTaskStatus,
} from "@archestra/shared";
import type { UIMessageChunk } from "ai";
import logger from "@/logging";
import { McpGatewayTaskModel } from "@/models";
// The Tasks layer lives with the gateway route that introduced it. Chat reuses
// it rather than reimplementing the race, so both surfaces mint the same rows
// and `tasks/get` from an external client can observe a chat-started task.
import { runToolCallMaybeTask, TASK_TTL_MS } from "@/routes/mcp-gateway/tasks";
import type { ChatMessage, ChatMessagePart } from "@/types";

export type ChatTaskWriter = {
  write: (chunk: UIMessageChunk) => void;
};

/**
 * Surfaces long-running chat tool calls as durable, cancellable MCP tasks.
 *
 * Chat executes tools in-process, so it never passes through the gateway's
 * `tools/call` handler where the Tasks layer sits. Without this bridge a chat
 * tool call is capped by the ordinary synchronous timeout and simply fails
 * when it runs long. With it, a call that outlives the threshold detaches into
 * a task row, the user gets a live card they can cancel, and the model still
 * receives the tool's real result once it settles — the task is a UX and
 * durability layer, not a change to what the model sees.
 *
 * The writer is attached late (once the UI stream opens), matching the
 * elicitation and subagent bridges: the bridge is built before the stream
 * exists so it can be threaded into the tool-execution context.
 */
export type ChatTaskBridge = {
  setWriter: (writer: ChatTaskWriter) => void;
  /**
   * Run a tool call, upgrading it to a task if it outlives the threshold.
   * Returns whatever the call itself returned, so callers stay unaware of
   * whether a task was involved.
   */
  runMaybeTask: <T>(params: {
    agentId: string;
    userId: string;
    toolCallId: string;
    toolName: string;
    abortSignal?: AbortSignal;
    execute: (signal: AbortSignal) => Promise<T>;
  }) => Promise<T>;
  /** Parts collected this turn, for splicing into the assistant message. */
  collected: () => ChatMessagePart[];
};

/** How often the chat turn re-reads a detached task's row while it runs. */
const TASK_POLL_INTERVAL_MS = 1_000;

export function chatTaskPrincipal(userId: string): string {
  return `user:${userId}`;
}

export function createChatTaskBridge(): ChatTaskBridge {
  let writer: ChatTaskWriter | null = null;
  const parts: ChatMessagePart[] = [];

  function emit(data: McpTaskPartData): void {
    // Replace rather than append: the card is one evolving thing, and the
    // chunk id lets the client reconcile updates and survive a stream resume.
    const existing = parts.findIndex(
      (part) => (part.data as McpTaskPartData)?.taskId === data.taskId,
    );
    if (existing >= 0) {
      parts[existing] = { type: MCP_TASK_PART_TYPE, data };
    } else {
      parts.push({ type: MCP_TASK_PART_TYPE, data });
    }
    writer?.write({
      type: MCP_TASK_PART_TYPE,
      id: data.taskId,
      data,
    } as UIMessageChunk);
  }

  return {
    setWriter(nextWriter) {
      writer = nextWriter;
    },

    async runMaybeTask({
      agentId,
      userId,
      toolCallId,
      toolName,
      abortSignal,
      execute,
    }) {
      const startedAt = Date.now();
      const principal = chatTaskPrincipal(userId);

      const outcome = await runToolCallMaybeTask({
        // A chat turn can always show a card, so every call is eligible; the
        // threshold decides whether one is actually minted.
        eligible: true,
        agentId,
        principal,
        toolName,
        // Merge here rather than at each call site: a detached call must answer
        // to both the chat run stopping and the task being cancelled, and a
        // caller that forgot one would silently lose that cancellation path.
        execute: ((taskSignal: AbortSignal) =>
          execute(
            abortSignal
              ? AbortSignal.any([abortSignal, taskSignal])
              : taskSignal,
          )) as (signal: AbortSignal) => Promise<Record<string, unknown>>,
      });

      const handle = readTaskHandle(outcome);
      if (!handle) {
        // Finished inside the threshold — an ordinary tool call, no card.
        return outcome as never;
      }

      emit({
        taskId: handle.taskId,
        toolCallId,
        toolName,
        status: "working",
        startedAt,
      });
      logger.info(
        { agentId, toolName, taskId: handle.taskId },
        "Chat tool call detached into a background task",
      );

      const settled = await pollUntilSettled({
        taskId: handle.taskId,
        agentId,
        principal,
        abortSignal,
      });

      emit({
        taskId: handle.taskId,
        toolCallId,
        toolName,
        status: settled.status,
        startedAt,
        ...(settled.errorText ? { errorText: settled.errorText } : {}),
      });

      if (settled.status === "completed" && settled.result) {
        return settled.result as never;
      }

      // Never throw: a throw inside a tool execute aborts the whole run and
      // paints a red "unexpected error" panel over an answer the model already
      // gave. Hand the outcome back as a tool result instead, the way
      // executeMcpTool surfaces an upstream tool error.
      //
      // A cancellation is deliberately NOT an error — the user asked for it,
      // so marking it one would style their own action as a failure. The model
      // still reads the text and can offer to retry. A genuine task failure
      // stays an error.
      const cancelled = settled.status === "cancelled";
      return {
        content: [
          {
            type: "text",
            text: cancelled
              ? "The user cancelled this call before it finished, so it produced no result."
              : (settled.errorText ??
                "The background task failed before it produced output."),
          },
        ],
        isError: !cancelled,
      } as never;
    },

    collected() {
      return parts;
    },
  };
}

/**
 * Append the turn's task parts to the assistant message holding the tool call
 * each one backs, so a reload still shows that the call ran as a task and how
 * it ended. Falls back to the last assistant message when the tool part cannot
 * be located (the model's call and the card are always in the same turn, but
 * normalization may already have moved things).
 *
 * Pure: returns the input unchanged when there is nothing to append.
 */
export function applyMcpTasksToMessages(
  messages: ChatMessage[],
  parts: ChatMessagePart[],
): ChatMessage[] {
  if (parts.length === 0) {
    return messages;
  }

  const assistantIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant") {
      assistantIdxs.push(i);
    }
  }
  if (assistantIdxs.length === 0) {
    return messages;
  }
  const lastIdx = assistantIdxs[assistantIdxs.length - 1];

  const idxByToolCallId = new Map<string, number>();
  for (const idx of assistantIdxs) {
    for (const part of messages[idx].parts ?? []) {
      if (
        typeof part.toolCallId === "string" &&
        typeof part.type === "string" &&
        (part.type.startsWith("tool-") || part.type === "dynamic-tool")
      ) {
        idxByToolCallId.set(part.toolCallId, idx);
      }
    }
  }

  const partsByIdx = new Map<number, ChatMessagePart[]>();
  for (const part of parts) {
    const toolCallId = (part.data as McpTaskPartData)?.toolCallId;
    const idx =
      (typeof toolCallId === "string"
        ? idxByToolCallId.get(toolCallId)
        : undefined) ?? lastIdx;
    const list = partsByIdx.get(idx);
    if (list) {
      list.push(part);
    } else {
      partsByIdx.set(idx, [part]);
    }
  }

  return messages.map((message, idx) => {
    const msgParts = partsByIdx.get(idx);
    if (!msgParts) {
      return message;
    }
    return {
      ...message,
      parts: [...(message.parts ?? []), ...msgParts],
    };
  });
}

// =============================================================================
// Internal helpers
// =============================================================================

type SettledTask = {
  status: Exclude<McpTaskStatus, "working">;
  result?: Record<string, unknown>;
  errorText?: string;
};

/**
 * Re-read the task row until it leaves `working`. Reading the row rather than
 * holding the in-process promise is deliberate: it is the same view any
 * replica has, so a cancel that lands on another pod ends this wait too.
 */
async function pollUntilSettled(params: {
  taskId: string;
  agentId: string;
  principal: string;
  abortSignal?: AbortSignal;
}): Promise<SettledTask> {
  const { taskId, agentId, principal, abortSignal } = params;
  const deadline = Date.now() + TASK_TTL_MS;

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) {
      return { status: "cancelled", errorText: "Chat run stopped" };
    }

    const task = await McpGatewayTaskModel.getForPrincipal({
      taskId,
      agentId,
      principal,
    });
    if (!task) {
      // The row expired, or was never visible to this principal. Either way
      // there is no outcome coming.
      return { status: "failed", errorText: "Task is no longer available" };
    }

    if (task.status !== "working") {
      const status = settledStatus(task.status);
      const error = isRecord(task.error) ? task.error : undefined;
      const errorText =
        (error ? describeTaskError(error) : undefined) ??
        (status === "cancelled" ? "Task cancelled" : undefined);
      return {
        status,
        ...(isRecord(task.result) ? { result: task.result } : {}),
        ...(errorText ? { errorText } : {}),
      };
    }

    await sleep(TASK_POLL_INTERVAL_MS, abortSignal);
  }

  return { status: "failed", errorText: "Task expired before it finished" };
}

function describeTaskError(error: Record<string, unknown>): string {
  const message = error.message;
  return typeof message === "string" && message.length > 0
    ? message
    : "Task failed";
}

/**
 * The row's status column is wider than the settled set at the type level, so
 * map it explicitly. Anything unrecognized is treated as a failure rather than
 * reported as success.
 */
function settledStatus(status: string): Exclude<McpTaskStatus, "working"> {
  return status === "completed" || status === "cancelled" ? status : "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `CreateTaskResult` shape `runToolCallMaybeTask` returns on detach. */
function readTaskHandle(value: unknown): { taskId: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.resultType !== "task") return null;
  const task = record.task;
  if (typeof task !== "object" || task === null) return null;
  const taskId = (task as Record<string, unknown>).taskId;
  return typeof taskId === "string" ? { taskId } : null;
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
