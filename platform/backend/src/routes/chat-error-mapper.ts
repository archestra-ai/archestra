import {
  ChatErrorCode,
  ChatErrorMessages,
  type ChatErrorResponse,
  RetryableErrorCodes,
} from "@shared";
import { APICallError } from "ai";
import logger from "@/logging";

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
 * Extract error message from various error formats
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    // Try common error message paths
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "object" && obj.error !== null) {
      const innerError = obj.error as Record<string, unknown>;
      if (typeof innerError.message === "string") return innerError.message;
    }
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
 * Detect provider from error structure
 */
function detectProvider(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) {
    const errorStr = JSON.stringify(error).toLowerCase();

    // Check for provider-specific patterns
    if (
      errorStr.includes("anthropic") ||
      errorStr.includes("claude") ||
      errorStr.includes("x-api-key")
    ) {
      return "anthropic";
    }
    if (
      errorStr.includes("openai") ||
      errorStr.includes("gpt-") ||
      errorStr.includes("chatgpt")
    ) {
      return "openai";
    }
    if (
      errorStr.includes("google") ||
      errorStr.includes("gemini") ||
      errorStr.includes("generativelanguage")
    ) {
      return "gemini";
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
  // Check for specific error types in message first (more precise)
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

  // Check message patterns first
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
 * Create a ChatErrorResponse from the determined error code
 */
function createErrorResponse(
  code: ChatErrorCode,
  provider?: string,
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
      raw: rawError,
    },
  };
}

/**
 * Map a provider error to a normalized ChatErrorResponse.
 * Handles errors from Vercel AI SDK (APICallError) as well as raw provider errors.
 *
 * @param error - The error to map
 * @returns A normalized ChatErrorResponse with user-friendly message and technical details
 */
export function mapProviderError(error: unknown): ChatErrorResponse {
  logger.debug({ error }, "[ChatErrorMapper] Mapping provider error");

  // Handle Vercel AI SDK APICallError
  if (APICallError.isInstance(error)) {
    const apiError = error as InstanceType<typeof APICallError>;
    const errorMessage = extractErrorMessage(apiError);
    const provider = detectProvider(apiError);

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
  const provider = detectProvider(error);

  let errorCode: ChatErrorCode;

  // Try to determine error code from available information
  if (statusCode) {
    errorCode = mapStatusCodeToErrorCode(statusCode, errorMessage);
  } else if (errorType) {
    errorCode = mapErrorTypeToErrorCode(errorType, errorMessage);
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
