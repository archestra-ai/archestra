import type AnthropicProvider from "@anthropic-ai/sdk";
import { afterEach, describe, expect, test, vi } from "vitest";
import config from "@/config";
import { anthropicAdapterFactory } from "./anthropic";

describe("Anthropic bearer credentials", () => {
  const originalVertexEnabled = config.llm.anthropic.vertexAi.enabled;

  afterEach(() => {
    config.llm.anthropic.vertexAi.enabled = originalVertexEnabled;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("does not add an ambient API key to an explicit bearer request", async () => {
    config.llm.anthropic.vertexAi.enabled = false;
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-ambient-api-key");
    const upstreamFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        id: "msg_fixture",
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
      "Bearer:sk-ant-oat01-fixture-subscription",
      { baseUrl: "https://api.anthropic.com", source: "api" },
    ) as AnthropicProvider;

    await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply OK" }],
    });

    const [input, init] = upstreamFetch.mock.calls[0] ?? [];
    const request = new Request(input, init);
    expect(request.headers.get("authorization")).toBe(
      "Bearer sk-ant-oat01-fixture-subscription",
    );
    expect(request.headers.get("x-api-key")).toBeNull();
  });
});
