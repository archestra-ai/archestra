import { generateText } from "ai";
import { HttpResponse, http } from "msw";
import { ModelModel, OrganizationModel } from "@/models";
import { expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { resolveOcrConfig, resolveRerankerConfig } from "./kb-llm-client";

// biome-ignore lint/correctness/useHookAtTopLevel: per-test synthetic provider
const server = useMswServer();

test.for([
  "ocr",
  "reranker",
] as const)("a configured KB %s notices hide and Show without reconfiguration", async (kind, {
  makeOrganization,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  const org = await makeOrganization();
  const key = await makeLlmProviderApiKey(
    org.id,
    (await makeSecret({ secret: { apiKey: "synthetic" } })).id,
    { provider: "openai", baseUrl: "https://kb.example.test/v1" },
  );
  const row = await ModelModel.create({
    provider: "openai",
    modelId: "gpt-4o-mini",
    externalId: "openai/gpt-4o-mini",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    outputLength: 4096,
  });
  await OrganizationModel.patch(
    org.id,
    kind === "ocr"
      ? { ocrChatApiKeyId: key.id, ocrModel: row.modelId }
      : { rerankerChatApiKeyId: key.id, rerankerModel: row.modelId },
  );
  const config =
    kind === "ocr"
      ? await resolveOcrConfig(org.id)
      : await resolveRerankerConfig(org.id);
  if (!config || !("llmModel" in config))
    throw new Error("Expected a configured LLM");
  let calls = 0;
  server.use(
    http.post("https://kb.example.test/v1/chat/completions", () => {
      calls++;
      return HttpResponse.json({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: row.modelId,
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
  const ask = () =>
    generateText({ model: config.llmModel, prompt: "fixture", maxRetries: 0 });
  expect((await ask()).text).toBe("Hello");
  await ModelModel.update(row.id, { ignored: true });
  await expect(ask()).rejects.toMatchObject({ internalCode: "model_hidden" });
  expect(calls).toBe(1);
  await ModelModel.update(row.id, { ignored: false });
  expect((await ask()).text).toBe("Hello");
  expect(calls).toBe(2);
});
