import type { SupportedProvider } from "./model-constants";

// =============================================================================
// Provider-Specific Error Types (from official documentation)
// =============================================================================

/**
 * OpenAI API error types (from response body `error.type` field)
 * @see https://platform.openai.com/docs/guides/error-codes
 */
export const OpenAIErrorTypes = {
  INVALID_REQUEST: "invalid_request_error",
  AUTHENTICATION: "authentication_error",
  INVALID_API_KEY: "invalid_api_key",
  PERMISSION_DENIED: "insufficient_quota", // OpenAI uses this for permission issues
  NOT_FOUND: "not_found_error",
  CONFLICT: "conflict_error",
  UNPROCESSABLE_ENTITY: "unprocessable_entity_error",
  RATE_LIMIT: "rate_limit_exceeded",
  SERVER_ERROR: "server_error",
  SERVICE_UNAVAILABLE: "service_unavailable",
  // Additional codes that appear in error.code field
  INVALID_API_KEY_CODE: "invalid_api_key",
  MODEL_NOT_FOUND: "model_not_found",
  CONTEXT_LENGTH_EXCEEDED: "context_length_exceeded",
} as const;

/**
 * Anthropic API error types (from response body `error.type` field)
 * @see https://docs.anthropic.com/en/api/errors
 */
export const AnthropicErrorTypes = {
  INVALID_REQUEST: "invalid_request_error",
  AUTHENTICATION: "authentication_error",
  PERMISSION: "permission_error",
  NOT_FOUND: "not_found_error",
  REQUEST_TOO_LARGE: "request_too_large",
  RATE_LIMIT: "rate_limit_error",
  API_ERROR: "api_error",
  OVERLOADED: "overloaded_error",
} as const;

/**
 * Gemini/Vertex AI gRPC status codes (from response body `error.status` field)
 * @see https://ai.google.dev/gemini-api/docs/troubleshooting
 * @see https://cloud.google.com/apis/design/errors
 */
export const GeminiErrorCodes = {
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  NOT_FOUND: "NOT_FOUND",
  RESOURCE_EXHAUSTED: "RESOURCE_EXHAUSTED",
  INTERNAL: "INTERNAL",
  UNAVAILABLE: "UNAVAILABLE",
  // Additional codes for specific scenarios
  FAILED_PRECONDITION: "FAILED_PRECONDITION",
  OUT_OF_RANGE: "OUT_OF_RANGE",
  DEADLINE_EXCEEDED: "DEADLINE_EXCEEDED",
} as const;

/**
 * Gemini/Vertex AI ErrorInfo reason codes (from `error.details[].reason` field)
 * These provide more specific error reasons extracted from google.rpc.ErrorInfo.
 *
 * @see https://cloud.google.com/apis/design/errors#error_info
 * @see https://googleapis.dev/nodejs/spanner/latest/google.rpc.ErrorInfo.html
 */
export const GeminiErrorReasons = {
  // Authentication/Authorization reasons
  API_KEY_INVALID: "API_KEY_INVALID",
  API_KEY_NOT_FOUND: "API_KEY_NOT_FOUND",
  API_KEY_EXPIRED: "API_KEY_EXPIRED",
  ACCESS_TOKEN_EXPIRED: "ACCESS_TOKEN_EXPIRED",
  ACCESS_TOKEN_INVALID: "ACCESS_TOKEN_INVALID",
  SERVICE_ACCOUNT_INVALID: "SERVICE_ACCOUNT_INVALID",

  // Quota/Rate limit reasons
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  RESOURCE_EXHAUSTED: "RESOURCE_EXHAUSTED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",

  // Resource reasons
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",

  // Content/Safety reasons
  SAFETY_BLOCKED: "SAFETY_BLOCKED",
  RECITATION_BLOCKED: "RECITATION_BLOCKED",
  CONTENT_FILTERED: "CONTENT_FILTERED",

  // Request reasons
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  CONTEXT_LENGTH_EXCEEDED: "CONTEXT_LENGTH_EXCEEDED",
} as const;

// =============================================================================
// Normalized Chat Error Codes
// =============================================================================

/**
 * Normalized error codes for chat errors across all LLM providers.
 * These provide a consistent set of error categories regardless of the underlying provider.
 */
export enum ChatErrorCode {
  /** Rate/quota exceeded - retryable after delay */
  RateLimit = "rate_limit",
  /** Invalid or missing API key */
  Authentication = "authentication",
  /** API key lacks permissions for the requested resource */
  PermissionDenied = "permission_denied",
  /** Malformed or invalid request */
  InvalidRequest = "invalid_request",
  /** Model or resource not found */
  NotFound = "not_found",
  /** Input exceeds the model's context window */
  ContextTooLong = "context_too_long",
  /** Content blocked by safety filters */
  ContentFiltered = "content_filtered",
  /** Provider server error - retryable */
  ServerError = "server_error",
  /** Network/connection issues - retryable */
  NetworkError = "network_error",
  /** Catch-all for unrecognized errors */
  Unknown = "unknown",
}

/**
 * User-friendly error messages for each error code
 */
export const ChatErrorMessages: Record<ChatErrorCode, string> = {
  [ChatErrorCode.RateLimit]:
    "Too many requests. Please wait a moment and try again.",
  [ChatErrorCode.Authentication]:
    "Invalid API key. Please check your Chat Settings.",
  [ChatErrorCode.PermissionDenied]:
    "Your API key doesn't have permission for this model.",
  [ChatErrorCode.InvalidRequest]:
    "There was an issue with your request. Please try again.",
  [ChatErrorCode.NotFound]:
    "The selected model is not available. Please choose a different model.",
  [ChatErrorCode.ContextTooLong]:
    "Your conversation is too long. Please start a new chat or remove some messages.",
  [ChatErrorCode.ContentFiltered]:
    "Your message was blocked by content filters. Please rephrase your request.",
  [ChatErrorCode.ServerError]:
    "The AI provider is experiencing issues. Please try again in a moment.",
  [ChatErrorCode.NetworkError]:
    "Connection error. Please check your network and try again.",
  [ChatErrorCode.Unknown]: "An unexpected error occurred. Please try again.",
};

/**
 * Error codes that indicate the operation can be retried
 */
export const RetryableErrorCodes: Set<ChatErrorCode> = new Set([
  ChatErrorCode.RateLimit,
  ChatErrorCode.ServerError,
  ChatErrorCode.NetworkError,
]);

/**
 * Structured error response returned by the chat API for error conditions.
 * Provides both user-friendly messaging and technical details for debugging.
 */
export interface ChatErrorResponse {
  /** Normalized error code */
  code: ChatErrorCode;
  /** User-friendly error message */
  message: string;
  /** Whether the operation can be retried */
  isRetryable: boolean;
  /** Original error details for debugging (provider-specific) */
  originalError?: {
    /** Provider name (anthropic, openai, gemini) */
    provider?: SupportedProvider;
    /** HTTP status code if applicable */
    status?: number;
    /** Original error message from provider */
    message?: string;
    /** Error type from provider */
    type?: string;
    /** Full error object for detailed debugging */
    raw?: unknown;
  };
}

/**
 * Type guard to check if an object is a ChatErrorResponse
 */
export function isChatErrorResponse(obj: unknown): obj is ChatErrorResponse {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }
  const response = obj as ChatErrorResponse;
  return (
    typeof response.code === "string" &&
    Object.values(ChatErrorCode).includes(response.code as ChatErrorCode) &&
    typeof response.message === "string" &&
    typeof response.isRetryable === "boolean"
  );
}
