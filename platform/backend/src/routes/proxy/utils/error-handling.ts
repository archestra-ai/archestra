import type { FastifyReply } from "fastify";
import type { APIError as AnthropicAPIError } from "@anthropic-ai/sdk/error";
import type { APIError as OpenAIAPIError } from "openai/error";

/**
 * Structured error response format
 */
export interface ErrorResponse {
  error: {
    message: string;
    type: string;
    code?: string;
    param?: string;
  };
}

/**
 * Provider error types that map to specific HTTP status codes
 */
export enum ProviderErrorType {
  // 4xx Client Errors
  INVALID_REQUEST = "invalid_request_error",
  AUTHENTICATION = "authentication_error",
  PERMISSION_DENIED = "permission_denied_error",
  NOT_FOUND = "not_found_error",
  RATE_LIMIT = "rate_limit_error",
  BILLING = "insufficient_quota",

  // 5xx Server Errors
  API_ERROR = "api_error",
  OVERLOADED = "overloaded_error",
  INTERNAL_SERVER = "internal_server_error",

  // Network/Timeout Errors
  TIMEOUT = "timeout_error",
  CONNECTION = "connection_error",
}

/**
 * Map provider error types to HTTP status codes following Vercel AI SDK best practices
 */
export function getStatusCodeForErrorType(errorType: string): number {
  switch (errorType) {
    // 400 Bad Request - Invalid parameters or request format
    case ProviderErrorType.INVALID_REQUEST:
      return 400;

    // 401 Unauthorized - Missing or invalid authentication
    case ProviderErrorType.AUTHENTICATION:
      return 401;

    // 402 Payment Required - Billing issues (no credits, quota exceeded)
    case ProviderErrorType.BILLING:
    case "insufficient_quota":
      return 402;

    // 403 Forbidden - Permission denied
    case ProviderErrorType.PERMISSION_DENIED:
      return 403;

    // 404 Not Found - Resource not found
    case ProviderErrorType.NOT_FOUND:
      return 404;

    // 429 Too Many Requests - Rate limiting
    case ProviderErrorType.RATE_LIMIT:
    case "rate_limit_exceeded":
      return 429;

    // 503 Service Unavailable - Provider is overloaded or temporarily unavailable
    case ProviderErrorType.OVERLOADED:
      return 503;

    // 504 Gateway Timeout - Request timeout
    case ProviderErrorType.TIMEOUT:
      return 504;

    // 500 Internal Server Error - Everything else
    default:
      return 500;
  }
}

/**
 * Parse Anthropic SDK errors
 */
export function parseAnthropicError(error: unknown): {
  statusCode: number;
  errorResponse: ErrorResponse;
  retryAfter?: number;
} {
  // Handle Anthropic API errors
  if (isAnthropicAPIError(error)) {
    const errorType = error.type || ProviderErrorType.API_ERROR;
    const statusCode = error.status || getStatusCodeForErrorType(errorType);

    return {
      statusCode,
      errorResponse: {
        error: {
          message: error.message || "An error occurred with the Anthropic API",
          type: errorType,
          ...(error.error?.error?.param && { param: error.error.error.param }),
        },
      },
      // Extract retry-after from headers if available
      retryAfter: extractRetryAfter(error),
    };
  }

  // Handle timeout errors
  if (error instanceof Error && error.name === "TimeoutError") {
    return {
      statusCode: 504,
      errorResponse: {
        error: {
          message: "Request to Anthropic timed out",
          type: ProviderErrorType.TIMEOUT,
        },
      },
    };
  }

  // Handle network/connection errors
  if (error instanceof Error && (error.name === "FetchError" || error.message.includes("fetch failed"))) {
    return {
      statusCode: 503,
      errorResponse: {
        error: {
          message: "Failed to connect to Anthropic API",
          type: ProviderErrorType.CONNECTION,
        },
      },
    };
  }

  // Generic error fallback
  return {
    statusCode: 500,
    errorResponse: {
      error: {
        message: error instanceof Error ? error.message : "Internal server error",
        type: ProviderErrorType.INTERNAL_SERVER,
      },
    },
  };
}

/**
 * Parse OpenAI SDK errors
 */
export function parseOpenAIError(error: unknown): {
  statusCode: number;
  errorResponse: ErrorResponse;
  retryAfter?: number;
} {
  // Handle OpenAI API errors
  if (isOpenAIAPIError(error)) {
    const errorType = error.type || ProviderErrorType.API_ERROR;
    const statusCode = error.status || getStatusCodeForErrorType(errorType);

    return {
      statusCode,
      errorResponse: {
        error: {
          message: error.message || "An error occurred with the OpenAI API",
          type: errorType,
          code: error.code,
          ...(error.param && { param: error.param }),
        },
      },
      retryAfter: extractRetryAfter(error),
    };
  }

  // Handle timeout errors
  if (error instanceof Error && error.name === "TimeoutError") {
    return {
      statusCode: 504,
      errorResponse: {
        error: {
          message: "Request to OpenAI timed out",
          type: ProviderErrorType.TIMEOUT,
        },
      },
    };
  }

  // Handle network/connection errors
  if (error instanceof Error && (error.name === "FetchError" || error.message.includes("fetch failed"))) {
    return {
      statusCode: 503,
      errorResponse: {
        error: {
          message: "Failed to connect to OpenAI API",
          type: ProviderErrorType.CONNECTION,
        },
      },
    };
  }

  // Generic error fallback
  return {
    statusCode: 500,
    errorResponse: {
      error: {
        message: error instanceof Error ? error.message : "Internal server error",
        type: ProviderErrorType.INTERNAL_SERVER,
      },
    },
  };
}

/**
 * Send error response following Vercel AI SDK best practices
 */
export function sendErrorResponse(
  reply: FastifyReply,
  error: unknown,
  provider: "anthropic" | "openai",
  fastifyLogger?: { error: (error: unknown) => void },
): FastifyReply {
  // Log the error
  if (fastifyLogger) {
    fastifyLogger.error(error);
  }

  // Parse based on provider
  const parsed = provider === "anthropic"
    ? parseAnthropicError(error)
    : parseOpenAIError(error);

  // Add Retry-After header for rate limit errors
  if (parsed.statusCode === 429 && parsed.retryAfter) {
    reply.header("Retry-After", parsed.retryAfter.toString());
  }

  // Add X-RateLimit headers if available
  if (error && typeof error === "object" && "headers" in error) {
    const headers = (error as any).headers;

    // Forward rate limit headers from provider
    if (provider === "anthropic") {
      forwardAnthropicRateLimitHeaders(reply, headers);
    } else if (provider === "openai") {
      forwardOpenAIRateLimitHeaders(reply, headers);
    }
  }

  return reply.status(parsed.statusCode).send(parsed.errorResponse);
}

/**
 * Send streaming error response for SSE connections
 */
export function sendStreamingError(
  reply: FastifyReply,
  error: unknown,
  provider: "anthropic" | "openai",
  fastifyLogger?: { error: (error: unknown) => void },
): FastifyReply {
  // Log the error
  if (fastifyLogger) {
    fastifyLogger.error(error);
  }

  // Parse based on provider
  const parsed = provider === "anthropic"
    ? parseAnthropicError(error)
    : parseOpenAIError(error);

  if (provider === "anthropic") {
    // Anthropic SSE error format
    const errorEvent = {
      type: "error",
      error: parsed.errorResponse.error,
    };
    reply.raw.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
  } else {
    // OpenAI SSE error format (just data, no event prefix)
    reply.raw.write(`data: ${JSON.stringify(parsed.errorResponse)}\n\n`);
  }

  reply.raw.end();
  return reply;
}

/**
 * Type guards
 */
function isAnthropicAPIError(error: unknown): error is AnthropicAPIError {
  return (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    "type" in error
  );
}

function isOpenAIAPIError(error: unknown): error is OpenAIAPIError {
  return (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    ("type" in error || "code" in error)
  );
}

/**
 * Extract retry-after from error headers
 */
function extractRetryAfter(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("headers" in error)) {
    return undefined;
  }

  const headers = (error as any).headers;
  if (!headers) return undefined;

  // Try lowercase and uppercase variants
  const retryAfter = headers["retry-after"] || headers["Retry-After"];

  if (typeof retryAfter === "string") {
    const seconds = parseInt(retryAfter, 10);
    return isNaN(seconds) ? undefined : seconds;
  }

  if (typeof retryAfter === "number") {
    return retryAfter;
  }

  return undefined;
}

/**
 * Forward Anthropic rate limit headers to client
 */
function forwardAnthropicRateLimitHeaders(reply: FastifyReply, headers: any) {
  if (!headers) return;

  const rateLimitHeaders = [
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
    "retry-after",
  ];

  for (const header of rateLimitHeaders) {
    if (headers[header]) {
      reply.header(header, headers[header]);
    }
  }
}

/**
 * Forward OpenAI rate limit headers to client
 */
function forwardOpenAIRateLimitHeaders(reply: FastifyReply, headers: any) {
  if (!headers) return;

  const rateLimitHeaders = [
    "x-ratelimit-limit-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "retry-after",
  ];

  for (const header of rateLimitHeaders) {
    if (headers[header]) {
      reply.header(header, headers[header]);
    }
  }
}
