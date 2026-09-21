import { randomUUID } from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import {
  type ElicitResult,
  ElicitResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { UIMessageChunk } from "ai";
import { z } from "zod";
import { CacheKey, cacheManager } from "@/cache-manager";
import type { McpElicitationHandler } from "@/clients/mcp-elicitation";
import logger from "@/logging";
import { ApiError, UuidIdSchema } from "@/types";

const INITIAL_ELICITATION_POLL_INTERVAL_MS = 250;
// An answer posted to this process wakes its waiter immediately. This ceiling
// limits how long an answer on another replica waits in the shared cache.
const MAX_ELICITATION_POLL_INTERVAL_MS = 1_000;
// The pending marker outlives the wait so late-racing answers still find it.
const PENDING_ELICITATION_SLACK_MS = TimeInMs.Minute;
// Grace period after deadline for claimed answers to arrive.
const CLAIMED_ANSWER_GRACE_MS = 5_000;

/**
 * Timeout for human answer responses in Chat and over the MCP gateway.
 */
export const ELICITATION_ANSWER_TIMEOUT_MS = 10 * TimeInMs.Minute;

const ChatMcpElicitationContentValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

export const ChatMcpElicitationResponseSchema = z.object({
  conversationId: UuidIdSchema,
  action: ElicitResultSchema.shape.action,
  content: z
    .record(z.string(), ChatMcpElicitationContentValueSchema)
    .optional(),
});

type ChatMcpElicitationStreamData = {
  id: string;
  conversationId: string;
  toolName: string;
  message: string;
  mode: "form" | "url";
  requestedSchema?: unknown;
  elicitationId?: string;
  url?: string;
  /** The provider tool call that raised the question, when known. */
  toolCallId?: string;
  /** Short label for the question's tab (ask_user's `header`). */
  header?: string;
};

/** Why the backend stopped waiting for a question's answer. */
type ChatMcpElicitationResolvedStreamData = {
  id: string;
  conversationId: string;
  outcome: "answered" | "unanswered" | "cancelled";
};

export type ChatMcpElicitationWriter = {
  write: (chunk: UIMessageChunk) => void;
};

/**
 * Result of eliciting from a built-in Archestra tool: the user answered, the
 * question was shown but no answer came before the wait ran out, or there is
 * no one to ask through (headless execution, a client without forms). The
 * caller branches on `status` instead of catching a thrown error.
 */
export type ArchestraElicitationOutcome =
  | { status: "answered"; result: ElicitResult }
  | { status: "unanswered" }
  | { status: "no_viewer" };

export type ChatMcpElicitationBridge = {
  setWriter: (writer: ChatMcpElicitationWriter) => void;
  createHandler: (params: {
    toolName: string;
    toolCallId?: string;
  }) => McpElicitationHandler;
  /**
   * Elicit directly from a built-in Archestra tool (no external MCP server in
   * the loop). Returns a typed `no_viewer` outcome rather than throwing when no
   * chat stream writer is attached, so the tool can degrade gracefully instead
   * of surfacing a fatal chat error.
   */
  elicit: (params: {
    toolName: string;
    message: string;
    requestedSchema?: unknown;
    toolCallId?: string;
    header?: string;
  }) => Promise<ArchestraElicitationOutcome>;
};

type ChatMcpElicitationResponse = z.infer<
  typeof ChatMcpElicitationResponseSchema
>;

/**
 * Marks a question as waiting for an answer in one conversation, until
 * `expiresAt` (epoch ms), when the cache drops the marker.
 */
type PendingChatMcpElicitation = { conversationId: string; expiresAt: number };

export function createChatMcpElicitationBridge({
  conversationId,
  abortSignal,
}: {
  conversationId: string;
  abortSignal?: AbortSignal;
}): ChatMcpElicitationBridge {
  let writer: ChatMcpElicitationWriter | null = null;

  // Streams one elicitation request to the chat client and waits for the user's
  // response. Throws when no writer is attached — callers that must degrade
  // gracefully check `writer` first (see `elicit`). Each call waits under its
  // own id, so questions raised in parallel resolve independently. The wait
  // ends early when `signal` aborts: the chat run's signal, joined for an
  // upstream server's question by that request's own.
  async function sendElicitationRequest(req: {
    toolName: string;
    message: string;
    mode: "form" | "url";
    requestedSchema?: unknown;
    elicitationId?: string;
    url?: string;
    toolCallId?: string;
    header?: string;
    signal: AbortSignal | undefined;
  }): Promise<ElicitResult> {
    const streamWriter = writer;
    if (!streamWriter) {
      throw new Error("MCP elicitation requested before chat stream opened");
    }

    const id = randomUUID();
    // Marked before the question is shown, so the answer route (on any
    // replica) accepts an answer only while someone is waiting for it.
    const pendingTtlMs =
      ELICITATION_ANSWER_TIMEOUT_MS + PENDING_ELICITATION_SLACK_MS;
    await cacheManager.set(
      getPendingChatMcpElicitationKey(id),
      {
        conversationId,
        expiresAt: Date.now() + pendingTtlMs,
      } satisfies PendingChatMcpElicitation,
      pendingTtlMs,
    );
    answerSignals.open(id);

    let outcome: ChatMcpElicitationResolvedStreamData["outcome"] = "cancelled";
    try {
      streamWriter.write({
        type: "data-mcp-elicitation",
        data: {
          id,
          conversationId,
          toolName: req.toolName,
          message: req.message,
          mode: req.mode,
          requestedSchema: req.requestedSchema,
          elicitationId: req.elicitationId,
          url: req.url,
          toolCallId: req.toolCallId,
          header: req.header,
        } satisfies ChatMcpElicitationStreamData,
      });

      logger.info(
        {
          conversationId,
          toolName: req.toolName,
          toolCallId: req.toolCallId,
          mode: req.mode,
          elicitationId: req.elicitationId,
        },
        "Waiting for chat MCP elicitation response",
      );

      const result = await waitForChatMcpElicitationResponse({
        id,
        conversationId,
        abortSignal: req.signal,
      });
      outcome = "answered";
      return result;
    } catch (error) {
      if (error instanceof ElicitationAnswerTimeoutError) {
        outcome = "unanswered";
      }
      throw error;
    } finally {
      answerSignals.close(id);
      // Withdrawn before the client hears it resolved, so a late answer is
      // refused instead of stored for nobody.
      if (outcome !== "answered") {
        await cacheManager.delete(getPendingChatMcpElicitationKey(id), {
          throwOnError: true,
        });
      }
      streamWriter.write({
        type: "data-mcp-elicitation-resolved",
        data: {
          id,
          conversationId,
          outcome,
        } satisfies ChatMcpElicitationResolvedStreamData,
      });
    }
  }

  return {
    setWriter(nextWriter) {
      writer = nextWriter;
    },

    createHandler({ toolName, toolCallId }) {
      return async (request, extra) => {
        const params = request.params;
        // The upstream server can give up on its question first (its request
        // timeout, a cancellation, a closed transport); nobody is left to
        // read the answer then, so the question is withdrawn at once.
        const signals = [abortSignal, extra?.signal].filter(
          (signal): signal is AbortSignal => signal !== undefined,
        );
        return sendElicitationRequest({
          toolName,
          toolCallId,
          message: params.message,
          mode: params.mode ?? "form",
          requestedSchema:
            "requestedSchema" in params ? params.requestedSchema : undefined,
          elicitationId:
            "elicitationId" in params ? params.elicitationId : undefined,
          url: "url" in params ? params.url : undefined,
          signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
        });
      };
    },

    async elicit({ toolName, message, requestedSchema, toolCallId, header }) {
      if (!writer) {
        return { status: "no_viewer" };
      }
      try {
        const result = await sendElicitationRequest({
          toolName,
          message,
          mode: "form",
          requestedSchema,
          toolCallId,
          header,
          signal: abortSignal,
        });
        return { status: "answered", result };
      } catch (error) {
        if (error instanceof ElicitationAnswerTimeoutError) {
          return { status: "unanswered" };
        }
        throw error;
      }
    },
  };
}

/**
 * Hands the user's answer to the question waiting under `id`. Returns false,
 * storing nothing, when no question is waiting under that id in this
 * conversation: already answered, timed out, stopped, unknown, or asked in
 * another conversation.
 */
export async function resolveChatMcpElicitation({
  id,
  response,
}: {
  id: string;
  response: ChatMcpElicitationResponse;
}): Promise<boolean> {
  const pendingKey = getPendingChatMcpElicitationKey(id);
  const pending = await cacheManager.get<PendingChatMcpElicitation>(
    pendingKey,
    {
      throwOnError: true,
    },
  );
  if (pending?.conversationId !== response.conversationId) {
    return false;
  }
  // Consume-once: of two answers that both passed the check above, only the
  // one whose delete returns the marker is stored.
  const claimed = await cacheManager.getAndDelete<PendingChatMcpElicitation>(
    pendingKey,
    { throwOnError: true },
  );
  if (!claimed) {
    return false;
  }

  try {
    await cacheManager.set(
      getChatMcpElicitationResponseKey(id),
      response,
      ELICITATION_ANSWER_TIMEOUT_MS,
    );
  } catch (error) {
    // The answer never landed: hand the question back, so a retry can still
    // answer it instead of finding it claimed by an answer nobody stored.
    await restorePendingChatMcpElicitation({ key: pendingKey, claimed });
    throw error;
  }
  answerSignals.notify(id);
  return true;
}

async function waitForChatMcpElicitationResponse({
  id,
  conversationId,
  abortSignal,
}: {
  id: string;
  conversationId: string;
  abortSignal?: AbortSignal;
}): Promise<ElicitResult> {
  const answer = await pollForChatMcpElicitationResponse({
    id,
    conversationId,
    deadline: Date.now() + ELICITATION_ANSWER_TIMEOUT_MS,
    abortSignal,
  });
  if (answer) {
    return answer;
  }

  // Out of time: withdraw the question. A marker already gone means the answer
  // route claimed it just before the deadline, so its answer is on the way.
  const stillPending = await cacheManager.getAndDelete(
    getPendingChatMcpElicitationKey(id),
    { throwOnError: true },
  );
  if (!stillPending) {
    const lateAnswer = await pollForChatMcpElicitationResponse({
      id,
      conversationId,
      deadline: Date.now() + CLAIMED_ANSWER_GRACE_MS,
      abortSignal,
    });
    if (lateAnswer) {
      return lateAnswer;
    }
  }

  throw new ElicitationAnswerTimeoutError();
}

async function pollForChatMcpElicitationResponse({
  id,
  conversationId,
  deadline,
  abortSignal,
}: {
  id: string;
  conversationId: string;
  deadline: number;
  abortSignal?: AbortSignal;
}): Promise<ElicitResult | null> {
  const key = getChatMcpElicitationResponseKey(id);
  let pollIntervalMs = INITIAL_ELICITATION_POLL_INTERVAL_MS;

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) {
      throw createElicitationCancelledError();
    }

    const response =
      await cacheManager.getAndDelete<ChatMcpElicitationResponse>(key, {
        throwOnError: true,
      });
    if (response) {
      if (response.conversationId !== conversationId) {
        throw new ApiError(403, "MCP elicitation response does not match chat");
      }

      return {
        action: response.action,
        ...(response.action === "accept"
          ? { content: response.content ?? {} }
          : {}),
      };
    }

    await answerSignals.sleep({
      id,
      ms: Math.min(pollIntervalMs, deadline - Date.now()),
      abortSignal,
    });
    pollIntervalMs = Math.min(
      pollIntervalMs * 2,
      MAX_ELICITATION_POLL_INTERVAL_MS,
    );
  }

  return null;
}

/**
 * Wakes waiting questions immediately when their answer is stored in-process.
 * Answers posted to another replica arrive via shared-cache polling.
 * Entries live only for the duration of the wait.
 */
class ElicitationAnswerSignals {
  private readonly waiters = new Map<
    string,
    { notified: boolean; wake?: () => void }
  >();

  open(id: string): void {
    this.waiters.set(id, { notified: false });
  }

  close(id: string): void {
    this.waiters.delete(id);
  }

  notify(id: string): void {
    const waiter = this.waiters.get(id);
    if (!waiter) {
      return;
    }
    waiter.notified = true;
    waiter.wake?.();
  }

  /**
   * Sleeps for `ms`, or less once `notify(id)` fires — including a notify that
   * landed while the waiter was reading the cache between two sleeps.
   */
  sleep({
    id,
    ms,
    abortSignal,
  }: {
    id: string;
    ms: number;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    const waiter = this.waiters.get(id);
    return new Promise((resolve, reject) => {
      if (abortSignal?.aborted) {
        reject(createElicitationCancelledError());
        return;
      }
      if (waiter?.notified) {
        waiter.notified = false;
        resolve();
        return;
      }

      const settle = () => {
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", onAbort);
        if (waiter) {
          waiter.notified = false;
          waiter.wake = undefined;
        }
      };
      const onAbort = () => {
        settle();
        reject(createElicitationCancelledError());
      };
      const timer = setTimeout(() => {
        settle();
        resolve();
      }, ms);
      if (waiter) {
        waiter.wake = () => {
          settle();
          resolve();
        };
      }
      abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

const answerSignals = new ElicitationAnswerSignals();

class ElicitationAnswerTimeoutError extends Error {
  constructor() {
    super("MCP elicitation response timed out");
  }
}

async function restorePendingChatMcpElicitation({
  key,
  claimed,
}: {
  key: ReturnType<typeof getPendingChatMcpElicitationKey>;
  claimed: PendingChatMcpElicitation;
}): Promise<void> {
  const remainingMs = claimed.expiresAt - Date.now();
  // Past its deadline, or a marker written before markers carried one.
  if (!(remainingMs > 0)) {
    return;
  }
  try {
    await cacheManager.set(key, claimed, remainingMs);
  } catch {
    try {
      await cacheManager.set(key, claimed, remainingMs);
    } catch (retryError) {
      logger.warn(
        { error: retryError, key },
        "Could not hand a chat MCP elicitation back after its answer failed to store",
      );
    }
  }
}

function getChatMcpElicitationResponseKey(id: string) {
  return `${CacheKey.ChatMcpElicitation}-${id}` as const;
}

function getPendingChatMcpElicitationKey(id: string) {
  return `${CacheKey.ChatMcpElicitationPending}-${id}` as const;
}

function createElicitationCancelledError() {
  return new Error("MCP elicitation cancelled because chat stream stopped");
}
