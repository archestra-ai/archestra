import type AnthropicProvider from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { anthropicVertexClient } from "@/clients/anthropic-vertex";
import config from "@/config";
import { anthropicAdapterFactory } from "./anthropic";

describe("anthropicAdapterFactory Vertex AI", () => {
  const originalVertexAiConfig = { ...config.llm.anthropic.vertexAi };

  beforeEach(() => {
    config.llm.anthropic.vertexAi.enabled = true;
    config.llm.anthropic.vertexAi.project = "test-project";
    config.llm.anthropic.vertexAi.location = "global";
  });

  afterEach(() => {
    Object.assign(config.llm.anthropic.vertexAi, originalVertexAiConfig);
    vi.restoreAllMocks();
  });

  test("uses server Google auth and sends the Vertex publisher-model shape", async () => {
    vi.spyOn(anthropicVertexClient, "getRequestHeaders").mockResolvedValue(
      new Headers({
        Authorization: "Bearer google-token",
        "x-goog-user-project": "test-project",
      }),
    );
    const upstreamFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));

    const client = anthropicAdapterFactory.createClient("caller-key", {
      defaultHeaders: {},
      source: "api",
    }) as AnthropicProvider & {
      _options?: {
        defaultHeaders?: Record<string, string>;
        fetch?: typeof globalThis.fetch;
      };
    };

    expect(client._options?.defaultHeaders?.Authorization).toBe(
      "Bearer <vertex-ai-managed>",
    );

    await client._options?.fetch?.(
      "https://aiplatform.googleapis.com/v1/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": "caller-key",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 16,
          messages: [{ role: "user", content: "Hello" }],
        }),
      },
    );

    const request = upstreamFetch.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/anthropic/models/claude-sonnet-5:rawPredict",
    );
    expect(request.headers.get("Authorization")).toBe("Bearer google-token");
    expect(request.headers.get("x-api-key")).toBeNull();
    expect(await request.json()).toEqual({
      anthropic_version: "vertex-2023-10-16",
      max_tokens: 16,
      messages: [{ role: "user", content: "Hello" }],
    });
  });

  test("sends a Claude subscription bearer to Anthropic when Vertex is enabled", async () => {
    const upstreamFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
    );
    const client = anthropicAdapterFactory.createClient(
      "Bearer:sk-ant-oat01-test-subscription",
      { baseUrl: "https://custom-upstream.example.test", source: "api" },
    ) as AnthropicProvider;

    await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply OK" }],
    });

    const [input, init] = upstreamFetch.mock.calls[0] ?? [];
    const request = new Request(input, init);
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers.get("authorization")).toBe(
      "Bearer sk-ant-oat01-test-subscription",
    );
    expect(request.headers.get("x-api-key")).toBeNull();
  });
});
