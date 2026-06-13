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

export type ChatMcpElicitationBridge = {
  setWriter: (writer: ChatMcpElicitationWriter) => void;
  createHandler: (params: { toolName: string }) => McpElicitationHandler;
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

  return {
    setWriter(nextWriter) {
      writer = nextWriter;
    },

    createHandler({ toolName }) {
      return async (request) => {
        if (!writer) {
          throw new Error(
            "MCP elicitation requested before chat stream opened",
          );
        }

        const id = randomUUID();
        const params = request.params;
        const mode = params.mode ?? "form";

        writer.write({
          type: "data-mcp-elicitation",
          data: {
            id,
            conversationId,
            toolName,
            message: params.message,
            mode,
            requestedSchema:
              "requestedSchema" in params ? params.requestedSchema : undefined,
            elicitationId:
              "elicitationId" in params ? params.elicitationId : undefined,
            url: "url" in params ? params.url : undefined,
          } satisfies ChatMcpElicitationStreamData,
        });

        logger.info(
          {
            conversationId,
            toolName,
            mode,
            elicitationId:
              "elicitationId" in params ? params.elicitationId : undefined,
          },
          "Waiting for chat MCP elicitation response",
        );

        return waitForChatMcpElicitationResponse({
          id,
          conversationId,
          abortSignal,
        });
      };
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
