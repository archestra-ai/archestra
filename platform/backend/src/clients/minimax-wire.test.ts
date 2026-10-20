import { DEFAULT_MODELS, MINIMAX_MODELS } from "@archestra/shared";
import { generateText } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createDirectLLMModel } from "@/clients/llm-client";
import { modelFetchers } from "@/routes/chat/model-fetchers";
import { minimaxAdapterFactory } from "@/routes/proxy/adapters/minimax";
import { ChatCompletionRequestSchema } from "@/types/llm-providers/minimax/api";

const regions = ["https://api.minimax.io/v1", "https://api.minimaxi.com/v1"];
const response = () =>
  Response.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: DEFAULT_MODELS.minimax,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

function captureFetch() {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });
      return response();
    }),
  );
  return requests;
}

describe("MiniMax catalog and serialized requests", () => {
  test("the real static fetcher returns Flash then M3", async () => {
    const models = await modelFetchers.minimax("test-key");
    expect(models.map((model) => model.id)).toEqual(
      MINIMAX_MODELS.map((model) => model.id),
    );
  });

  test.each(
    regions,
  )("SDK default reaches %s with supported Flash fields", async (baseUrl) => {
    const requests = captureFetch();
    const model = createDirectLLMModel({
      provider: "minimax",
      apiKey: "test-key",
      modelName: DEFAULT_MODELS.minimax,
      baseUrl,
    });
    const result = await generateText({
      model,
      prompt: "hello",
      maxRetries: 0,
    });
    expect(result.text).toBe("ok");
    expect(requests[0].url).toBe(`${baseUrl}/chat/completions`);
    expect(requests[0].body).toMatchObject({
      model: "MiniMax-M3.1-Flash",
      thinking: { type: "adaptive" },
      reasoning_effort: "max",
      reasoning_split: true,
    });
    expect(requests[0].body).not.toHaveProperty("service_tier");
  });

  test.each([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "none",
  ] as const)("validated proxy request normalizes Flash effort %s at HTTP boundary", async (effort) => {
    const requests = captureFetch();
    const parsed = ChatCompletionRequestSchema.parse({
      model: DEFAULT_MODELS.minimax,
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "disabled" },
      reasoning_split: false,
      extra_body: { reasoning_effort: effort, thinking: { type: "disabled" } },
    });
    const request = minimaxAdapterFactory
      .createRequestAdapter(parsed)
      .toProviderRequest();
    const client = minimaxAdapterFactory.createClient("test-key", {
      source: "api",
      baseUrl: regions[0],
    });
    await minimaxAdapterFactory.execute(client, request);
    expect(requests[0].body).toMatchObject({
      model: "MiniMax-M3.1-Flash",
      thinking: { type: "adaptive" },
      reasoning_split: true,
      reasoning_effort: effort === "none" ? "max" : effort,
    });
    expect(requests[0].body).not.toHaveProperty("extra_body");
  });

  test("streaming proxy preserves user image content and uses the Flash wire contract", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response("data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          {
            type: "image_url",
            image_url: { url: "https://example.invalid/image.png" },
          },
        ],
      },
    ];
    const request = minimaxAdapterFactory
      .createRequestAdapter(
        ChatCompletionRequestSchema.parse({
          model: DEFAULT_MODELS.minimax,
          messages,
          stream: true,
        }),
      )
      .toProviderRequest();
    const client = minimaxAdapterFactory.createClient("test-key", {
      source: "api",
      baseUrl: regions[1],
    });
    const stream = await minimaxAdapterFactory.executeStream(client, request);
    for await (const _chunk of stream) {
      /* Empty SSE response. */
    }
    expect(body).toMatchObject({
      model: "MiniMax-M3.1-Flash",
      stream: true,
      thinking: { type: "adaptive" },
      reasoning_effort: "max",
      messages,
    });
  });

  test.each([
    "MiniMax-M3",
    "MiniMax-M2.7",
    "custom-deployment",
  ])("SDK preserves explicit model %s", async (modelName) => {
    const requests = captureFetch();
    const model = createDirectLLMModel({
      provider: "minimax",
      apiKey: "test-key",
      modelName,
      baseUrl: regions[0],
    });
    await generateText({ model, prompt: "hello", maxRetries: 0 });
    expect(requests[0].body.model).toBe(modelName);
    expect(requests[0].body).not.toHaveProperty("reasoning_effort");
    if (modelName === "MiniMax-M3")
      expect(requests[0].body.thinking).toEqual({ type: "adaptive" });
    else expect(requests[0].body).not.toHaveProperty("thinking");
  });
});
