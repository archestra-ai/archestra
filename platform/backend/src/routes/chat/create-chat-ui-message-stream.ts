import { createUIMessageStream, type UIMessage } from "ai";

export function createChatUiMessageStream(params: {
  /** Existing chat history from the client. Passed through so AI SDK can reuse message IDs. */
  originalMessages: UIMessage[];
  /** Stream-level error handler for merged UI message streams. */
  onError: (error: unknown) => string;
  /** Chat execution body that writes and merges streamed UI message parts. */
  execute: Parameters<typeof createUIMessageStream>[0]["execute"];
}) {
  const { originalMessages, onError, execute } = params;

  return createUIMessageStream({
    originalMessages,
    onError,
    execute,
  });
}
