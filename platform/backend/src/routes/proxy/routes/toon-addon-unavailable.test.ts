// Pins the addon-unavailable contract at the handler level: when TOON
// compression is enabled but the native proxy-transform addon cannot be
// loaded, the proxy fails open (request still succeeds, uncompressed) and the
// persisted interaction records toonSkipReason = "addon_unavailable" — never
// not_effective/no_tool_results fabricated from stats that were never computed.

import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { InteractionModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { openaiAdapterFactory } from "../adapters/openai";
import * as proxyUtils from "../utils";
import { toonEncodeToolResults } from "../utils/toon-native";
import openAiProxyRoutes from "./openai";

// The native addon is unavailable: the helper fails open by resolving to null.
vi.mock("@/routes/proxy/utils/toon-native", () => ({
  toonEncodeToolResults: vi.fn(),
  initToonNative: vi.fn(),
}));

describe("LLM proxy with the TOON addon unavailable", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.mocked(toonEncodeToolResults).mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) {
      await app.close();
    }
  });

  test("persists toonSkipReason = addon_unavailable when compression is enabled", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "TOON addon unavailable" });

    vi.spyOn(
      proxyUtils.toonConversion,
      "shouldApplyToonCompression",
    ).mockResolvedValue(true);

    const upstreamRequests: unknown[] = [];
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          chat: {
            completions: {
              create: async (request: unknown) => {
                upstreamRequests.push(request);
                return {
                  id: "chatcmpl_nonstream",
                  object: "chat.completion",
                  created: 1,
                  model: "gpt-4o",
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: "assistant",
                        content: "Mocked response",
                        refusal: null,
                      },
                      finish_reason: "stop",
                      logprobs: null,
                    },
                  ],
                  usage: {
                    prompt_tokens: 100,
                    completion_tokens: 20,
                    total_tokens: 120,
                  },
                };
              },
            },
          },
        }) as never,
    );

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(openAiProxyRoutes);

    const toolResultContent = JSON.stringify({
      files: [{ name: "README.md" }, { name: "src" }],
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      payload: {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "What files are in the current directory?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: {
                  name: "list_files",
                  arguments: '{"directory": "."}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_123",
            content: toolResultContent,
          },
        ],
      },
    });

    // Fail-open: the request still succeeds and the tool result reaches the
    // provider uncompressed.
    expect(response.statusCode).toBe(200);
    const lastUpstreamRequest = upstreamRequests.at(-1) as {
      messages: { role: string; content?: unknown }[];
    };
    const upstreamToolMessage = lastUpstreamRequest.messages.find(
      (message) => message.role === "tool",
    );
    expect(upstreamToolMessage?.content).toBe(toolResultContent);

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions).toHaveLength(1);
    expect(interactions[0].toonSkipReason).toBe("addon_unavailable");
  });
});
