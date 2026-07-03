import { ApiError } from "@archestra/shared";
import { createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import type { FastifyReply } from "fastify";
import logger from "@/logging";
import { activeChatRunService } from "@/services/active-chat-run";

/**
 * Send a UI-message stream as the chat response while draining a copy into the
 * active-run event log. The response body's CLOSE (not its bytes — they stream
 * through unchanged) is held until the active-run row is marked terminal.
 * Without this, a client that fires its next message the instant this response
 * ends races the async drain and 409s against a row still flagged running.
 */
export async function sendGatedUiMessageStreamResponse(params: {
  reply: FastifyReply;
  stream: ReadableStream<UIMessageChunk>;
  runId: string;
  conversationId: string;
  abortController: AbortController;
  getTerminalStatus: () => Promise<{
    status: "completed" | "failed" | "cancelled";
    error?: string | null;
  }>;
}): Promise<FastifyReply> {
  const { reply, runId, conversationId, abortController, getTerminalStatus } =
    params;

  const [responseStream, persistenceStream] = params.stream.tee();
  const { terminalReady } = activeChatRunService.drainStreamToEvents({
    runId,
    conversationId,
    stream: persistenceStream,
    abortController,
    getTerminalStatus,
  });

  const response = createUIMessageStreamResponse({
    headers: {
      // Prevent compression middleware from buffering the stream
      // See: https://ai-sdk.dev/docs/troubleshooting/streaming-not-working-when-proxied
      "Content-Encoding": "none",
    },
    stream: responseStream,
  });

  // Log response headers for debugging
  logger.info(
    {
      conversationId,
      headers: Object.fromEntries(response.headers.entries()),
      hasBody: !!response.body,
    },
    "Streaming chat response",
  );

  // Copy headers from Response to Fastify reply
  for (const [key, value] of response.headers.entries()) {
    reply.header(key, value);
  }

  if (!response.body) {
    throw new ApiError(400, "No response body");
  }
  const gatedBody = (response.body as ReadableStream<Uint8Array>).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async flush() {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            terminalReady,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, TERMINAL_CLOSE_GATE_TIMEOUT_MS);
            }),
          ]);
        } finally {
          if (timer) {
            clearTimeout(timer);
          }
        }
      },
    }),
  );
  // biome-ignore lint/suspicious/noExplicitAny: Fastify reply.send accepts ReadableStream but TypeScript requires explicit cast
  return reply.send(gatedBody as any);
}

// Upper bound on how long the response body's close waits for the active-run row
// to be marked terminal. Terminalization is normally tens of milliseconds; this
// cap keeps a wedged DB or notifier after stream-end from hanging the client EOF
// indefinitely. Past it we release EOF and fall back to the pre-existing 409
// window (which the stale reaper still cleans up).
const TERMINAL_CLOSE_GATE_TIMEOUT_MS = 10_000;
