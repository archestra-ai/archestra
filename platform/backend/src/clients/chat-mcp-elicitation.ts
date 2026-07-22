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
const MAX_ELICITATION_POLL_INTERVAL_MS = 5_000;

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
};

export type ChatMcpElicitationWriter = {
  write: (chunk: UIMessageChunk) => void;
};

/**
 * Result of eliciting from a built-in Archestra tool: either the user answered,
 * or there is no chat stream writer to ask through (headless execution). The
 * caller branches on `status` instead of catching a thrown error.
 */
export type ArchestraElicitationOutcome =
  | { status: "answered"; result: ElicitResult }
  | { status: "no_viewer" };

export type ChatMcpElicitationBridge = {
  setWriter: (writer: ChatMcpElicitationWriter) => void;
  createHandler: (params: { toolName: string }) => McpElicitationHandler;
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
  }) => Promise<ArchestraElicitationOutcome>;
};

type ChatMcpElicitationResponse = z.infer<
  typeof ChatMcpElicitationResponseSchema
>;

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
  // gracefully check `writer` first (see `elicit`).
  function sendElicitationRequest(req: {
    toolName: string;
    message: string;
    mode: "form" | "url";
    requestedSchema?: unknown;
    elicitationId?: string;
    url?: string;
  }): Promise<ElicitResult> {
    if (!writer) {
      throw new Error("MCP elicitation requested before chat stream opened");
    }

    const id = randomUUID();
    writer.write({
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
      } satisfies ChatMcpElicitationStreamData,
    });

    logger.info(
      {
        conversationId,
        toolName: req.toolName,
        mode: req.mode,
        elicitationId: req.elicitationId,
      },
      "Waiting for chat MCP elicitation response",
    );

    return waitForChatMcpElicitationResponse({
      id,
      conversationId,
      abortSignal,
    });
  }

  return {
    setWriter(nextWriter) {
      writer = nextWriter;
    },

    createHandler({ toolName }) {
      return async (request) => {
        const params = request.params;
        return sendElicitationRequest({
          toolName,
          message: params.message,
          mode: params.mode ?? "form",
          requestedSchema:
            "requestedSchema" in params ? params.requestedSchema : undefined,
          elicitationId:
            "elicitationId" in params ? params.elicitationId : undefined,
          url: "url" in params ? params.url : undefined,
        });
      };
    },

    async elicit({ toolName, message, requestedSchema }) {
      if (!writer) {
        return { status: "no_viewer" };
      }
      const result = await sendElicitationRequest({
        toolName,
        message,
        mode: "form",
        requestedSchema,
      });
      return { status: "answered", result };
    },
  };
}

export async function resolveChatMcpElicitation({
  id,
  response,
}: {
  id: string;
  response: ChatMcpElicitationResponse;
}): Promise<void> {
  await cacheManager.set(
    getChatMcpElicitationResponseKey(id),
    response,
    10 * TimeInMs.Minute,
  );
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
  const key = getChatMcpElicitationResponseKey(id);
  const timeoutAt = Date.now() + 10 * TimeInMs.Minute;
  let pollIntervalMs = INITIAL_ELICITATION_POLL_INTERVAL_MS;

  while (Date.now() < timeoutAt) {
    if (abortSignal?.aborted) {
      throw createElicitationCancelledError();
    }

    const response =
      await cacheManager.getAndDelete<ChatMcpElicitationResponse>(key);
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

    await sleep(pollIntervalMs, abortSignal);
    pollIntervalMs = Math.min(
      pollIntervalMs * 2,
      MAX_ELICITATION_POLL_INTERVAL_MS,
    );
  }

  throw new Error("MCP elicitation response timed out");
}

function getChatMcpElicitationResponseKey(id: string) {
  return `${CacheKey.ChatMcpElicitation}-${id}` as const;
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(createElicitationCancelledError());
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(createElicitationCancelledError());
    };
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createElicitationCancelledError() {
  return new Error("MCP elicitation cancelled because chat stream stopped");
}
