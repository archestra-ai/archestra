import { ApiError, ArchestraInternalErrorCode } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import type { Openrouter } from "@/types";
import { openrouterAdapterFactory } from "./openrouter";

function createResponse(
  message: Openrouter.Types.ChatCompletionsResponse["choices"][0]["message"],
): Openrouter.Types.ChatCompletionsResponse {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "openrouter/free-model",
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 0,
      total_tokens: 10,
    },
  };
}

function expectRetryableEmptyResponseError(error: unknown): void {
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).statusCode).toBe(503);
  expect((error as Error).message).toBe(
    "OpenRouter returned an empty response without content or tool calls",
  );
}

describe("OpenrouterResponseAdapter", () => {
  test("rejects empty stop responses as retryable upstream failures", () => {
    const response = createResponse({
      role: "assistant",
      content: null,
      refusal: null,
    });

    let thrown: unknown;
    try {
      openrouterAdapterFactory.createResponseAdapter(response);
    } catch (error) {
      thrown = error;
    }

    expectRetryableEmptyResponseError(thrown);
  });

  test("allows stop responses with text", () => {
    const response = createResponse({
      role: "assistant",
      content: "hello",
      refusal: null,
    });

    const adapter = openrouterAdapterFactory.createResponseAdapter(response);

    expect(adapter.getText()).toBe("hello");
  });
});

describe("OpenrouterStreamAdapter", () => {
  test("rejects empty streamed stop responses before stream end is written", () => {
    const adapter = openrouterAdapterFactory.createStreamAdapter();

    const stopChunk: Openrouter.Types.ChatCompletionChunk = {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "openrouter/free-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };

    let thrown: unknown;
    try {
      adapter.processChunk(stopChunk);
    } catch (error) {
      thrown = error;
    }

    expectRetryableEmptyResponseError(thrown);
  });

  test("allows streamed stop responses after text", () => {
    const adapter = openrouterAdapterFactory.createStreamAdapter();

    adapter.processChunk({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "openrouter/free-model",
      choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
    });

    expect(() =>
      adapter.processChunk({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "openrouter/free-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    ).not.toThrow();
  });
});

describe("extractInternalCode", () => {
  test("classifies the structured context_length_exceeded code", () => {
    const error = { error: { code: "context_length_exceeded" } };
    expect(openrouterAdapterFactory.extractInternalCode(error)).toBe(
      ArchestraInternalErrorCode.ContextLengthExceeded,
    );
  });

  test("leaves an unrelated 400 unclassified", () => {
    const error = { error: { message: "invalid model specified" } };
    expect(openrouterAdapterFactory.extractInternalCode(error)).toBeUndefined();
  });
});
