import { generateText, streamText } from "ai";
import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import ModelModel from "@/models/model";
import { useMswServer } from "@/test/msw";
import { createDirectLLMModel } from "./llm-client";

// biome-ignore lint/correctness/useHookAtTopLevel: per-test synthetic provider
const server = useMswServer();

test.for([
  "openai",
  "ollama-native",
] as const)("cached direct %s clients honor hide and Show before HTTP", async (provider) => {
  const modelName = provider === "openai" ? "gpt-4o-mini" : "llama3.2";
  const row = await ModelModel.create({
    provider,
    modelId: modelName,
    externalId: `${provider}/${modelName}`,
    inputModalities: ["text"],
    outputModalities: ["text"],
    outputLength: 4096,
  });
  let calls = 0;
  server.use(
    http.post(
      provider === "openai"
        ? "https://direct.example.test/chat/completions"
        : "https://direct.example.test/api/chat",
      async () => {
        calls++;
        return HttpResponse.json(
          provider === "openai"
            ? {
                id: "fixture",
                object: "chat.completion",
                created: 1,
                model: modelName,
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "Hello" },
                    finish_reason: "stop",
                  },
                ],
                usage: {
                  prompt_tokens: 1,
                  completion_tokens: 1,
                  total_tokens: 2,
                },
              }
            : {
                model: modelName,
                created_at: new Date().toISOString(),
                message: { role: "assistant", content: "Hello" },
                done: true,
                done_reason: "stop",
                prompt_eval_count: 1,
                eval_count: 1,
              },
        );
      },
    ),
  );
  const model = createDirectLLMModel({
    provider,
    modelName,
    apiKey: "synthetic",
    baseUrl: "https://direct.example.test",
  });
  const ask = () => generateText({ model, prompt: "fixture", maxRetries: 0 });
  expect((await ask()).text).toBe("Hello");
  await ModelModel.update(row.id, { ignored: true });
  await expect(ask()).rejects.toMatchObject({ internalCode: "model_hidden" });
  // Streaming goes through the same guard before opening its first byte.
  const streaming = streamText({ model, prompt: "fixture", maxRetries: 0 });
  await expect(streaming.text).rejects.toThrow();
  expect(calls).toBe(1);
  await ModelModel.update(row.id, { ignored: false });
  expect((await ask()).text).toBe("Hello");
  const custom = createDirectLLMModel({
    provider,
    modelName: "uncatalogued-direct-model",
    apiKey: "synthetic",
    baseUrl: "https://direct.example.test",
  });
  expect(
    (await generateText({ model: custom, prompt: "fixture", maxRetries: 0 }))
      .text,
  ).toBe("Hello");
  expect(calls).toBe(3);
});

test("direct Fireworks aliases check the canonical hidden model", async () => {
  const canonical = "accounts/fireworks/models/glm-5";
  const row = await ModelModel.create({
    provider: "vllm",
    modelId: canonical,
    externalId: `vllm/${canonical}`,
    inputModalities: ["text"],
    outputModalities: ["text"],
    ignored: true,
  });
  let calls = 0;
  server.use(
    http.post("https://api.fireworks.ai/inference/v1/chat/completions", () => {
      calls++;
      return HttpResponse.json({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: canonical,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }),
  );
  const model = createDirectLLMModel({
    provider: "vllm",
    modelName: "glm-5",
    apiKey: "synthetic",
    baseUrl: "https://api.fireworks.ai/inference/v1",
  });
  await expect(
    generateText({ model, prompt: "fixture", maxRetries: 0 }),
  ).rejects.toMatchObject({ internalCode: "model_hidden" });
  expect(calls).toBe(0);
  await ModelModel.update(row.id, { ignored: false });
  expect(
    (await generateText({ model, prompt: "fixture", maxRetries: 0 })).text,
  ).toBe("Hello");
  expect(calls).toBe(1);
});
