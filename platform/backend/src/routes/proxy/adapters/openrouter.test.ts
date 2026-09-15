import { ApiError, ArchestraInternalErrorCode } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import { OpenAi, Openrouter } from "@/types";
import { openrouterAdapterFactory } from "./openrouter";

describe("openrouterAdapterFactory.createClient", () => {
  test("per-key attribution overrides configured defaults", () => {
    const client = openrouterAdapterFactory.createClient("test-key", {
      baseUrl: "https://openrouter.example/api/v1",
      source: "api",
      defaultHeaders: {
        "X-Custom-Auth": "keep-me",
        "http-referer": "https://caller.example",
        "X-OpenRouter-Title": "Caller",
        "X-Title": "Legacy caller",
        "X-OpenRouter-App-Visibility": "hidden",
      },
    }) as unknown as {
      _options: { defaultHeaders: Record<string, string> };
    };

    expect(client._options.defaultHeaders).toEqual({
      "X-Custom-Auth": "keep-me",
      "http-referer": "https://caller.example",
      "X-OpenRouter-Title": "Caller",
      "X-Title": "Legacy caller",
      "X-OpenRouter-App-Visibility": "hidden",
      "X-OpenRouter-Categories": "general-chat,personal-agent",
    });
  });
});

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
  test.each([
    undefined,
    null,
    "0.0123",
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("ignores unavailable or invalid reported cost %s without rejecting the response", (cost) => {
    const response = createResponse({ role: "assistant", content: "hello" });
    const parsed = Openrouter.API.ChatCompletionResponseSchema.parse({
      ...response,
      usage: { ...response.usage, cost },
    });
    expect(parsed.usage?.cost).toBeUndefined();
    expect(
      openrouterAdapterFactory.createResponseAdapter(parsed).getText(),
    ).toBe("hello");
  });

  test("keeps OpenAI usage schema unchanged", () => {
    const response = createResponse({ role: "assistant", content: "hello" });
    const parsed = OpenAi.API.ChatCompletionResponseSchema.parse({
      ...response,
      usage: { ...response.usage, cost: 0.0123 },
    });
    expect(parsed.usage).not.toHaveProperty("cost");
  });

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

  test("surfaces an error-shaped payload without choices as a typed upstream failure, not a TypeError", () => {
    // OpenRouter can return HTTP 200 with an error body and no `choices`
    // array at all; reading choices[0] off it unguarded crashed with
    // "Cannot read properties of undefined (reading '0')".
    const response = {
      error: { message: "Provider returned error", code: 502 },
    } as unknown as Openrouter.Types.ChatCompletionsResponse;

    let thrown: unknown;
    try {
      openrouterAdapterFactory.createResponseAdapter(response);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).statusCode).toBe(502);
    expect((thrown as Error).message).toBe("Provider returned error");
  });
});

describe("OpenrouterStreamAdapter", () => {
  test("retains the latest valid cost across trailing chunks and a replaced response", () => {
    const adapter = openrouterAdapterFactory.createStreamAdapter();
    const chunk = {
      id: "chatcmpl-test",
      object: "chat.completion.chunk" as const,
      created: 0,
      model: "openai/gpt-4o",
      choices: [],
    };
    for (const cost of [
      0.0123,
      0,
      undefined,
      null,
      "invalid",
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      adapter.processChunk({
        ...chunk,
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          cost,
        },
      } as unknown as Openrouter.Types.ChatCompletionChunk);
    }
    adapter.formatCompleteTextSSE("A policy blocked this tool call.");
    const response = Openrouter.API.ChatCompletionResponseSchema.parse(
      adapter.toProviderResponse(),
    );
    expect(response.usage).toMatchObject({
      cost: 0,
      prompt_tokens: 100,
      completion_tokens: 20,
    });
    expect(response.choices[0].message.content).toBe(
      "A policy blocked this tool call.",
    );
    const finalChunk = JSON.parse(
      String(adapter.formatEndSSE()).split("\n")[0].slice(6),
    );
    expect(finalChunk.usage.cost).toBe(0);
    expect(finalChunk.choices[0].finish_reason).toBe("stop");
    expect(adapter.formatEndSSE()).toMatch(/data: \[DONE\]\n\n$/);
  });

  test("does not invent a reported cost when the stream only has token usage", () => {
    const adapter = openrouterAdapterFactory.createStreamAdapter();
    adapter.processChunk({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "openai/gpt-4o",
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
    expect(adapter.toProviderResponse().usage).not.toHaveProperty("cost");
    const finalChunk = JSON.parse(
      String(adapter.formatEndSSE()).split("\n")[0].slice(6),
    );
    expect(finalChunk.usage).not.toHaveProperty("cost");
  });

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

  test("tolerates a streamed chunk without a choices array", () => {
    const adapter = openrouterAdapterFactory.createStreamAdapter();

    const usageOnlyChunk = {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "openrouter/free-model",
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } as unknown as Openrouter.Types.ChatCompletionChunk;

    expect(() => adapter.processChunk(usageOnlyChunk)).not.toThrow();
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
