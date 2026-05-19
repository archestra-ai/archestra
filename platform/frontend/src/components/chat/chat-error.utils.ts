import {
  ChatErrorCode,
  ChatErrorMessages,
  type ChatErrorResponse,
  isChatErrorResponse,
  RetryableErrorCodes,
} from "@shared";

/**
 * AI SDK internal error type names that aren't useful to show users
 */
export const AI_SDK_INTERNAL_TYPES = [
  "AI_APICallError",
  "AI_RetryError",
  "APICallError",
  "RetryError",
];

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
 * Recursively parse nested JSON strings to produce a clean object
 */
export function deepParseJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return deepParseJson(parsed);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    return value.map(deepParseJson);
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = deepParseJson(val);
    }
    return result;
  }
  return value;
}

/**
 * Format the original error details for display
 */
export function formatOriginalError(
  originalError: ChatErrorResponse["originalError"],
): string {
  if (!originalError) return "No additional details available";

  const parts: string[] = [];

  if (originalError.provider) {
    parts.push(`Provider: ${originalError.provider}`);
  }
  if (originalError.status) {
    parts.push(`Status: ${originalError.status}`);
  }
  // Skip AI SDK internal type names - not useful for users
  if (
    originalError.type &&
    !AI_SDK_INTERNAL_TYPES.includes(originalError.type)
  ) {
    parts.push(`Type: ${originalError.type}`);
  }
  if (originalError.message) {
    parts.push(`Message: ${originalError.message}`);
  }
  if (originalError.raw) {
    try {
      // Deep parse the raw error to unwrap nested JSON strings
      const parsed = deepParseJson(originalError.raw);
      parts.push(`\nRaw Error:\n${JSON.stringify(parsed, null, 2)}`);
    } catch {
      parts.push(`\nRaw Error: [Unable to stringify]`);
    }
  }

  return parts.join("\n") || "No additional details available";
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
 * Map backend ApiError `type` values to normalized ChatErrorCodes so the inline
 * error card shows the right badge (code, retryable) regardless of which API
 * route bounced the request. The backend message is shown verbatim — it's
 * already user-friendly (e.g. "Request body too large: 65 MB (limit 50 MB)").
 */
const BACKEND_ERROR_TYPE_TO_CODE: Record<string, ChatErrorCode> = {
  api_payload_too_large_error: ChatErrorCode.InvalidRequest,
  api_validation_error: ChatErrorCode.InvalidRequest,
  api_authentication_error: ChatErrorCode.Authentication,
  api_authorization_error: ChatErrorCode.PermissionDenied,
  api_not_found_error: ChatErrorCode.NotFound,
  api_internal_server_error: ChatErrorCode.ServerError,
};

/**
 * Map unstructured errors to a ChatErrorResponse so they display with the
 * same styled error card. Recognizes known client-side patterns (network errors,
 * aborts), known backend error envelopes, and falls back to a generic error.
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

  // Try to extract message + type from backend's { error: { message, type } } format
  let displayMessage = msg;
  let backendType: string | undefined;
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error?.message) {
      displayMessage = parsed.error.message;
    }
    if (typeof parsed?.error?.type === "string") {
      backendType = parsed.error.type;
    }
  } catch {
    // Not JSON, use as-is
  }

  const mappedCode = backendType
    ? BACKEND_ERROR_TYPE_TO_CODE[backendType]
    : undefined;
  const code = mappedCode ?? ChatErrorCode.Unknown;
  return {
    code,
    message: displayMessage || ChatErrorMessages[code],
    isRetryable: RetryableErrorCodes.has(code),
  };
}
