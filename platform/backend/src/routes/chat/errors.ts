import {
  ChatErrorCode,
  ChatErrorMessages,
  type ChatErrorResponse,
  RetryableErrorCodes,
  type SupportedProvider,
} from "@shared";
import { APICallError } from "ai";
import logger from "@/logging";

/**
 * Safely stringify an object, handling circular references.
 * Returns a plain object that can be safely JSON.stringify'd later.
 */
function safeSerialize(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // For primitive types, return as-is
  if (typeof obj !== "object") {
    return obj;
  }

  // Try to create a safe copy by stringifying with a circular reference handler
  try {
    const seen = new WeakSet();
    const safeStringified = JSON.stringify(obj, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }
      // Convert Error objects to plain objects
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }
      return value;
    });
    return JSON.parse(safeStringified);
  } catch {
    // If even safe stringify fails, return a string representation
    if (obj instanceof Error) {
      return {
        name: obj.name,
        message: obj.message,
        stack: obj.stack,
      };
    }
    return String(obj);
  }
}

/**
 * Patterns to detect context length exceeded errors from provider messages
 */
const CONTEXT_LENGTH_PATTERNS = [
  /context.*(length|window|limit)/i,
  /maximum.*token/i,
  /too many tokens/i,
  /exceeds.*limit/i,
  /input.*too.*long/i,
  /max_tokens/i,
];

/**
 * Patterns to detect content filtering errors
 */
const CONTENT_FILTER_PATTERNS = [
  /content.*filter/i,
  /safety.*violation/i,
  /blocked.*safety/i,
  /harmful.*content/i,
  /policy.*violation/i,
  /moderation/i,
];

/**
 * Patterns to detect authentication/API key errors
 */
const AUTH_PATTERNS = [
  /api.?key.*not.*valid/i,
  /invalid.*api.?key/i,
  /api.?key.*invalid/i,
  /authentication.*failed/i,
  /unauthorized/i,
  /invalid.*credentials/i,
  /API_KEY_INVALID/i,
];

/**
 * Recursively extract the deepest meaningful error message from nested JSON
 * Provider errors often come with multiple layers of JSON encoding
 */
function extractDeepErrorMessage(obj: unknown, depth = 0): string | null {
  // Prevent infinite recursion
  if (depth > 10) return null;

  if (typeof obj === "string") {
    // Try to parse as JSON and recurse
    try {
      const parsed = JSON.parse(obj);
      const deeperMessage = extractDeepErrorMessage(parsed, depth + 1);
      if (deeperMessage) return deeperMessage;
    } catch {
      // Not JSON, return as-is if it looks like a meaningful message
      // (not just escaped JSON noise)
      if (obj.length > 0 && !obj.startsWith("{") && !obj.startsWith("[")) {
        return obj;
      }
    }
    return null;
  }

  if (typeof obj !== "object" || obj === null) {
    return null;
  }

  const record = obj as Record<string, unknown>;

  // Check for message field first
  if (typeof record.message === "string") {
    // Try to extract deeper message from this string
    const deeperMessage = extractDeepErrorMessage(record.message, depth + 1);
    if (deeperMessage) return deeperMessage;
    // If the message itself isn't nested JSON, use it
    if (
      !record.message.startsWith("{") &&
      !record.message.startsWith("[") &&
      record.message.length > 0
    ) {
      return record.message;
    }
  }

  // Check for error.message pattern
  if (typeof record.error === "object" && record.error !== null) {
    const innerError = record.error as Record<string, unknown>;
    const innerMessage = extractDeepErrorMessage(innerError, depth + 1);
    if (innerMessage) return innerMessage;
  }

  return null;
}

/**
 * Extract error message from various error formats
 */
function extractErrorMessage(error: unknown): string {
  // Handle objects first to check for responseBody (AI SDK errors)
  // This needs to come BEFORE the Error instanceof check because APICallError
  // is an Error but has responseBody with the actual provider error
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;

    // For AI SDK errors, try to extract from responseBody first (contains actual provider error)
    if (typeof obj.responseBody === "string") {
      const deepMessage = extractDeepErrorMessage(obj.responseBody, 0);
      if (deepMessage) return deepMessage;
    }

    // Try common error message paths with deep extraction
    if (typeof obj.message === "string") {
      const deepMessage = extractDeepErrorMessage(obj.message, 0);
      if (deepMessage) return deepMessage;
      return obj.message;
    }

    if (typeof obj.error === "object" && obj.error !== null) {
      const innerError = obj.error as Record<string, unknown>;
      if (typeof innerError.message === "string") {
        const deepMessage = extractDeepErrorMessage(innerError.message, 0);
        if (deepMessage) return deepMessage;
        return innerError.message;
      }
    }
  }

  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

/**
 * Extract HTTP status code from various error formats
 */
function extractStatusCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj.status === "number") return obj.status;
    if (typeof obj.statusCode === "number") return obj.statusCode;
    if (typeof obj.code === "number") return obj.code;

    // Handle AI_RetryError which wraps the actual error in lastError
    if (typeof obj.lastError === "object" && obj.lastError !== null) {
      const lastError = obj.lastError as Record<string, unknown>;
      if (typeof lastError.statusCode === "number") return lastError.statusCode;
    }

    // Also check first error in errors array (AI_RetryError structure)
    if (Array.isArray(obj.errors) && obj.errors.length > 0) {
      const firstError = obj.errors[0] as Record<string, unknown>;
      if (typeof firstError?.statusCode === "number")
        return firstError.statusCode;
    }
  }
  return undefined;
}

/**
 * Extract error type from various error formats
 */
function extractErrorType(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj.type === "string") return obj.type;
    if (typeof obj.name === "string") return obj.name;
    if (typeof obj.error === "object" && obj.error !== null) {
      const innerError = obj.error as Record<string, unknown>;
      if (typeof innerError.type === "string") return innerError.type;
    }
  }
  return undefined;
}

/**
 * Check if error message matches any patterns in the list
 */
function matchesPatterns(message: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

/**
 * Map HTTP status code to ChatErrorCode
 */
function mapStatusCodeToErrorCode(
  status: number,
  errorMessage: string,
): ChatErrorCode {
  // Check for specific error types in message first (more precise than status code)
  if (matchesPatterns(errorMessage, AUTH_PATTERNS)) {
    return ChatErrorCode.Authentication;
  }
  if (matchesPatterns(errorMessage, CONTEXT_LENGTH_PATTERNS)) {
    return ChatErrorCode.ContextTooLong;
  }
  if (matchesPatterns(errorMessage, CONTENT_FILTER_PATTERNS)) {
    return ChatErrorCode.ContentFiltered;
  }

  // Map by status code
  switch (status) {
    case 400:
      return ChatErrorCode.InvalidRequest;
    case 401:
      return ChatErrorCode.Authentication;
    case 403:
      return ChatErrorCode.PermissionDenied;
    case 404:
      return ChatErrorCode.NotFound;
    case 422:
      // Unprocessable entity - often validation errors
      return ChatErrorCode.InvalidRequest;
    case 429:
      return ChatErrorCode.RateLimit;
    default:
      if (status >= 500) {
        return ChatErrorCode.ServerError;
      }
      return ChatErrorCode.Unknown;
  }
}

/**
 * Map error type string to ChatErrorCode
 */
function mapErrorTypeToErrorCode(
  errorType: string,
  errorMessage: string,
): ChatErrorCode {
  const type = errorType.toLowerCase();

  // Check message patterns first (more precise than type)
  if (matchesPatterns(errorMessage, AUTH_PATTERNS)) {
    return ChatErrorCode.Authentication;
  }
  if (matchesPatterns(errorMessage, CONTEXT_LENGTH_PATTERNS)) {
    return ChatErrorCode.ContextTooLong;
  }
  if (matchesPatterns(errorMessage, CONTENT_FILTER_PATTERNS)) {
    return ChatErrorCode.ContentFiltered;
  }

  // Map by error type
  if (type.includes("rate") || type.includes("quota")) {
    return ChatErrorCode.RateLimit;
  }
  if (type.includes("auth") || type.includes("invalid_api_key")) {
    return ChatErrorCode.Authentication;
  }
  if (type.includes("permission") || type.includes("forbidden")) {
    return ChatErrorCode.PermissionDenied;
  }
  if (type.includes("not_found")) {
    return ChatErrorCode.NotFound;
  }
  if (
    type.includes("invalid") ||
    type.includes("bad_request") ||
    type.includes("validation")
  ) {
    return ChatErrorCode.InvalidRequest;
  }
  if (type.includes("server") || type.includes("internal")) {
    return ChatErrorCode.ServerError;
  }
  if (type.includes("connection") || type.includes("network")) {
    return ChatErrorCode.NetworkError;
  }

  return ChatErrorCode.Unknown;
}

/**
 * Create a ChatErrorResponse from the determined error code.
 * The rawError is safely serialized to handle circular references.
 */
function createErrorResponse(
  code: ChatErrorCode,
  provider?: SupportedProvider,
  status?: number,
  originalMessage?: string,
  errorType?: string,
  rawError?: unknown,
): ChatErrorResponse {
  return {
    code,
    message: ChatErrorMessages[code],
    isRetryable: RetryableErrorCodes.has(code),
    originalError: {
      provider,
      status,
      message: originalMessage,
      type: errorType,
      raw: safeSerialize(rawError),
    },
  };
}

/**
 * Map a provider error to a normalized ChatErrorResponse.
 * Handles errors from Vercel AI SDK (APICallError) as well as raw provider errors.
 *
 * @param error - The error to map
 * @param provider - The provider that generated the error
 * @returns A normalized ChatErrorResponse with user-friendly message and technical details
 */
export function mapProviderError(
  error: unknown,
  provider: SupportedProvider,
): ChatErrorResponse {
  logger.debug({ error, provider }, "[ChatErrorMapper] Mapping provider error");

  // Handle Vercel AI SDK APICallError
  if (APICallError.isInstance(error)) {
    const apiError = error as InstanceType<typeof APICallError>;
    const errorMessage = extractErrorMessage(apiError);

    // APICallError has statusCode and isRetryable properties
    const statusCode = apiError.statusCode;
    let errorCode: ChatErrorCode;

    if (statusCode) {
      errorCode = mapStatusCodeToErrorCode(statusCode, errorMessage);
    } else if (apiError.isRetryable) {
      // Network errors are typically retryable without status codes
      errorCode = ChatErrorCode.NetworkError;
    } else {
      errorCode = ChatErrorCode.Unknown;
    }

    logger.info(
      {
        originalError: errorMessage,
        statusCode,
        mappedCode: errorCode,
        provider,
      },
      "[ChatErrorMapper] Mapped APICallError",
    );

    return createErrorResponse(
      errorCode,
      provider,
      statusCode,
      errorMessage,
      apiError.name,
      {
        url: apiError.url,
        statusCode: apiError.statusCode,
        responseBody: apiError.responseBody,
        isRetryable: apiError.isRetryable,
      },
    );
  }

  // Handle generic errors
  const errorMessage = extractErrorMessage(error);
  const statusCode = extractStatusCode(error);
  const errorType = extractErrorType(error);

  let errorCode: ChatErrorCode;

  // Try to determine error code from available information
  if (statusCode) {
    errorCode = mapStatusCodeToErrorCode(statusCode, errorMessage);
  } else if (errorType) {
    errorCode = mapErrorTypeToErrorCode(errorType, errorMessage);
  } else if (matchesPatterns(errorMessage, AUTH_PATTERNS)) {
    errorCode = ChatErrorCode.Authentication;
  } else if (matchesPatterns(errorMessage, CONTEXT_LENGTH_PATTERNS)) {
    errorCode = ChatErrorCode.ContextTooLong;
  } else if (matchesPatterns(errorMessage, CONTENT_FILTER_PATTERNS)) {
    errorCode = ChatErrorCode.ContentFiltered;
  } else if (
    errorMessage.toLowerCase().includes("network") ||
    errorMessage.toLowerCase().includes("econnrefused") ||
    errorMessage.toLowerCase().includes("timeout")
  ) {
    errorCode = ChatErrorCode.NetworkError;
  } else {
    errorCode = ChatErrorCode.Unknown;
  }

  logger.info(
    {
      originalError: errorMessage,
      statusCode,
      errorType,
      mappedCode: errorCode,
      provider,
    },
    "[ChatErrorMapper] Mapped generic error",
  );

  return createErrorResponse(
    errorCode,
    provider,
    statusCode,
    errorMessage,
    errorType,
    error,
  );
}
