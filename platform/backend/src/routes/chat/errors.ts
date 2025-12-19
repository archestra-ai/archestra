import {
  AnthropicErrorTypes,
  ChatErrorCode,
  ChatErrorMessages,
  type ChatErrorResponse,
  GeminiErrorCodes,
  OpenAIErrorTypes,
  RetryableErrorCodes,
  type SupportedProvider,
} from "@shared";
import { APICallError } from "ai";
import logger from "@/logging";

// =============================================================================
// Safe Serialization
// =============================================================================

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

// =============================================================================
// Parsed Error Types
// =============================================================================

interface ParsedOpenAIError {
  type?: string;
  code?: string;
  message?: string;
  param?: string;
}

interface ParsedAnthropicError {
  type?: string;
  message?: string;
}

interface ParsedGeminiError {
  code?: number;
  status?: string;
  message?: string;
  details?: unknown[];
}

// =============================================================================
// Provider-Specific Error Parsers
// =============================================================================

/**
 * Parse OpenAI error response body.
 * OpenAI errors have structure: { error: { type, code, message, param } }
 *
 * @see https://platform.openai.com/docs/guides/error-codes - Error codes guide
 * @see https://platform.openai.com/docs/api-reference/errors - API error reference
 */
function parseOpenAIError(responseBody: string): ParsedOpenAIError | null {
  try {
    const parsed = JSON.parse(responseBody);
    if (parsed?.error) {
      return {
        type: parsed.error.type,
        code: parsed.error.code,
        message: parsed.error.message,
        param: parsed.error.param,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse Anthropic error response body.
 * Anthropic errors have structure: { error: { type, message } } or { type, message }
 *
 * @see https://docs.anthropic.com/en/api/errors - Anthropic API errors documentation
 */
function parseAnthropicError(
  responseBody: string,
): ParsedAnthropicError | null {
  try {
    const parsed = JSON.parse(responseBody);
    // Handle nested error object
    if (parsed?.error) {
      return {
        type: parsed.error.type,
        message: parsed.error.message,
      };
    }
    // Handle flat structure
    if (parsed?.type) {
      return {
        type: parsed.type,
        message: parsed.message,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Recursively parse nested JSON strings to find the innermost error
 * Gemini errors can be deeply nested with JSON-encoded strings
 */
function parseNestedJson(obj: unknown, depth = 0): unknown {
  if (depth > 10) return obj; // Prevent infinite recursion

  if (typeof obj === "string") {
    try {
      const parsed = JSON.parse(obj);
      return parseNestedJson(parsed, depth + 1);
    } catch {
      return obj;
    }
  }

  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = parseNestedJson(value, depth + 1);
    }
    return result;
  }

  return obj;
}

/**
 * Parse Gemini/Vertex AI error response body.
 * Gemini errors have structure: { error: { code, status, message, details } }
 * Note: Errors can be deeply nested with JSON-encoded strings when proxied.
 *
 * @see https://ai.google.dev/gemini-api/docs/troubleshooting - Google AI Studio troubleshooting
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/error-codes - Vertex AI error codes
 * @see https://cloud.google.com/apis/design/errors - Google Cloud API error design (gRPC codes)
 */
function parseGeminiError(responseBody: string): ParsedGeminiError | null {
  try {
    // First, recursively parse any nested JSON strings
    const parsed = parseNestedJson(responseBody) as Record<string, unknown>;

    // Handle nested error structure (can be multiple levels deep)
    let errorObj = parsed;
    while (errorObj?.error && typeof errorObj.error === "object") {
      errorObj = errorObj.error as Record<string, unknown>;
    }

    // Extract the innermost error details
    if (errorObj) {
      return {
        code:
          typeof errorObj.code === "number"
            ? errorObj.code
            : typeof parsed?.error === "object"
              ? ((parsed.error as Record<string, unknown>).code as
                  | number
                  | undefined)
              : undefined,
        status:
          typeof errorObj.status === "string"
            ? errorObj.status
            : typeof parsed?.error === "object"
              ? ((parsed.error as Record<string, unknown>).status as
                  | string
                  | undefined)
              : undefined,
        message:
          typeof errorObj.message === "string"
            ? errorObj.message
            : typeof parsed?.error === "object"
              ? ((parsed.error as Record<string, unknown>).message as
                  | string
                  | undefined)
              : undefined,
        details: Array.isArray(errorObj.details) ? errorObj.details : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// Provider-Specific Error Mappers
// =============================================================================

/**
 * Map OpenAI error to ChatErrorCode.
 * Uses error.type and error.code fields from the API response.
 *
 * Error types documented at:
 * @see https://platform.openai.com/docs/guides/error-codes/api-errors
 *
 * HTTP Status -> Error Type mapping:
 * - 400 -> invalid_request_error (malformed request)
 * - 401 -> authentication_error (invalid API key)
 * - 403 -> permission_denied_error (no access to resource)
 * - 404 -> not_found_error (resource doesn't exist)
 * - 422 -> unprocessable_entity_error (valid request, can't process)
 * - 429 -> rate_limit_exceeded (quota exceeded)
 * - 500 -> server_error (internal error)
 * - 503 -> service_unavailable (temporarily down)
 */
function mapOpenAIErrorToCode(
  statusCode: number | undefined,
  parsedError: ParsedOpenAIError | null,
): ChatErrorCode {
  const errorType = parsedError?.type;
  const errorCode = parsedError?.code;

  // First check error.code for specific error codes
  if (errorCode) {
    if (
      errorCode === OpenAIErrorTypes.INVALID_API_KEY_CODE ||
      errorCode === OpenAIErrorTypes.INVALID_API_KEY
    ) {
      return ChatErrorCode.Authentication;
    }
    if (errorCode === OpenAIErrorTypes.CONTEXT_LENGTH_EXCEEDED) {
      return ChatErrorCode.ContextTooLong;
    }
    if (errorCode === OpenAIErrorTypes.MODEL_NOT_FOUND) {
      return ChatErrorCode.NotFound;
    }
  }

  // Then check error.type
  if (errorType) {
    switch (errorType) {
      case OpenAIErrorTypes.AUTHENTICATION:
      case OpenAIErrorTypes.INVALID_API_KEY:
        return ChatErrorCode.Authentication;
      case OpenAIErrorTypes.RATE_LIMIT:
        return ChatErrorCode.RateLimit;
      case OpenAIErrorTypes.PERMISSION_DENIED:
        return ChatErrorCode.PermissionDenied;
      case OpenAIErrorTypes.NOT_FOUND:
        return ChatErrorCode.NotFound;
      case OpenAIErrorTypes.SERVER_ERROR:
      case OpenAIErrorTypes.SERVICE_UNAVAILABLE:
        return ChatErrorCode.ServerError;
      case OpenAIErrorTypes.INVALID_REQUEST:
      case OpenAIErrorTypes.UNPROCESSABLE_ENTITY:
      case OpenAIErrorTypes.CONFLICT:
        return ChatErrorCode.InvalidRequest;
    }
  }

  // Fall back to status code
  return mapStatusCodeToErrorCode(statusCode);
}

/**
 * Map Anthropic error to ChatErrorCode.
 * Uses error.type field from the API response.
 *
 * Error types documented at:
 * @see https://docs.anthropic.com/en/api/errors
 *
 * HTTP Status -> Error Type mapping:
 * - 400 -> invalid_request_error (invalid request body)
 * - 401 -> authentication_error (invalid API key)
 * - 403 -> permission_error (no access to resource)
 * - 404 -> not_found_error (resource doesn't exist)
 * - 413 -> request_too_large (request exceeds max size)
 * - 429 -> rate_limit_error (quota exceeded)
 * - 500 -> api_error (internal error)
 * - 529 -> overloaded_error (API temporarily overloaded)
 */
function mapAnthropicErrorToCode(
  statusCode: number | undefined,
  parsedError: ParsedAnthropicError | null,
): ChatErrorCode {
  const errorType = parsedError?.type;

  if (errorType) {
    switch (errorType) {
      case AnthropicErrorTypes.AUTHENTICATION:
        return ChatErrorCode.Authentication;
      case AnthropicErrorTypes.RATE_LIMIT:
        return ChatErrorCode.RateLimit;
      case AnthropicErrorTypes.PERMISSION:
        return ChatErrorCode.PermissionDenied;
      case AnthropicErrorTypes.NOT_FOUND:
        return ChatErrorCode.NotFound;
      case AnthropicErrorTypes.REQUEST_TOO_LARGE:
        return ChatErrorCode.ContextTooLong;
      case AnthropicErrorTypes.API_ERROR:
      case AnthropicErrorTypes.OVERLOADED:
        return ChatErrorCode.ServerError;
      case AnthropicErrorTypes.INVALID_REQUEST:
        return ChatErrorCode.InvalidRequest;
    }
  }

  // Fall back to status code (including 529 for overloaded)
  if (statusCode === 529) {
    return ChatErrorCode.ServerError;
  }

  return mapStatusCodeToErrorCode(statusCode);
}

/**
 * Map Gemini/Vertex AI error to ChatErrorCode.
 * Uses error.status (gRPC status code string) from the API response.
 *
 * gRPC status codes documented at:
 * @see https://cloud.google.com/apis/design/errors#handling_errors
 * @see https://grpc.io/docs/guides/status-codes/
 *
 * HTTP Status -> gRPC Status mapping (per Google's AIP-193):
 * - 400 -> INVALID_ARGUMENT (client specified an invalid argument)
 * - 401 -> UNAUTHENTICATED (missing/invalid authentication)
 * - 403 -> PERMISSION_DENIED (insufficient permissions)
 * - 404 -> NOT_FOUND (resource doesn't exist)
 * - 429 -> RESOURCE_EXHAUSTED (quota exceeded)
 * - 500 -> INTERNAL (internal server error)
 * - 503 -> UNAVAILABLE (service temporarily unavailable)
 * - 504 -> DEADLINE_EXCEEDED (request timeout)
 */
function mapGeminiErrorToCode(
  statusCode: number | undefined,
  parsedError: ParsedGeminiError | null,
): ChatErrorCode {
  const grpcStatus = parsedError?.status;

  if (grpcStatus) {
    switch (grpcStatus) {
      case GeminiErrorCodes.UNAUTHENTICATED:
        return ChatErrorCode.Authentication;
      case GeminiErrorCodes.PERMISSION_DENIED:
        return ChatErrorCode.PermissionDenied;
      case GeminiErrorCodes.RESOURCE_EXHAUSTED:
        return ChatErrorCode.RateLimit;
      case GeminiErrorCodes.NOT_FOUND:
        return ChatErrorCode.NotFound;
      case GeminiErrorCodes.INVALID_ARGUMENT:
      case GeminiErrorCodes.FAILED_PRECONDITION:
      case GeminiErrorCodes.OUT_OF_RANGE:
        return ChatErrorCode.InvalidRequest;
      case GeminiErrorCodes.INTERNAL:
      case GeminiErrorCodes.UNAVAILABLE:
      case GeminiErrorCodes.DEADLINE_EXCEEDED:
        return ChatErrorCode.ServerError;
    }
  }

  // Fall back to status code
  return mapStatusCodeToErrorCode(statusCode);
}

/**
 * Generic status code to error code mapping (fallback)
 */
function mapStatusCodeToErrorCode(
  statusCode: number | undefined,
): ChatErrorCode {
  if (!statusCode) {
    return ChatErrorCode.Unknown;
  }

  switch (statusCode) {
    case 400:
      return ChatErrorCode.InvalidRequest;
    case 401:
      return ChatErrorCode.Authentication;
    case 403:
      return ChatErrorCode.PermissionDenied;
    case 404:
      return ChatErrorCode.NotFound;
    case 413:
      return ChatErrorCode.ContextTooLong;
    case 422:
      return ChatErrorCode.InvalidRequest;
    case 429:
      return ChatErrorCode.RateLimit;
    case 529: // Anthropic overloaded
      return ChatErrorCode.ServerError;
    default:
      if (statusCode >= 500) {
        return ChatErrorCode.ServerError;
      }
      return ChatErrorCode.Unknown;
  }
}

// =============================================================================
// Provider Parser/Mapper Registry
// =============================================================================

/** Union type of all parsed error types */
type ParsedProviderError =
  | ParsedOpenAIError
  | ParsedAnthropicError
  | ParsedGeminiError;

type ErrorParser = (responseBody: string) => ParsedProviderError | null;
type ErrorMapper = (
  statusCode: number | undefined,
  parsedError: ParsedProviderError | null,
) => ChatErrorCode;

/**
 * Wrapper functions that accept the union type for type compatibility
 */
function mapOpenAIErrorWrapper(
  statusCode: number | undefined,
  parsedError: ParsedProviderError | null,
): ChatErrorCode {
  return mapOpenAIErrorToCode(
    statusCode,
    parsedError as ParsedOpenAIError | null,
  );
}

function mapAnthropicErrorWrapper(
  statusCode: number | undefined,
  parsedError: ParsedProviderError | null,
): ChatErrorCode {
  return mapAnthropicErrorToCode(
    statusCode,
    parsedError as ParsedAnthropicError | null,
  );
}

function mapGeminiErrorWrapper(
  statusCode: number | undefined,
  parsedError: ParsedProviderError | null,
): ChatErrorCode {
  return mapGeminiErrorToCode(
    statusCode,
    parsedError as ParsedGeminiError | null,
  );
}

/**
 * Registry of provider-specific error parsers.
 * Using Record<SupportedProvider, ...> ensures TypeScript will error
 * if a new provider is added to SupportedProvider without updating this map.
 */
const providerParsers: Record<SupportedProvider, ErrorParser> = {
  openai: parseOpenAIError,
  anthropic: parseAnthropicError,
  gemini: parseGeminiError,
};

/**
 * Registry of provider-specific error mappers.
 * Using Record<SupportedProvider, ...> ensures TypeScript will error
 * if a new provider is added to SupportedProvider without updating this map.
 */
const providerMappers: Record<SupportedProvider, ErrorMapper> = {
  openai: mapOpenAIErrorWrapper,
  anthropic: mapAnthropicErrorWrapper,
  gemini: mapGeminiErrorWrapper,
};

// =============================================================================
// Message Extraction
// =============================================================================

/**
 * Recursively find the deepest string message in a parsed object
 * Handles both cases where message is a string or an already-parsed object
 */
function findDeepestMessage(obj: unknown, depth = 0): string | null {
  if (depth > 10) return null;

  if (typeof obj !== "object" || obj === null) {
    return null;
  }

  const record = obj as Record<string, unknown>;

  // If message is a string, check if it's a meaningful message
  if (typeof record.message === "string" && record.message.length > 0) {
    // If message doesn't look like JSON, return it
    if (!record.message.startsWith("{") && !record.message.startsWith("[")) {
      return record.message;
    }
  }

  // If message is an object (already parsed from nested JSON), recurse into it
  if (typeof record.message === "object" && record.message !== null) {
    const deeper = findDeepestMessage(record.message, depth + 1);
    if (deeper) return deeper;
  }

  // Recurse into error object
  if (typeof record.error === "object" && record.error !== null) {
    const deeper = findDeepestMessage(record.error, depth + 1);
    if (deeper) return deeper;
  }

  // If we have a message that looks like JSON, still return it as fallback
  if (typeof record.message === "string" && record.message.length > 0) {
    return record.message;
  }

  return null;
}

/**
 * Extract the most meaningful error message from the parsed error or raw response
 */
function extractErrorMessage(
  parsedError: ParsedProviderError | null,
  responseBody: string | undefined,
  error: unknown,
): string {
  // Try to extract from responseBody with deep parsing first (for nested Gemini errors)
  if (responseBody) {
    try {
      const parsed = parseNestedJson(responseBody) as Record<string, unknown>;
      const deepMessage = findDeepestMessage(parsed, 0);
      if (deepMessage) {
        return deepMessage;
      }
    } catch {
      // Ignore parsing errors
    }
  }

  // Then try to get message from parsed error
  if (parsedError?.message) {
    return parsedError.message;
  }

  // Fall back to error object properties
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") {
      return obj.message;
    }
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}

// =============================================================================
// Main Error Mapper
// =============================================================================

/**
 * Create a ChatErrorResponse from the determined error code.
 * The rawError is safely serialized to handle circular references.
 */
function createErrorResponse(
  code: ChatErrorCode,
  provider: SupportedProvider,
  status: number | undefined,
  originalMessage: string,
  errorType: string | undefined,
  rawError: unknown,
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
 * Uses provider-specific parsing and mapping for accurate error classification.
 *
 * @param error - The error to map (typically an APICallError from Vercel AI SDK)
 * @param provider - The provider that generated the error
 * @returns A normalized ChatErrorResponse with user-friendly message and technical details
 */
export function mapProviderError(
  error: unknown,
  provider: SupportedProvider,
): ChatErrorResponse {
  logger.debug({ error, provider }, "[ChatErrorMapper] Mapping provider error");

  // Get provider-specific parser and mapper
  const parseError = providerParsers[provider];
  const mapError = providerMappers[provider];

  let statusCode: number | undefined;
  let responseBody: string | undefined;
  let parsedError: ParsedProviderError | null = null;

  // Handle Vercel AI SDK APICallError
  if (APICallError.isInstance(error)) {
    const apiError = error as InstanceType<typeof APICallError>;
    statusCode = apiError.statusCode;
    responseBody = apiError.responseBody;

    // Parse the response body using provider-specific parser
    if (responseBody) {
      parsedError = parseError(responseBody);
    }
  } else if (typeof error === "object" && error !== null) {
    // Handle generic error objects
    const obj = error as Record<string, unknown>;
    statusCode =
      typeof obj.statusCode === "number"
        ? obj.statusCode
        : typeof obj.status === "number"
          ? obj.status
          : undefined;
    responseBody =
      typeof obj.responseBody === "string" ? obj.responseBody : undefined;

    if (responseBody) {
      parsedError = parseError(responseBody);
    }
  }

  // Map to error code using provider-specific mapper
  const errorCode = mapError(statusCode, parsedError);

  // Extract the most meaningful error message
  const errorMessage = extractErrorMessage(parsedError, responseBody, error);

  // Determine error type from parsed error
  const errorType =
    (parsedError as ParsedOpenAIError)?.type ||
    (parsedError as ParsedAnthropicError)?.type ||
    (parsedError as ParsedGeminiError)?.status ||
    (error instanceof Error ? error.name : undefined);

  logger.info(
    {
      provider,
      statusCode,
      parsedError,
      mappedCode: errorCode,
      errorMessage,
    },
    "[ChatErrorMapper] Mapped provider error",
  );

  return createErrorResponse(
    errorCode,
    provider,
    statusCode,
    errorMessage,
    errorType,
    {
      url: APICallError.isInstance(error)
        ? (error as InstanceType<typeof APICallError>).url
        : undefined,
      statusCode,
      responseBody,
      isRetryable: APICallError.isInstance(error)
        ? (error as InstanceType<typeof APICallError>).isRetryable
        : undefined,
    },
  );
}
