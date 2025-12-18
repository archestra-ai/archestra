import type { SupportedProvider } from "./model-constants";

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
