import { describe, expect, test, vi } from "vitest";
import type { OpenAi } from "@/types";
import { kimiAdapterFactory } from "./kimi";
import { kimiCodeAdapterFactory } from "./kimi-code";

describe("kimiCodeAdapterFactory developer-role normalization", () => {
  test("rewrites developer messages to system for kimi-code execute and executeStream while leaving kimi untouched", async () => {
    const kimiCodeCalls: unknown[] = [];
    const kimiCodeClient = {
      chat: {
        completions: {
          create: vi.fn(async (params: unknown) => {
            kimiCodeCalls.push(structuredClone(params));
            if ((params as { stream?: boolean }).stream) {
              return (async function* () {
                yield {
                  id: "chatcmpl-1",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "k3.1-pro",
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
              model: "k3.1-pro",
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
    };

    const request = {
      model: "k3.1-pro",
      messages: [
        { role: "developer", content: "Follow guardrails." },
        { role: "user", content: "Hello" },
      ],
    } as unknown as OpenAi.Types.ChatCompletionsRequest;

    await kimiCodeAdapterFactory.execute(kimiCodeClient, request);
    const stream = await kimiCodeAdapterFactory.executeStream(
      kimiCodeClient,
      request,
    );
    for await (const _chunk of stream) {
      // consume stream
    }

    expect(kimiCodeCalls).toHaveLength(2);
    for (const call of kimiCodeCalls) {
      expect((call as { messages: unknown[] }).messages).toEqual([
        { role: "system", content: "Follow guardrails." },
        { role: "user", content: "Hello" },
      ]);
    }
    // Original request object is not mutated in place
    expect((request.messages[0] as { role: string }).role).toBe("developer");

    // Non-native `kimi` adapter remains untouched
    const kimiCalls: unknown[] = [];
    const kimiClient = {
      chat: {
        completions: {
          create: vi.fn(async (params: unknown) => {
            kimiCalls.push(structuredClone(params));
            return { choices: [] };
          }),
        },
      },
    };
    await kimiAdapterFactory.execute(kimiClient, request);
    expect(
      (kimiCalls[0] as { messages: Array<{ role: string }> }).messages[0]?.role,
    ).toBe("developer");
  });
});
