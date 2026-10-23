/**
 * The xAI route's Responses surface. OpenAI-compatible clients (the AI SDK's
 * xAI provider, Kilo Code's SuperGrok sign-in) send Responses requests, and
 * the proxy serves them over xAI's chat completions, as the model router does.
 * Only the upstream client is mocked; the key, model, link and virtual key are
 * real.
 */

import type OpenAI from "openai";
import { vi } from "vitest";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { LlmProviderApiKeyModelLinkModel, ModelModel } from "@/models";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { xaiAdapterFactory } from "../adapters/xai";
import xaiProxyRoutes from "./xai";

const MODEL = "grok-4.7";

describe("xAI Responses surface", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) {
      await app.close();
    }
  });

  /** Records what reaches xAI's chat completions and answers a fixed reply. */
  async function setupRoute() {
    const calls: OpenAI.Chat.Completions.ChatCompletionCreateParams[] = [];
    app = createFastifyInstance();

    vi.spyOn(xaiAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          chat: {
            completions: {
              create: async (
                request: OpenAI.Chat.Completions.ChatCompletionCreateParams,
              ) => {
                calls.push(request);
                if (request.stream) {
                  const chunk = {
                    id: "chatcmpl-xai-responses",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: request.model,
                  };
                  return {
                    [Symbol.asyncIterator]: async function* () {
                      yield {
                        ...chunk,
                        choices: [
                          {
                            index: 0,
                            delta: { role: "assistant", content: "Hello " },
                            finish_reason: null,
                          },
                        ],
                      };
                      yield {
                        ...chunk,
                        choices: [
                          {
                            index: 0,
                            delta: { content: "from Grok" },
                            finish_reason: null,
                          },
                        ],
                      };
                      yield {
                        ...chunk,
                        choices: [
                          { index: 0, delta: {}, finish_reason: "stop" },
                        ],
                        usage: {
                          prompt_tokens: 10,
                          completion_tokens: 3,
                          total_tokens: 13,
                        },
                      };
                    },
                  };
                }
                const toolCall = request.tools?.length
                  ? {
                      tool_calls: [
                        {
                          id: "call_1",
                          type: "function" as const,
                          function: {
                            name: "read_file",
                            arguments: JSON.stringify({ path: "README.md" }),
                          },
                        },
                      ],
                    }
                  : {};
                return {
                  id: "chatcmpl-xai-responses",
                  object: "chat.completion",
                  created: 1,
                  model: request.model,
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: "assistant" as const,
                        content: request.tools?.length
                          ? null
                          : "Hello from Grok",
                        refusal: null,
                        ...toolCall,
                      },
                      finish_reason: request.tools?.length
                        ? ("tool_calls" as const)
                        : ("stop" as const),
                      logprobs: null,
                    },
                  ],
                  usage: {
                    prompt_tokens: 10,
                    completion_tokens: 3,
                    total_tokens: 13,
                  },
                };
              },
            },
          },
        }) as never,
    );

    await app.register(xaiProxyRoutes);
    return calls;
  }

  /** One xAI key serving one model, and a virtual key mapped to it. */
  async function seed(params: {
    organizationId: string;
    makeSecret: () => Promise<{ id: string }>;
    makeLlmProviderApiKey: (
      organizationId: string,
      secretId: string,
      overrides?: Record<string, unknown>,
    ) => Promise<{ id: string }>;
  }) {
    const secret = await params.makeSecret();
    const key = await params.makeLlmProviderApiKey(
      params.organizationId,
      secret.id,
      { provider: "xai", isPrimary: true },
    );
    const model = await ModelModel.create({
      externalId: `xai/${MODEL}`,
      provider: "xai",
      modelId: MODEL,
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    const { value } = await VirtualApiKeyModel.create({
      organizationId: params.organizationId,
      name: "xAI virtual key",
      providerApiKeys: [{ provider: "xai", providerApiKeyId: key.id }],
    });
    return value;
  }

  test("serves a Responses request over xAI's chat completions with the organization's key", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      name: "xAI Responses",
      agentType: "llm_proxy",
    });
    const tokenValue = await seed({
      organizationId: org.id,
      makeSecret: makeSecret as never,
      makeLlmProviderApiKey: makeLlmProviderApiKey as never,
    });
    const calls = await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: `/v1/xai/${agent.id}/responses`,
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        "Content-Type": "application/json",
      },
      payload: { model: MODEL, input: "Hello" },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      object: "response",
      model: MODEL,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello from Grok" }],
        },
      ],
    });
    // The upstream call is the translated chat completion, with the model id
    // as the client sent it.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: MODEL,
      messages: [{ role: "user", content: "Hello" }],
    });
  });

  test("translates a function tool and the tool call it produces", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      name: "xAI Responses tools",
      agentType: "llm_proxy",
    });
    const tokenValue = await seed({
      organizationId: org.id,
      makeSecret: makeSecret as never,
      makeLlmProviderApiKey: makeLlmProviderApiKey as never,
    });
    const calls = await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: `/v1/xai/${agent.id}/responses`,
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        "Content-Type": "application/json",
      },
      payload: {
        model: MODEL,
        input: [
          { role: "user", content: [{ type: "input_text", text: "Read it" }] },
        ],
        tools: [
          {
            type: "function",
            name: "read_file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    // The Responses tool becomes a chat function tool upstream, and the
    // upstream tool call comes back as a Responses function_call item.
    expect(calls[0]).toMatchObject({
      tools: [{ type: "function", function: { name: "read_file" } }],
    });
    expect(response.json().output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call",
          name: "read_file",
          arguments: JSON.stringify({ path: "README.md" }),
        }),
      ]),
    );
  });

  test("streams a Responses request as Responses events", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      name: "xAI Responses stream",
      agentType: "llm_proxy",
    });
    const tokenValue = await seed({
      organizationId: org.id,
      makeSecret: makeSecret as never,
      makeLlmProviderApiKey: makeLlmProviderApiKey as never,
    });
    const calls = await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: `/v1/xai/${agent.id}/responses`,
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        "Content-Type": "application/json",
      },
      payload: { model: MODEL, input: "Hello", stream: true },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("response.output_text.delta");
    expect(response.body).toContain("response.completed");
    expect(response.body).toContain("Hello from Grok");
    expect(calls[0]).toMatchObject({ model: MODEL, stream: true });
  });
});
