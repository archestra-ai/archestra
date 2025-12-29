import {
  AnthropicErrorTypes,
  ChatErrorCode,
  ChatErrorMessages,
  GeminiErrorCodes,
  GeminiErrorReasons,
  OpenAIErrorTypes,
} from "@shared";
import { describe, expect, it } from "vitest";
import { mapProviderError } from "./errors";

// =============================================================================
// OpenAI Error Tests
// =============================================================================

describe("mapProviderError - OpenAI", () => {
  /**
   * Helper to create an APICallError-like object for OpenAI
   */
  function createOpenAIError(
    statusCode: number,
    errorType: string,
    message: string,
    code?: string,
  ) {
    return {
      name: "AI_APICallError",
      statusCode,
      responseBody: JSON.stringify({
        error: {
          type: errorType,
          message,
          code,
        },
      }),
      isRetryable: statusCode >= 500 || statusCode === 429,
    };
  }

  describe("400 - invalid_request_error", () => {
    it("should map to InvalidRequest", () => {
      const error = createOpenAIError(
        400,
        OpenAIErrorTypes.INVALID_REQUEST,
        "Invalid request parameters",
      );
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.InvalidRequest);
      expect(result.isRetryable).toBe(false);
      expect(result.originalError?.provider).toBe("openai");
      expect(result.originalError?.status).toBe(400);
    });
  });

  describe("401 - authentication_error", () => {
    it("should map to Authentication for authentication_error type", () => {
      const error = createOpenAIError(
        401,
        OpenAIErrorTypes.AUTHENTICATION,
        "Invalid authentication credentials",
      );
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.Authentication);
      expect(result.message).toBe(
        ChatErrorMessages[ChatErrorCode.Authentication],
      );
      expect(result.isRetryable).toBe(false);
    });

    it("should map to Authentication for invalid_api_key code", () => {
      const error = createOpenAIError(
        401,
        OpenAIErrorTypes.INVALID_REQUEST,
        "Invalid API key provided",
        OpenAIErrorTypes.INVALID_API_KEY_CODE,
      );
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.Authentication);
    });
  });

  describe("403 - insufficient_quota / permission_denied", () => {
    it("should map to PermissionDenied", () => {
      const error = createOpenAIError(
        403,
        OpenAIErrorTypes.PERMISSION_DENIED,
        "You have insufficient quota for this operation",
      );
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.PermissionDenied);
      expect(result.isRetryable).toBe(false);
    });
  });

  describe("404 - not_found_error", () => {
    it("should map to NotFound", () => {
      const error = createOpenAIError(
        404,
        OpenAIErrorTypes.NOT_FOUND,
        "The model 'gpt-5' does not exist",
      );
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.NotFound);
      expect(result.isRetryable).toBe(false);
    });

    it("should map to NotFound for model_not_found code", () => {
      const error = createOpenAIError(
        404,
        OpenAIErrorTypes.INVALID_REQUEST,
        "The model does not exist",
        OpenAIErrorTypes.MODEL_NOT_FOUND,
      );
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.NotFound);
    });
  });

  describe("409 - conflict_error", () => {
    it("should map to InvalidRequest", () => {
      const error = createOpenAIError(
        409,
        OpenAIErrorTypes.CONFLICT,
        "Conflict with existing resource",
      );
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.InvalidRequest);
      expect(result.isRetryable).toBe(false);
    });
  });

  describe("422 - unprocessable_entity_error", () => {
    it("should map to InvalidRequest", () => {
      const error = createOpenAIError(
        422,
        OpenAIErrorTypes.UNPROCESSABLE_ENTITY,
        "Unable to process the request",
      );
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.InvalidRequest);
      expect(result.isRetryable).toBe(false);
    });
  });

  describe("429 - rate_limit_exceeded", () => {
    it("should map to RateLimit", () => {
      const error = createOpenAIError(
        429,
        OpenAIErrorTypes.RATE_LIMIT,
        "Rate limit exceeded. Please retry after 20 seconds.",
      );
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.RateLimit);
      expect(result.isRetryable).toBe(true);
    });
  });

  describe("500 - server_error", () => {
    it("should map to ServerError", () => {
      const error = createOpenAIError(
        500,
        OpenAIErrorTypes.SERVER_ERROR,
        "Internal server error",
      );
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.ServerError);
      expect(result.isRetryable).toBe(true);
    });
  });

  describe("503 - service_unavailable", () => {
    it("should map to ServerError", () => {
      const error = createOpenAIError(
        503,
        OpenAIErrorTypes.SERVICE_UNAVAILABLE,
        "Service temporarily unavailable",
      );
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.ServerError);
      expect(result.isRetryable).toBe(true);
    });
  });

  describe("context_length_exceeded", () => {
    it("should map to ContextTooLong for context_length_exceeded code", () => {
      const error = createOpenAIError(
        400,
        OpenAIErrorTypes.INVALID_REQUEST,
        "This model's maximum context length is 8192 tokens",
        OpenAIErrorTypes.CONTEXT_LENGTH_EXCEEDED,
      );
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.ContextTooLong);
      expect(result.isRetryable).toBe(false);
    });
  });

  describe("connection timeout", () => {
    it("should map to Unknown when no status code and no responseBody", () => {
      const error = {
        name: "AI_APIConnectionError",
        message: "Connection timeout after 30000ms",
      };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.Unknown);
    });
  });
});

// =============================================================================
// Anthropic Error Tests
// =============================================================================

describe("mapProviderError - Anthropic", () => {
  /**
   * Helper to create an APICallError-like object for Anthropic
   */
  function createAnthropicError(
    statusCode: number,
    errorType: string,
    message: string,
  ) {
    return {
      name: "AI_APICallError",
      statusCode,
      responseBody: JSON.stringify({
        error: {
          type: errorType,
          message,
        },
      }),
      isRetryable:
        statusCode >= 500 || statusCode === 429 || statusCode === 529,
    };
  }

  describe("400 - invalid_request_error", () => {
    it("should map to InvalidRequest", () => {
      const error = createAnthropicError(
        400,
        AnthropicErrorTypes.INVALID_REQUEST,
        "Invalid request body",
      );
      const result = mapProviderError(error, "anthropic");

      expect(result.code).toBe(ChatErrorCode.InvalidRequest);
      expect(result.isRetryable).toBe(false);
      expect(result.originalError?.provider).toBe("anthropic");
    });
  });

  describe("401 - authentication_error", () => {
    it("should map to Authentication", () => {
      const error = createAnthropicError(
        401,
        AnthropicErrorTypes.AUTHENTICATION,
        "Invalid API key",
      );
      const result = mapProviderError(error, "anthropic");

      expect(result.code).toBe(ChatErrorCode.Authentication);
      expect(result.message).toBe(
        ChatErrorMessages[ChatErrorCode.Authentication],
      );
      expect(result.isRetryable).toBe(false);
    });
  });

  describe("403 - permission_error", () => {
    it("should map to PermissionDenied", () => {
      const error = createAnthropicError(
        403,
        AnthropicErrorTypes.PERMISSION,
        "API key does not have access to this resource",
      );
      const result = mapProviderError(error, "anthropic");

      expect(result.code).toBe(ChatErrorCode.PermissionDenied);
      expect(result.isRetryable).toBe(false);
    });
  });

  describe("404 - not_found_error", () => {
    it("should map to NotFound", () => {
      const error = createAnthropicError(
        404,
        AnthropicErrorTypes.NOT_FOUND,
        "Model not found",
      );
      const result = mapProviderError(error, "anthropic");

      expect(result.code).toBe(ChatErrorCode.NotFound);
      expect(result.isRetryable).toBe(false);
    });
  });

  describe("413 - request_too_large", () => {
    it("should map to ContextTooLong", () => {
      const error = createAnthropicError(
        413,
        AnthropicErrorTypes.REQUEST_TOO_LARGE,
        "Request exceeds the maximum allowed size",
      );
      const result = mapProviderError(error, "anthropic");

      expect(result.code).toBe(ChatErrorCode.ContextTooLong);
      expect(result.isRetryable).toBe(false);
    });
  });

  describe("429 - rate_limit_error", () => {
    it("should map to RateLimit", () => {
      const error = createAnthropicError(
        429,
        AnthropicErrorTypes.RATE_LIMIT,
        "Rate limit exceeded",
      );
      const result = mapProviderError(error, "anthropic");

      expect(result.code).toBe(ChatErrorCode.RateLimit);
      expect(result.isRetryable).toBe(true);
    });
  });

  describe("500 - api_error", () => {
    it("should map to ServerError", () => {
      const error = createAnthropicError(
        500,
        AnthropicErrorTypes.API_ERROR,
        "Internal server error",
      );
      const result = mapProviderError(error, "anthropic");

      expect(result.code).toBe(ChatErrorCode.ServerError);
      expect(result.isRetryable).toBe(true);
    });
  });

  describe("529 - overloaded_error", () => {
    it("should map to ServerError", () => {
      const error = createAnthropicError(
        529,
        AnthropicErrorTypes.OVERLOADED,
        "API is temporarily overloaded",
      );
      const result = mapProviderError(error, "anthropic");

      expect(result.code).toBe(ChatErrorCode.ServerError);
      expect(result.isRetryable).toBe(true);
    });

    it("should map 529 to ServerError even without error type", () => {
      const error = {
        name: "AI_APICallError",
        statusCode: 529,
        responseBody: JSON.stringify({ error: { message: "Overloaded" } }),
      };
      const result = mapProviderError(error, "anthropic");

      expect(result.code).toBe(ChatErrorCode.ServerError);
    });
  });
});

// =============================================================================
// Gemini Error Tests (Google AI Studio)
// =============================================================================

describe("mapProviderError - Gemini (Google AI Studio)", () => {
  /**
   * Helper to create an APICallError-like object for Gemini
   */
  function createGeminiError(
    statusCode: number,
    grpcStatus: string,
    message: string,
  ) {
    return {
      name: "AI_APICallError",
      statusCode,
      responseBody: JSON.stringify({
        error: {
          code: statusCode,
          status: grpcStatus,
          message,
        },
      }),
      isRetryable: statusCode >= 500 || statusCode === 429,
    };
  }

  describe("400 - INVALID_ARGUMENT", () => {
    it("should map to InvalidRequest", () => {
      const error = createGeminiError(
        400,
        GeminiErrorCodes.INVALID_ARGUMENT,
        "Invalid argument",
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.InvalidRequest);
      expect(result.isRetryable).toBe(false);
      expect(result.originalError?.provider).toBe("gemini");
    });
  });

  describe("401 - UNAUTHENTICATED", () => {
    it("should map to Authentication", () => {
      const error = createGeminiError(
        401,
        GeminiErrorCodes.UNAUTHENTICATED,
        "API key not valid. Please pass a valid API key.",
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.Authentication);
      expect(result.message).toBe(
        ChatErrorMessages[ChatErrorCode.Authentication],
      );
      expect(result.isRetryable).toBe(false);
    });
  });

  describe("403 - PERMISSION_DENIED", () => {
    it("should map to PermissionDenied", () => {
      const error = createGeminiError(
        403,
        GeminiErrorCodes.PERMISSION_DENIED,
        "Permission denied for this resource",
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.PermissionDenied);
      expect(result.isRetryable).toBe(false);
    });
  });

  describe("404 - NOT_FOUND", () => {
    it("should map to NotFound", () => {
      const error = createGeminiError(
        404,
        GeminiErrorCodes.NOT_FOUND,
        "Model not found",
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.NotFound);
      expect(result.isRetryable).toBe(false);
    });
  });

  describe("429 - RESOURCE_EXHAUSTED", () => {
    it("should map to RateLimit", () => {
      const error = createGeminiError(
        429,
        GeminiErrorCodes.RESOURCE_EXHAUSTED,
        "Quota exceeded",
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.RateLimit);
      expect(result.isRetryable).toBe(true);
    });
  });

  describe("500 - INTERNAL", () => {
    it("should map to ServerError", () => {
      const error = createGeminiError(
        500,
        GeminiErrorCodes.INTERNAL,
        "Internal server error",
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.ServerError);
      expect(result.isRetryable).toBe(true);
    });
  });

  describe("503 - UNAVAILABLE", () => {
    it("should map to ServerError", () => {
      const error = createGeminiError(
        503,
        GeminiErrorCodes.UNAVAILABLE,
        "Service unavailable",
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.ServerError);
      expect(result.isRetryable).toBe(true);
    });
  });
});

// =============================================================================
// Gemini Error Tests (Vertex AI)
// =============================================================================

describe("mapProviderError - Gemini (Vertex AI)", () => {
  /**
   * Helper to create an APICallError-like object for Vertex AI
   * Vertex AI errors have the same structure as Google AI Studio
   */
  function createVertexAIError(
    statusCode: number,
    grpcStatus: string,
    message: string,
  ) {
    return {
      name: "AI_APICallError",
      url: "https://us-central1-aiplatform.googleapis.com/v1/projects/...",
      statusCode,
      responseBody: JSON.stringify({
        error: {
          code: statusCode,
          status: grpcStatus,
          message,
        },
      }),
      isRetryable: statusCode >= 500 || statusCode === 429,
    };
  }

  describe("401 - UNAUTHENTICATED (OAuth token)", () => {
    it("should map to Authentication for invalid OAuth token", () => {
      const error = createVertexAIError(
        401,
        GeminiErrorCodes.UNAUTHENTICATED,
        "Request had invalid authentication credentials",
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.Authentication);
      expect(result.originalError?.message).toContain("invalid authentication");
    });
  });

  describe("403 - PERMISSION_DENIED (IAM)", () => {
    it("should map to PermissionDenied for IAM permission issues", () => {
      const error = createVertexAIError(
        403,
        GeminiErrorCodes.PERMISSION_DENIED,
        "Permission denied on resource project",
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.PermissionDenied);
    });
  });

  describe("429 - RESOURCE_EXHAUSTED (quota)", () => {
    it("should map to RateLimit for quota exceeded", () => {
      const error = createVertexAIError(
        429,
        GeminiErrorCodes.RESOURCE_EXHAUSTED,
        "Quota exceeded for aiplatform.googleapis.com",
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.RateLimit);
      expect(result.isRetryable).toBe(true);
    });
  });

  describe("500 - INTERNAL", () => {
    it("should map to ServerError", () => {
      const error = createVertexAIError(
        500,
        GeminiErrorCodes.INTERNAL,
        "Internal error encountered",
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.ServerError);
      expect(result.isRetryable).toBe(true);
    });
  });

  describe("503 - UNAVAILABLE", () => {
    it("should map to ServerError", () => {
      const error = createVertexAIError(
        503,
        GeminiErrorCodes.UNAVAILABLE,
        "The service is currently unavailable",
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.ServerError);
      expect(result.isRetryable).toBe(true);
    });
  });

  describe("DEADLINE_EXCEEDED", () => {
    it("should map to ServerError", () => {
      const error = createVertexAIError(
        504,
        GeminiErrorCodes.DEADLINE_EXCEEDED,
        "Deadline exceeded while waiting for response",
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.ServerError);
    });
  });
});

// =============================================================================
// Gemini ErrorInfo Reason Tests (google.rpc.ErrorInfo)
// =============================================================================

describe("mapProviderError - Gemini ErrorInfo reasons", () => {
  /**
   * Helper to create a Gemini error with ErrorInfo in the details array
   * @see https://googleapis.dev/nodejs/spanner/latest/google.rpc.ErrorInfo.html
   */
  function createGeminiErrorWithDetails(
    statusCode: number,
    grpcStatus: string,
    message: string,
    reason: string,
    domain = "googleapis.com",
  ) {
    return {
      name: "AI_APICallError",
      statusCode,
      responseBody: JSON.stringify({
        error: {
          code: statusCode,
          status: grpcStatus,
          message,
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason,
              domain,
              metadata: {
                service: "generativelanguage.googleapis.com",
              },
            },
            {
              "@type": "type.googleapis.com/google.rpc.LocalizedMessage",
              locale: "en-US",
              message,
            },
          ],
        },
      }),
      isRetryable: statusCode >= 500 || statusCode === 429,
    };
  }

  describe("Authentication errors via ErrorInfo reason", () => {
    it("should map API_KEY_INVALID to Authentication (even with INVALID_ARGUMENT status)", () => {
      // This is the real-world case: status is INVALID_ARGUMENT but reason tells us it's an API key issue
      const error = createGeminiErrorWithDetails(
        400,
        GeminiErrorCodes.INVALID_ARGUMENT,
        "API key not valid. Please pass a valid API key.",
        GeminiErrorReasons.API_KEY_INVALID,
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.Authentication);
      expect(result.message).toBe(
        ChatErrorMessages[ChatErrorCode.Authentication],
      );
    });

    it("should map API_KEY_NOT_FOUND to Authentication", () => {
      const error = createGeminiErrorWithDetails(
        400,
        GeminiErrorCodes.INVALID_ARGUMENT,
        "API key not found",
        GeminiErrorReasons.API_KEY_NOT_FOUND,
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.Authentication);
    });

    it("should map API_KEY_EXPIRED to Authentication", () => {
      const error = createGeminiErrorWithDetails(
        401,
        GeminiErrorCodes.UNAUTHENTICATED,
        "API key has expired",
        GeminiErrorReasons.API_KEY_EXPIRED,
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.Authentication);
    });

    it("should map ACCESS_TOKEN_EXPIRED to Authentication", () => {
      const error = createGeminiErrorWithDetails(
        401,
        GeminiErrorCodes.UNAUTHENTICATED,
        "Access token expired",
        GeminiErrorReasons.ACCESS_TOKEN_EXPIRED,
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.Authentication);
    });

    it("should map ACCESS_TOKEN_INVALID to Authentication", () => {
      const error = createGeminiErrorWithDetails(
        401,
        GeminiErrorCodes.UNAUTHENTICATED,
        "Invalid access token",
        GeminiErrorReasons.ACCESS_TOKEN_INVALID,
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.Authentication);
    });
  });

  describe("Rate limit errors via ErrorInfo reason", () => {
    it("should map RATE_LIMIT_EXCEEDED to RateLimit", () => {
      const error = createGeminiErrorWithDetails(
        429,
        GeminiErrorCodes.RESOURCE_EXHAUSTED,
        "Rate limit exceeded",
        GeminiErrorReasons.RATE_LIMIT_EXCEEDED,
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.RateLimit);
      expect(result.isRetryable).toBe(true);
    });

    it("should map QUOTA_EXCEEDED to RateLimit", () => {
      const error = createGeminiErrorWithDetails(
        429,
        GeminiErrorCodes.RESOURCE_EXHAUSTED,
        "Quota exceeded",
        GeminiErrorReasons.QUOTA_EXCEEDED,
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.RateLimit);
    });
  });

  describe("Not found errors via ErrorInfo reason", () => {
    it("should map MODEL_NOT_FOUND to NotFound", () => {
      const error = createGeminiErrorWithDetails(
        404,
        GeminiErrorCodes.NOT_FOUND,
        "Model not found",
        GeminiErrorReasons.MODEL_NOT_FOUND,
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.NotFound);
    });
  });

  describe("Content filtering errors via ErrorInfo reason", () => {
    it("should map SAFETY_BLOCKED to ContentFiltered", () => {
      const error = createGeminiErrorWithDetails(
        400,
        GeminiErrorCodes.INVALID_ARGUMENT,
        "Content blocked due to safety concerns",
        GeminiErrorReasons.SAFETY_BLOCKED,
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.ContentFiltered);
    });

    it("should map RECITATION_BLOCKED to ContentFiltered", () => {
      const error = createGeminiErrorWithDetails(
        400,
        GeminiErrorCodes.INVALID_ARGUMENT,
        "Content blocked due to potential recitation",
        GeminiErrorReasons.RECITATION_BLOCKED,
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.ContentFiltered);
    });
  });

  describe("Context length errors via ErrorInfo reason", () => {
    it("should map CONTEXT_LENGTH_EXCEEDED to ContextTooLong", () => {
      const error = createGeminiErrorWithDetails(
        400,
        GeminiErrorCodes.INVALID_ARGUMENT,
        "Request exceeds maximum context length",
        GeminiErrorReasons.CONTEXT_LENGTH_EXCEEDED,
      );
      const result = mapProviderError(error, "gemini");

      expect(result.code).toBe(ChatErrorCode.ContextTooLong);
    });
  });

  describe("Real-world deeply nested error with ErrorInfo", () => {
    it("should extract ErrorInfo from deeply nested JSON and map correctly", () => {
      // This is a real-world error structure captured from the chat UI
      const deeplyNestedWithDetails = {
        name: "AI_APICallError",
        url: "http://localhost:9000/v1/gemini/xxx/v1beta/models/gemini-2.5-pro:streamGenerateContent",
        statusCode: 400,
        responseBody: JSON.stringify({
          error: {
            message: JSON.stringify({
              error: {
                message: JSON.stringify({
                  error: {
                    code: 400,
                    message: "API key not valid. Please pass a valid API key.",
                    status: "INVALID_ARGUMENT",
                    details: [
                      {
                        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                        reason: "API_KEY_INVALID",
                        domain: "googleapis.com",
                        metadata: {
                          service: "generativelanguage.googleapis.com",
                        },
                      },
                    ],
                  },
                }),
                code: 400,
                status: "Bad Request",
              },
            }),
            type: "api_validation_error",
          },
        }),
        isRetryable: false,
      };

      const result = mapProviderError(deeplyNestedWithDetails, "gemini");

      // With ErrorInfo extraction, this should now map to Authentication, not InvalidRequest
      expect(result.code).toBe(ChatErrorCode.Authentication);
      expect(result.originalError?.message).toContain("API key not valid");
    });
  });
});

// =============================================================================
// Nested JSON Parsing Tests (Real-world Gemini errors)
// =============================================================================

describe("mapProviderError - Nested JSON parsing", () => {
  describe("deeply nested Gemini error (real-world example)", () => {
    // Real error captured from Gemini with invalid API key - 4+ levels of nesting
    const deeplyNestedError = {
      name: "AI_APICallError",
      url: "http://localhost:9000/v1/gemini/xxx/v1beta/models/gemini-2.5-pro:streamGenerateContent",
      statusCode: 400,
      responseBody:
        '{"error":{"message":"{\\"error\\":{\\"message\\":\\"{\\\\\\"error\\\\\\": {\\\\\\"code\\\\\\": 400, \\\\\\"message\\\\\\": \\\\\\"API key not valid. Please pass a valid API key.\\\\\\", \\\\\\"status\\\\\\": \\\\\\"INVALID_ARGUMENT\\\\\\"}}\\",\\"code\\":400,\\"status\\":\\"Bad Request\\"}}","type":"api_validation_error"}}',
      isRetryable: false,
    };

    it("should parse deeply nested JSON and extract meaningful message", () => {
      const result = mapProviderError(deeplyNestedError, "gemini");

      // The status should be extracted from the innermost error
      expect(result.originalError?.message).toContain("API key not valid");
    });

    it("should map based on extracted status", () => {
      const result = mapProviderError(deeplyNestedError, "gemini");

      // Even though outer status is 400, the inner status is INVALID_ARGUMENT
      // which maps to InvalidRequest
      expect(result.code).toBe(ChatErrorCode.InvalidRequest);
    });
  });

  describe("moderately nested Gemini error", () => {
    const nestedError = {
      name: "AI_APICallError",
      statusCode: 400,
      responseBody:
        '{"error":{"message":"{\\"error\\":{\\"message\\":\\"API key not valid. Please pass a valid API key.\\",\\"code\\":400,\\"status\\":\\"Bad Request\\"}}","type":"api_validation_error"}}',
      isRetryable: false,
    };

    it("should extract message from nested structure", () => {
      const result = mapProviderError(nestedError, "gemini");

      expect(result.originalError?.message).toContain("API key not valid");
    });
  });
});

// =============================================================================
// Circular Reference Handling Tests
// =============================================================================

describe("mapProviderError - Circular reference handling", () => {
  it("should safely serialize errors with circular references", () => {
    const circularError: Record<string, unknown> = {
      message: "Error with circular reference",
      statusCode: 500,
    };
    circularError.self = circularError;

    const result = mapProviderError(circularError, "openai");

    expect(result.code).toBe(ChatErrorCode.ServerError);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("should safely serialize Error objects with cause chains", () => {
    const rootCause = new Error("Root cause");
    const middleError = new Error("Middle error", { cause: rootCause });
    const topError = new Error("Top level error", { cause: middleError });

    const result = mapProviderError(topError, "anthropic");

    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("should handle deeply nested circular references", () => {
    const obj: Record<string, unknown> = {
      message: "Nested circular",
      level1: {
        level2: {
          level3: {},
        },
      },
    };
    (obj.level1 as Record<string, unknown>).level2 = { level3: obj };

    const result = mapProviderError(obj, "gemini");

    expect(() => JSON.stringify(result)).not.toThrow();
  });
});

// =============================================================================
// Fallback Behavior Tests
// =============================================================================

describe("mapProviderError - Fallback behavior", () => {
  it("should map by status code when error type is missing", () => {
    const error = {
      statusCode: 429,
      responseBody: JSON.stringify({ error: { message: "Rate limited" } }),
    };
    const result = mapProviderError(error, "openai");

    expect(result.code).toBe(ChatErrorCode.RateLimit);
  });

  it("should return Unknown for unrecognized errors without status", () => {
    const error = {
      message: "Something unexpected happened",
    };
    const result = mapProviderError(error, "anthropic");

    expect(result.code).toBe(ChatErrorCode.Unknown);
    expect(result.isRetryable).toBe(false);
  });

  it("should handle plain Error instances", () => {
    const error = new Error("Standard error message");
    const result = mapProviderError(error, "gemini");

    expect(result.originalError?.message).toBe("Standard error message");
  });

  it("should handle string errors", () => {
    const result = mapProviderError("Simple string error", "openai");

    expect(result.originalError?.message).toBe("Simple string error");
  });
});

// =============================================================================
// Provider Preservation Tests
// =============================================================================

describe("mapProviderError - Provider preservation", () => {
  it("should preserve openai provider", () => {
    const error = { statusCode: 500, message: "Error" };
    const result = mapProviderError(error, "openai");

    expect(result.originalError?.provider).toBe("openai");
  });

  it("should preserve anthropic provider", () => {
    const error = { statusCode: 500, message: "Error" };
    const result = mapProviderError(error, "anthropic");

    expect(result.originalError?.provider).toBe("anthropic");
  });

  it("should preserve gemini provider", () => {
    const error = { statusCode: 500, message: "Error" };
    const result = mapProviderError(error, "gemini");

    expect(result.originalError?.provider).toBe("gemini");
  });
});
