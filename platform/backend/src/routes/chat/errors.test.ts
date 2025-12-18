import { ChatErrorCode, ChatErrorMessages } from "@shared";
import { describe, expect, it } from "vitest";
import { mapProviderError } from "./errors";

describe("mapProviderError", () => {
  describe("AI_APICallError with deeply nested invalid API key error (Gemini 400)", () => {
    // Real error captured from Gemini with invalid API key - VERY deeply nested JSON (4+ levels)
    // This is the exact error structure from the UI
    const geminiDeeplyNestedError = {
      name: "AI_APICallError",
      url: "http://localhost:9000/v1/gemini/2990c615-09c8-402e-9ca2-371d7a95ecbc/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
      statusCode: 400,
      responseBody:
        '{"error":{"message":"{\\"error\\":{\\"message\\":\\"{\\\\\\"error\\\\\\": {\\\\\\"code\\\\\\": 400, \\\\\\"message\\\\\\": \\\\\\"API key not valid. Please pass a valid API key.\\\\\\", \\\\\\"status\\\\\\": \\\\\\"INVALID_ARGUMENT\\\\\\"}}\\",\\"code\\":400,\\"status\\":\\"Bad Request\\"}}","type":"api_validation_error"}}',
      isRetryable: false,
    };

    it("should map to authentication error for deeply nested API key message", () => {
      const result = mapProviderError(geminiDeeplyNestedError, "gemini");

      // Even though status is 400, the message indicates authentication issue
      expect(result.code).toBe(ChatErrorCode.Authentication);
      expect(result.message).toBe(
        ChatErrorMessages[ChatErrorCode.Authentication],
      );
      expect(result.isRetryable).toBe(false);
    });

    it("should include provider in response", () => {
      const result = mapProviderError(geminiDeeplyNestedError, "gemini");

      expect(result.originalError?.provider).toBe("gemini");
    });
  });

  describe("AI_APICallError with invalid API key (Gemini 400)", () => {
    // Real error captured from Gemini with invalid API key - moderately nested JSON
    const geminiInvalidApiKeyError = {
      name: "AI_APICallError",
      url: "http://localhost:9000/v1/gemini/2990c615-09c8-402e-9ca2-371d7a95ecbc/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
      requestBodyValues: {
        generationConfig: {},
        contents: [{ role: "user", parts: [{ text: "hiiii" }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: "internal-dev-test-server__print_archestra_test",
                description:
                  "Prints the ARCHESTRA_TEST environment variable value",
              },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      },
      statusCode: 400,
      responseHeaders: {
        "access-control-allow-credentials": "true",
        "content-type": "application/json; charset=utf-8",
      },
      responseBody:
        '{"error":{"message":"{\\"error\\":{\\"message\\":\\"API key not valid. Please pass a valid API key.\\",\\"code\\":400,\\"status\\":\\"Bad Request\\"}}","type":"api_validation_error"}}',
      isRetryable: false,
    };

    it("should map to authentication error for invalid API key message", () => {
      const result = mapProviderError(geminiInvalidApiKeyError, "gemini");

      // Even though status is 400, the message indicates authentication issue
      expect(result.code).toBe(ChatErrorCode.Authentication);
      expect(result.message).toBe(
        ChatErrorMessages[ChatErrorCode.Authentication],
      );
      expect(result.isRetryable).toBe(false);
    });

    it("should include provider in response", () => {
      const result = mapProviderError(geminiInvalidApiKeyError, "gemini");

      expect(result.originalError?.provider).toBe("gemini");
    });

    it("should extract a clean user-friendly message, not the raw nested JSON", () => {
      const result = mapProviderError(geminiInvalidApiKeyError, "gemini");

      // The message should NOT contain escaped JSON
      expect(result.message).not.toContain('\\"');
      expect(result.message).not.toContain("\\n");
      // Should be the user-friendly mapped message for authentication errors
      expect(result.message).toBe(
        "Invalid API key. Please check your Chat Settings.",
      );
    });
  });

  describe("AI_RetryError with nested AI_APICallError (Gemini)", () => {
    // Real error captured from Gemini with invalid API key
    const geminiRetryError = {
      name: "AI_RetryError",
      reason: "maxRetriesExceeded",
      errors: [
        {
          name: "AI_APICallError",
          url: "http://localhost:9000/v1/gemini/2990c615-09c8-402e-9ca2-371d7a95ecbc/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
          requestBodyValues: {
            generationConfig: {},
            contents: [{ role: "user", parts: [{ text: "hiiii" }] }],
            tools: [],
            toolConfig: { functionCallingConfig: { mode: "AUTO" } },
          },
          statusCode: 500,
          responseHeaders: {
            "access-control-allow-credentials": "true",
            "content-type": "application/json; charset=utf-8",
          },
          responseBody:
            '{"error":{"message":"Response doesn\'t match the schema","type":"api_internal_server_error"}}',
          isRetryable: true,
        },
      ],
      lastError: {
        name: "AI_APICallError",
        url: "http://localhost:9000/v1/gemini/2990c615-09c8-402e-9ca2-371d7a95ecbc/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
        statusCode: 500,
        responseBody:
          '{"error":{"message":"Response doesn\'t match the schema","type":"api_internal_server_error"}}',
        isRetryable: true,
      },
    };

    it("should map to server_error for 500 status code", () => {
      const result = mapProviderError(geminiRetryError, "gemini");

      expect(result.code).toBe(ChatErrorCode.ServerError);
      expect(result.message).toBe(ChatErrorMessages[ChatErrorCode.ServerError]);
      expect(result.isRetryable).toBe(true);
    });

    it("should include provider in response", () => {
      const result = mapProviderError(geminiRetryError, "gemini");

      expect(result.originalError?.provider).toBe("gemini");
    });

    it("should preserve the original error details", () => {
      const result = mapProviderError(geminiRetryError, "gemini");

      expect(result.originalError).toBeDefined();
      expect(result.originalError?.raw).toEqual(geminiRetryError);
    });
  });

  describe("status code mapping", () => {
    it("should map 400 to InvalidRequest", () => {
      const error = { statusCode: 400, message: "Bad request" };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.InvalidRequest);
      expect(result.isRetryable).toBe(false);
    });

    it("should map 401 to Authentication", () => {
      const error = { statusCode: 401, message: "Unauthorized" };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.Authentication);
      expect(result.isRetryable).toBe(false);
    });

    it("should map 403 to PermissionDenied", () => {
      const error = { statusCode: 403, message: "Forbidden" };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.PermissionDenied);
      expect(result.isRetryable).toBe(false);
    });

    it("should map 404 to NotFound", () => {
      const error = { statusCode: 404, message: "Not found" };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.NotFound);
      expect(result.isRetryable).toBe(false);
    });

    it("should map 429 to RateLimit", () => {
      const error = { statusCode: 429, message: "Too many requests" };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.RateLimit);
      expect(result.isRetryable).toBe(true);
    });

    it("should map 500 to ServerError", () => {
      const error = { statusCode: 500, message: "Internal server error" };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.ServerError);
      expect(result.isRetryable).toBe(true);
    });

    it("should map 503 to ServerError", () => {
      const error = { statusCode: 503, message: "Service unavailable" };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.ServerError);
      expect(result.isRetryable).toBe(true);
    });
  });

  describe("context length detection", () => {
    it("should detect context length errors from message", () => {
      const error = {
        statusCode: 400,
        message: "This request exceeds the maximum context length",
      };
      const result = mapProviderError(error, "anthropic");

      expect(result.code).toBe(ChatErrorCode.ContextTooLong);
    });

    it("should detect token limit errors", () => {
      const error = {
        statusCode: 400,
        message: "Maximum token limit exceeded",
      };
      const result = mapProviderError(error, "anthropic");

      expect(result.code).toBe(ChatErrorCode.ContextTooLong);
    });

    it("should detect input too long errors", () => {
      const error = {
        statusCode: 400,
        message: "Input is too long for this model",
      };
      const result = mapProviderError(error, "anthropic");

      expect(result.code).toBe(ChatErrorCode.ContextTooLong);
    });
  });

  describe("content filter detection", () => {
    it("should detect content filter errors", () => {
      const error = {
        statusCode: 400,
        message: "Content was blocked by safety filters",
      };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.ContentFiltered);
    });

    it("should detect safety violation errors", () => {
      const error = {
        statusCode: 400,
        message: "Safety violation detected in the request",
      };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.ContentFiltered);
    });

    it("should detect moderation errors", () => {
      const error = {
        statusCode: 400,
        message: "Request failed moderation check",
      };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.ContentFiltered);
    });
  });

  describe("provider parameter", () => {
    it("should include anthropic provider in response", () => {
      const error = { statusCode: 500, message: "Server error" };
      const result = mapProviderError(error, "anthropic");

      expect(result.originalError?.provider).toBe("anthropic");
    });

    it("should include openai provider in response", () => {
      const error = { statusCode: 500, message: "Server error" };
      const result = mapProviderError(error, "openai");

      expect(result.originalError?.provider).toBe("openai");
    });

    it("should include gemini provider in response", () => {
      const error = { statusCode: 500, message: "Server error" };
      const result = mapProviderError(error, "gemini");

      expect(result.originalError?.provider).toBe("gemini");
    });
  });

  describe("error type mapping", () => {
    it("should map rate_limit type to RateLimit", () => {
      const error = {
        type: "rate_limit_exceeded",
        message: "Too many requests",
      };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.RateLimit);
    });

    it("should map authentication type to Authentication", () => {
      const error = {
        type: "authentication_error",
        message: "Invalid API key",
      };
      const result = mapProviderError(error, "anthropic");

      expect(result.code).toBe(ChatErrorCode.Authentication);
    });

    it("should map invalid_api_key type to Authentication", () => {
      const error = {
        type: "invalid_api_key",
        message: "The API key is invalid",
      };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.Authentication);
    });
  });

  describe("network error detection", () => {
    it("should detect network errors from message", () => {
      const error = {
        message: "Network error occurred",
      };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.NetworkError);
      expect(result.isRetryable).toBe(true);
    });

    it("should detect ECONNREFUSED errors", () => {
      const error = {
        message: "connect ECONNREFUSED 127.0.0.1:443",
      };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.NetworkError);
    });

    it("should detect timeout errors", () => {
      const error = {
        message: "Request timeout after 30000ms",
      };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.NetworkError);
    });
  });

  describe("fallback behavior", () => {
    it("should return Unknown for unrecognized errors", () => {
      const error = {
        message: "Something unexpected happened",
      };
      const result = mapProviderError(error, "openai");

      expect(result.code).toBe(ChatErrorCode.Unknown);
      expect(result.isRetryable).toBe(false);
    });

    it("should handle Error instances", () => {
      const error = new Error("Standard error message");
      const result = mapProviderError(error, "anthropic");

      expect(result.originalError?.message).toBe("Standard error message");
    });

    it("should handle string errors", () => {
      const result = mapProviderError("Simple string error", "gemini");

      expect(result.originalError?.message).toBe("Simple string error");
    });
  });
});
