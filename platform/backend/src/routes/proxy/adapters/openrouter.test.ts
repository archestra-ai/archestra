import { ApiError, ArchestraInternalErrorCode } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import { Openrouter } from "@/types";
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
  // The normalized code lets error reporting drop this known-transient
  // condition and the chat mapper classify it as a retryable empty turn.
  expect((error as ApiError).internalCode).toBe(
    ArchestraInternalErrorCode.UpstreamEmptyResponse,
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

describe("openrouterAdapterFactory.execute", () => {
  function captureRequestClient(): {
    client: unknown;
    requests: Array<Record<string, unknown>>;
  } {
    const requests: Array<Record<string, unknown>> = [];
    const client = {
      chat: {
        completions: {
          create: (request: Record<string, unknown>) => {
            requests.push(request);
            return Promise.resolve(
              createResponse({
                role: "assistant",
                content: "hi",
                refusal: null,
              }),
            );
          },
        },
      },
    };
    return { client, requests };
  }

  function executeWith(
    request: Partial<Openrouter.Types.ChatCompletionsRequest>,
  ) {
    const { client, requests } = captureRequestClient();
    return openrouterAdapterFactory
      .execute(client, request as Openrouter.Types.ChatCompletionsRequest)
      .then(() => requests[0]);
  }

  test("injects the response-healing plugin for non-streaming json requests", async () => {
    const sent = await executeWith({
      model: "openrouter/free-model",
      messages: [],
      response_format: { type: "json_schema" },
    });

    expect(sent.plugins).toEqual([{ id: "response-healing" }]);
    expect(sent.stream).toBe(false);
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

describe("ChatCompletionRequestSchema", () => {
  test("preserves the nested json_schema body so it reaches OpenRouter", () => {
    const responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "out",
        strict: true,
        schema: { type: "object", properties: { a: { type: "string" } } },
      },
    };

    const parsed = Openrouter.API.ChatCompletionRequestSchema.parse({
      model: "openrouter/free-model",
      messages: [],
      response_format: responseFormat,
    });

    expect(parsed.response_format).toEqual(responseFormat);
  });

  test("strips a client-supplied plugins field", () => {
    const parsed = Openrouter.API.ChatCompletionRequestSchema.parse({
      model: "openrouter/free-model",
      messages: [],
      plugins: [{ id: "web" }],
    });

    expect("plugins" in parsed).toBe(false);
  });
});
