import {
  AnthropicErrorTypes,
  ChatErrorCode,
  ChatErrorMessages,
  type ChatErrorResponse,
  GeminiErrorCodes,
  GeminiErrorReasons,
  OllamaErrorTypes,
  OpenAIErrorTypes,
  RetryableErrorCodes,
  type SupportedProvider,
  VllmErrorTypes,
} from "@shared";
import { APICallError, RetryError } from "ai";
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

/**
 * Parsed ErrorInfo from google.rpc.ErrorInfo in the details array.
 * @see https://cloud.google.com/apis/design/errors#error_info
 * @see https://googleapis.dev/nodejs/spanner/latest/google.rpc.ErrorInfo.html
 */
interface GeminiErrorInfo {
  /** The reason for the error (e.g., "API_KEY_INVALID", "RESOURCE_EXHAUSTED") */
  reason?: string;
  /** The domain of the error (e.g., "googleapis.com") */
  domain?: string;
  /** Additional metadata about the error */
  metadata?: Record<string, string>;
}

interface ParsedGeminiError {
  code?: number;
  status?: string;
  message?: string;
  details?: unknown[];
  /** Extracted ErrorInfo from details array, if present */
  errorInfo?: GeminiErrorInfo;
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
 * Recursively parse nested JSON strings to find the innermost error.
 * Gemini errors can be deeply nested with JSON-encoded strings.
 * Arrays are preserved during parsing to maintain the details array structure.
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

  // Preserve arrays (important for details array)
  if (Array.isArray(obj)) {
    return obj.map((item) => parseNestedJson(item, depth + 1));
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
 * Extract ErrorInfo from the details array (or object-like array from nested JSON parsing).
 * ErrorInfo provides specific error reasons like "API_KEY_INVALID".
 *
 * @see https://cloud.google.com/apis/design/errors#error_info
 * @see https://googleapis.dev/nodejs/spanner/latest/google.rpc.ErrorInfo.html
 */
function extractErrorInfo(
  details: unknown[] | Record<string, unknown>,
): GeminiErrorInfo | undefined {
  // Handle both arrays and object-like arrays (from nested JSON parsing)
  const items = Array.isArray(details) ? details : Object.values(details);

  for (const detail of items) {
    if (typeof detail !== "object" || detail === null) continue;

    const detailObj = detail as Record<string, unknown>;

    // Check for ErrorInfo type (can be @type or type field)
    const typeField = detailObj["@type"] || detailObj.type;
    if (
      typeof typeField === "string" &&
      typeField.includes("google.rpc.ErrorInfo")
    ) {
      return {
        reason:
          typeof detailObj.reason === "string" ? detailObj.reason : undefined,
        domain:
          typeof detailObj.domain === "string" ? detailObj.domain : undefined,
        metadata:
          typeof detailObj.metadata === "object" && detailObj.metadata !== null
            ? (detailObj.metadata as Record<string, string>)
            : undefined,
      };
    }
  }
  return undefined;
}

/**
 * Recursively find the innermost error object that has actual error fields.
 * After parseNestedJson, the error structure can have error objects nested inside
 * message fields (which were previously JSON strings).
 */
function findInnermostError(
  obj: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 10) return obj;

  // Check if this object has the typical error fields (status, code, details)
  const hasErrorFields =
    typeof obj.status === "string" ||
    typeof obj.code === "number" ||
    Array.isArray(obj.details) ||
    (typeof obj.details === "object" && obj.details !== null);

  // If we have error fields and also have a nested error, prefer the deeper one
  if (typeof obj.error === "object" && obj.error !== null) {
    const nestedError = findInnermostError(
      obj.error as Record<string, unknown>,
      depth + 1,
    );
    // If the nested error has more specific fields, use it
    if (
      typeof nestedError.status === "string" ||
      typeof nestedError.details === "object"
    ) {
      return nestedError;
    }
  }

  // If message is an object (parsed from nested JSON), check for error inside it
  if (typeof obj.message === "object" && obj.message !== null) {
    const nestedMessage = obj.message as Record<string, unknown>;
    if (
      typeof nestedMessage.error === "object" &&
      nestedMessage.error !== null
    ) {
      const nestedError = findInnermostError(
        nestedMessage.error as Record<string, unknown>,
        depth + 1,
      );
      if (
        typeof nestedError.status === "string" ||
        typeof nestedError.details === "object"
      ) {
        return nestedError;
      }
    }
  }

  // If current object has error fields, return it
  if (hasErrorFields) {
    return obj;
  }

  return obj;
}

/**
 * Parse Gemini/Vertex AI error response body.
 * Gemini errors have structure: { error: { code, status, message, details } }
 * Note: Errors can be deeply nested with JSON-encoded strings when proxied.
 *
 * The `details` array may contain google.rpc.ErrorInfo objects with specific
 * error reasons (e.g., "API_KEY_INVALID") that provide more precise error
 * classification than the status code alone.
 *
 * @see https://ai.google.dev/gemini-api/docs/troubleshooting - Google AI Studio troubleshooting
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/error-codes - Vertex AI error codes
 * @see https://cloud.google.com/apis/design/errors - Google Cloud API error design (gRPC codes)
 * @see https://googleapis.dev/nodejs/spanner/latest/google.rpc.ErrorInfo.html - ErrorInfo structure
 */
function parseGeminiError(responseBody: string): ParsedGeminiError | null {
  try {
    // First, recursively parse any nested JSON strings
    const parsed = parseNestedJson(responseBody) as Record<string, unknown>;

    // Find the innermost error object that has the actual error fields
    let errorObj = parsed;
    if (typeof parsed.error === "object" && parsed.error !== null) {
      errorObj = findInnermostError(parsed.error as Record<string, unknown>);
    }

    // Extract the innermost error details
    if (errorObj) {
      // Details can be an array or object-like array from nested JSON parsing
      const details =
        Array.isArray(errorObj.details) ||
        (typeof errorObj.details === "object" && errorObj.details !== null)
          ? (errorObj.details as unknown[] | Record<string, unknown>)
          : undefined;

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
        details: Array.isArray(details) ? details : undefined,
        // Extract ErrorInfo for specific error reason mapping
        errorInfo: details ? extractErrorInfo(details) : undefined,
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
 * Uses error.status (gRPC status code) and error.details[].reason (ErrorInfo) from the API response.
 *
 * The ErrorInfo reason (from details array) provides more specific error classification
 * than the gRPC status alone. For example, INVALID_ARGUMENT status with API_KEY_INVALID
 * reason should map to Authentication, not InvalidRequest.
 *
 * gRPC status codes documented at:
 * @see https://cloud.google.com/apis/design/errors#handling_errors
 * @see https://grpc.io/docs/guides/status-codes/
 *
 * ErrorInfo reasons documented at:
 * @see https://cloud.google.com/apis/design/errors#error_info
 * @see https://googleapis.dev/nodejs/spanner/latest/google.rpc.ErrorInfo.html
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
  const errorReason = parsedError?.errorInfo?.reason;

  // First, check ErrorInfo reason for more specific error classification
  // This takes precedence because it provides more detail than status alone
  if (errorReason) {
    switch (errorReason) {
      // Authentication errors
      case GeminiErrorReasons.API_KEY_INVALID:
      case GeminiErrorReasons.API_KEY_NOT_FOUND:
      case GeminiErrorReasons.API_KEY_EXPIRED:
      case GeminiErrorReasons.ACCESS_TOKEN_EXPIRED:
      case GeminiErrorReasons.ACCESS_TOKEN_INVALID:
      case GeminiErrorReasons.SERVICE_ACCOUNT_INVALID:
        return ChatErrorCode.Authentication;

      // Rate limit / quota errors
      case GeminiErrorReasons.RATE_LIMIT_EXCEEDED:
      case GeminiErrorReasons.RESOURCE_EXHAUSTED:
      case GeminiErrorReasons.QUOTA_EXCEEDED:
        return ChatErrorCode.RateLimit;

      // Not found errors
      case GeminiErrorReasons.MODEL_NOT_FOUND:
      case GeminiErrorReasons.RESOURCE_NOT_FOUND:
        return ChatErrorCode.NotFound;

      // Content filtering errors
      case GeminiErrorReasons.SAFETY_BLOCKED:
      case GeminiErrorReasons.RECITATION_BLOCKED:
      case GeminiErrorReasons.CONTENT_FILTERED:
        return ChatErrorCode.ContentFiltered;

      // Context length errors
      case GeminiErrorReasons.CONTEXT_LENGTH_EXCEEDED:
        return ChatErrorCode.ContextTooLong;
    }
  }

  // Fall back to gRPC status code
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

  // Fall back to HTTP status code
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
 * Parse vLLM error response body.
 * vLLM uses OpenAI-compatible error format: { error: { type, code, message } }
 *
 * @see https://docs.vllm.ai/en/latest/features/openai_api.html
 */
function parseVllmError(responseBody: string): ParsedOpenAIError | null {
  // vLLM uses the same error format as OpenAI
  return parseOpenAIError(responseBody);
}

/**
 * Map vLLM error to ChatErrorCode.
 * vLLM uses OpenAI-compatible error format with some additional codes.
 *
 * @see https://docs.vllm.ai/en/latest/features/openai_api.html
 */
function mapVllmErrorToCode(
  statusCode: number | undefined,
  parsedError: ParsedOpenAIError | null,
): ChatErrorCode {
  const errorType = parsedError?.type;
  const errorCode = parsedError?.code;

  // First check error.code for specific error codes
  if (errorCode) {
    if (
      errorCode === VllmErrorTypes.INVALID_API_KEY ||
      errorCode === OpenAIErrorTypes.INVALID_API_KEY_CODE
    ) {
      return ChatErrorCode.Authentication;
    }
    if (
      errorCode === VllmErrorTypes.CONTEXT_LENGTH_EXCEEDED ||
      errorCode === OpenAIErrorTypes.CONTEXT_LENGTH_EXCEEDED
    ) {
      return ChatErrorCode.ContextTooLong;
    }
    if (errorCode === VllmErrorTypes.MODEL_NOT_LOADED) {
      return ChatErrorCode.NotFound;
    }
  }

  // Then check error.type
  if (errorType) {
    switch (errorType) {
      case VllmErrorTypes.AUTHENTICATION:
      case VllmErrorTypes.INVALID_API_KEY:
        return ChatErrorCode.Authentication;
      case VllmErrorTypes.NOT_FOUND:
        return ChatErrorCode.NotFound;
      case VllmErrorTypes.SERVER_ERROR:
      case VllmErrorTypes.SERVICE_UNAVAILABLE:
        return ChatErrorCode.ServerError;
      case VllmErrorTypes.INVALID_REQUEST:
        return ChatErrorCode.InvalidRequest;
    }
  }

  // Fall back to OpenAI error mapping (since vLLM is OpenAI-compatible)
  return mapOpenAIErrorToCode(statusCode, parsedError);
}

function mapVllmErrorWrapper(
  statusCode: number | undefined,
  parsedError: ParsedProviderError | null,
): ChatErrorCode {
  return mapVllmErrorToCode(
    statusCode,
    parsedError as ParsedOpenAIError | null,
  );
}

/**
 * Parse Ollama error response body.
 * Ollama uses OpenAI-compatible error format: { error: { type, code, message } }
 *
 * @see https://github.com/ollama/ollama/blob/main/docs/openai.md
 */
function parseOllamaError(responseBody: string): ParsedOpenAIError | null {
  // Ollama uses the same error format as OpenAI
  return parseOpenAIError(responseBody);
}

/**
 * Map Ollama error to ChatErrorCode.
 * Ollama uses OpenAI-compatible error format with some additional codes.
 *
 * @see https://github.com/ollama/ollama/blob/main/docs/openai.md
 */
function mapOllamaErrorToCode(
  statusCode: number | undefined,
  parsedError: ParsedOpenAIError | null,
): ChatErrorCode {
  const errorType = parsedError?.type;
  const errorCode = parsedError?.code;

  // First check error.code for specific error codes
  if (errorCode) {
    if (
      errorCode === OllamaErrorTypes.INVALID_API_KEY ||
      errorCode === OpenAIErrorTypes.INVALID_API_KEY_CODE
    ) {
      return ChatErrorCode.Authentication;
    }
    if (
      errorCode === OllamaErrorTypes.CONTEXT_LENGTH_EXCEEDED ||
      errorCode === OpenAIErrorTypes.CONTEXT_LENGTH_EXCEEDED
    ) {
      return ChatErrorCode.ContextTooLong;
    }
    if (errorCode === OllamaErrorTypes.MODEL_NOT_FOUND) {
      return ChatErrorCode.NotFound;
    }
  }

  // Then check error.type
  if (errorType) {
    switch (errorType) {
      case OllamaErrorTypes.AUTHENTICATION:
      case OllamaErrorTypes.INVALID_API_KEY:
        return ChatErrorCode.Authentication;
      case OllamaErrorTypes.NOT_FOUND:
        return ChatErrorCode.NotFound;
      case OllamaErrorTypes.SERVER_ERROR:
      case OllamaErrorTypes.SERVICE_UNAVAILABLE:
        return ChatErrorCode.ServerError;
      case OllamaErrorTypes.INVALID_REQUEST:
        return ChatErrorCode.InvalidRequest;
    }
  }

  // Fall back to OpenAI error mapping (since Ollama is OpenAI-compatible)
  return mapOpenAIErrorToCode(statusCode, parsedError);
}

function mapOllamaErrorWrapper(
  statusCode: number | undefined,
  parsedError: ParsedProviderError | null,
): ChatErrorCode {
  return mapOllamaErrorToCode(
    statusCode,
    parsedError as ParsedOpenAIError | null,
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
  cerebras: parseOpenAIError, // Cerebras uses OpenAI-compatible API
  vllm: parseVllmError,
  ollama: parseOllamaError,
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
  cerebras: mapOpenAIErrorWrapper, // Cerebras uses OpenAI-compatible API
  vllm: mapVllmErrorWrapper,
  ollama: mapOllamaErrorWrapper,
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
  logger.debug({ provider }, "[ChatErrorMapper] Mapping provider error");

  // Handle Vercel AI SDK RetryError - extract the lastError and map it
  // RetryError wraps errors from retry attempts and contains the last underlying error
  if (RetryError.isInstance(error)) {
    const retryError = error as InstanceType<typeof RetryError>;
    logger.debug(
      {
        provider,
        reason: retryError.reason,
        errorCount: retryError.errors?.length,
        lastErrorType:
          retryError.lastError instanceof Error
            ? retryError.lastError.name
            : typeof retryError.lastError,
      },
      "[ChatErrorMapper] Unwrapping RetryError to extract lastError",
    );

    // If we have a lastError, recursively map it to get the actual error details
    if (retryError.lastError) {
      const mappedLastError = mapProviderError(retryError.lastError, provider);
      // Preserve the retry context in the message
      const originalMessage =
        mappedLastError.originalError?.message || "Unknown error";
      return {
        ...mappedLastError,
        originalError: mappedLastError.originalError
          ? {
              ...mappedLastError.originalError,
              message: `Failed after ${retryError.errors?.length || "multiple"} attempts. Last error: ${originalMessage}`,
            }
          : undefined,
      };
    }
  }

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
