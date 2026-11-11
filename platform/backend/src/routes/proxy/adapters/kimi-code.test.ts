import { describe, expect, test, vi } from "vitest";
import type { OpenAi, Xai } from "@/types";
import { kimiAdapterFactory } from "./kimi";
import { kimiCodeAdapterFactory } from "./kimi-code";
import { xaiAdapterFactory, xaiOpenAiUsageAdapterFactory } from "./xai";

describe("Chat Completions developer-role normalization for Kimi Code and xAI", () => {
  test("rewrites developer messages to system for kimi-code and xai execute/executeStream while leaving kimi untouched", async () => {
    const makeMockClient = (model: string, calls: unknown[]) => ({
      chat: {
        completions: {
          create: vi.fn(async (params: unknown) => {
            calls.push(structuredClone(params));
            if ((params as { stream?: boolean }).stream) {
              return (async function* () {
                yield {
                  id: "chatcmpl-1",
                  object: "chat.completion.chunk",
                  created: 1,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: "ok" },
                      finish_reason: "stop",
                    },
                  ],
                };
              })();
            }
            return {
              id: "chatcmpl-1",
              object: "chat.completion",
              created: 1,
              model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "ok" },
                  finish_reason: "stop",
                },
              ],
            };
          }),
        },
      },
    });

    const request = {
      model: "k3.1-pro",
      messages: [
        { role: "developer", content: "Follow guardrails." },
        { role: "user", content: "Hello" },
      ],
    } as unknown as OpenAi.Types.ChatCompletionsRequest;

    const kimiCodeCalls: unknown[] = [];
    const kimiCodeClient = makeMockClient("k3.1-pro", kimiCodeCalls);
    await kimiCodeAdapterFactory.execute(kimiCodeClient, request);
    for await (const _chunk of await kimiCodeAdapterFactory.executeStream(
      kimiCodeClient,
      request,
    )) {
      // consume stream
    }

    const xaiCalls: unknown[] = [];
    const xaiClient = makeMockClient("grok-4.7", xaiCalls);
    const xaiRequest = request as unknown as Xai.Types.ChatCompletionsRequest;
    await xaiAdapterFactory.execute(xaiClient, xaiRequest);
    for await (const _chunk of await xaiAdapterFactory.executeStream(
      xaiClient,
      xaiRequest,
    )) {
      // consume stream
    }
    await xaiOpenAiUsageAdapterFactory.execute(xaiClient, xaiRequest);

    expect(kimiCodeCalls).toHaveLength(2);
    expect(xaiCalls).toHaveLength(3);
    for (const call of [...kimiCodeCalls, ...xaiCalls]) {
      expect((call as { messages: unknown[] }).messages).toEqual([
        { role: "system", content: "Follow guardrails." },
        { role: "user", content: "Hello" },
      ]);
    }
    // Original request object is not mutated in place
    expect((request.messages[0] as { role: string }).role).toBe("developer");

    // Non-native `kimi` adapter remains untouched
    const kimiCalls: unknown[] = [];
    const kimiClient = makeMockClient("moonshot-v1-8k", kimiCalls);
    await kimiAdapterFactory.execute(kimiClient, request);
    expect(
      (kimiCalls[0] as { messages: Array<{ role: string }> }).messages[0]?.role,
    ).toBe("developer");
  });
});
