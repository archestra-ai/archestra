import { describe, expect, test } from "vitest";
import { ChatCompletionResponseSchema as Cerebras } from "./cerebras/api";
import { ChatCompletionResponseSchema as Copilot } from "./github-copilot/api";
import { ChatCompletionResponseSchema as Ollama } from "./ollama/api";
import { ChatCompletionResponseSchema as OpenAI } from "./openai/api";
import { ChatCompletionResponseSchema as Vllm } from "./vllm/api";
import { ChatCompletionResponseSchema as Zhipuai } from "./zhipuai/api";

const providers = [
  { provider: "OpenAI", schema: OpenAI },
  { provider: "Copilot", schema: Copilot },
  { provider: "Ollama", schema: Ollama },
  { provider: "Cerebras", schema: Cerebras },
  { provider: "vLLM", schema: Vllm },
  { provider: "ZhipuAI", schema: Zhipuai },
];

const envelope = {
  id: "chatcmpl-example",
  object: "chat.completion",
  created: 123,
  model: "example-model",
};
const choice = {
  index: 0,
  finish_reason: "stop",
  message: { role: "assistant", content: "Hello" },
};

describe.each(providers)("$provider completion compatibility", ({ schema }) => {
  test.each([
    {},
    { logprobs: null },
    { logprobs: { content: [] } },
  ])("accepts omitted, null, and present logprobs: %j", (logprobs) => {
    const result = schema.safeParse({
      ...envelope,
      choices: [{ ...choice, ...logprobs }],
    });
    expect(result.success).toBe(true);
    expect(result.data?.choices[0]).toMatchObject({ ...choice, ...logprobs });
  });

  test("still rejects a malformed assistant message", () => {
    const result = schema.safeParse({
      ...envelope,
      choices: [{ ...choice, logprobs: null, message: { content: "Hello" } }],
    });
    expect(result.success).toBe(false);
  });
});
