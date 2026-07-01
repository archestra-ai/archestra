import {
  ChatErrorCode,
  type ChatErrorResponse,
  isChatErrorResponse,
} from "@archestra/shared";

/** Network-level errors that never reach the backend (no structured payload). */
const RETRYABLE_CLIENT_ERRORS = [
  "Failed to fetch",
  "NetworkError",
  "No output generated",
  "network",
];

/** Parse a chat error's message into a structured backend error, if it is one. */
export function parseStructuredChatError(
  message: string,
): ChatErrorResponse | null {
  try {
    const parsed: unknown = JSON.parse(message);
    return isChatErrorResponse(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Whether the client may silently auto-retry this streaming error. */
export function isRetryableError(error: Error): boolean {
  const msg = error.message;
  // Structured backend chat errors already reached the server. Most should render
  // once — auto-retrying duplicates the LLM request and changes trace IDs. The one
  // exception is a dropped connection (network_error): the stream died, so a retry
  // is a fresh attempt (a still-live run instead yields a 409 and reattaches), and
  // it mirrors how the unstructured client network failures below already retry.
  const structured = parseStructuredChatError(msg);
  if (structured) {
    return (
      structured.code === ChatErrorCode.NetworkError && structured.isRetryable
    );
  }

  return RETRYABLE_CLIENT_ERRORS.some((p) => msg.includes(p));
}
