import {
  ChatErrorCode,
  ChatErrorMessages,
  type ChatErrorResponse,
  isChatErrorResponse,
  RetryableErrorCodes,
} from "@shared";

/**
 * Parse the error message to extract a ChatErrorResponse if possible
 */
export function parseErrorResponse(error: Error): ChatErrorResponse | null {
  try {
    const parsed = JSON.parse(error.message);
    if (isChatErrorResponse(parsed)) {
      return parsed;
    }
  } catch {
    // Not JSON or not a ChatErrorResponse
  }
  return null;
}

/**
 * Known client-side error patterns mapped to ChatErrorCode.
 * These errors never reach the backend (network failures, aborts, etc.).
 */
const CLIENT_ERROR_PATTERNS: Array<{
  test: (msg: string) => boolean;
  code: ChatErrorCode;
}> = [
  {
    test: (msg) =>
      msg === "Failed to fetch" ||
      msg.includes("NetworkError") ||
      msg.includes("network"),
    code: ChatErrorCode.NetworkError,
  },
  {
    test: (msg) =>
      msg.includes("AbortError") || msg === "The operation was aborted.",
    code: ChatErrorCode.Unknown,
  },
];

/**
 * Map unstructured errors to a ChatErrorResponse so they display with the
 * same styled error card. Recognizes known client-side patterns (network errors,
 * aborts) and falls back to a generic error for anything else.
 */
export function mapClientError(error: Error): ChatErrorResponse {
  const msg = error.message;

  for (const pattern of CLIENT_ERROR_PATTERNS) {
    if (pattern.test(msg)) {
      return {
        code: pattern.code,
        message: ChatErrorMessages[pattern.code],
        isRetryable: RetryableErrorCodes.has(pattern.code),
      };
    }
  }

  // Try to extract message from backend's { error: { message } } format
  let displayMessage = msg;
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error?.message) {
      displayMessage = parsed.error.message;
    }
  } catch {
    // Not JSON, use as-is
  }

  return {
    code: ChatErrorCode.Unknown,
    message: displayMessage || ChatErrorMessages[ChatErrorCode.Unknown],
    isRetryable: RetryableErrorCodes.has(ChatErrorCode.Unknown),
  };
}
