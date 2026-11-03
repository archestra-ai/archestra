import { describe, expect, test } from "vitest";
import ModelModel from "@/models/model";

describe("resolved model availability", () => {
  test("Claude context variants use the canonical row and do not cross providers", async () => {
    const model = await ModelModel.create({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      externalId: "anthropic/claude-sonnet-4-6",
      inputModalities: ["text"],
      outputModalities: ["text"],
      ignored: true,
    });
    await expect(
      ModelModel.assertAvailable({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6[1m]",
      }),
    ).rejects.toMatchObject({ statusCode: 403, internalCode: "model_hidden" });
    await expect(
      ModelModel.assertAvailable({
        provider: "vllm",
        modelId: "claude-sonnet-4-6",
      }),
    ).resolves.toBeUndefined();
    await ModelModel.update(model.id, { ignored: false });
    await expect(
      ModelModel.assertAvailable({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6[1m]",
      }),
    ).resolves.toBeUndefined();
  });
  test.for([
    "ollama",
    "ollama-native",
  ] as const)("%s matches actual Ollama names without crossing registries or tags", async (provider) => {
    const model = await ModelModel.create({
      provider,
      modelId: "Llama3.2:latest",
      externalId: `${provider}/Llama3.2:latest`,
      inputModalities: ["text"],
      outputModalities: ["text"],
      ignored: true,
    });
    for (const modelId of [
      "llama3.2",
      "LLAMA3.2:latest",
      "library/llama3.2",
      "registry.ollama.ai/library/llama3.2:latest",
      "https://registry.ollama.ai/library/llama3.2",
      "1://registry.ollama.ai/library/llama3.2",
      " llama3.2 ",
      "\u0085 llama3.2 \u0085",
      "llama3.2:local",
      "llama3.2:latest:local",
    ]) {
      await expect(
        ModelModel.assertAvailable({ provider, modelId }),
      ).rejects.toMatchObject({
        statusCode: 403,
        internalCode: "model_hidden",
      });
    }
    for (const modelId of [
      "unknown-custom-model",
      "llama3.2:small",
      "llama3.2:cloud",
      "team/llama3.2",
      "mirror.example/library/llama3.2:latest",
    ]) {
      await expect(
        ModelModel.assertAvailable({ provider, modelId }),
      ).resolves.toBeUndefined();
    }
    await expect(
      ModelModel.assertAvailable({
        provider: "vllm",
        modelId: "llama3.2:latest",
      }),
    ).resolves.toBeUndefined();
    await ModelModel.create({
      provider,
      modelId: "synthetic-fireworks",
      externalId: `${provider}/synthetic-fireworks`,
      inputModalities: ["text"],
      outputModalities: ["text"],
      ignored: true,
    });
    await expect(
      ModelModel.assertAvailable({
        provider,
        modelId: "accounts/fireworks/models/synthetic-fireworks",
        aliases: ["synthetic-fireworks"],
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await ModelModel.create({
      provider,
      modelId: "cloud-model:cloud",
      externalId: `${provider}/cloud-model:cloud`,
      inputModalities: ["text"],
      outputModalities: ["text"],
      ignored: true,
    });
    for (const modelId of [
      "cloud-model:latest:cloud",
      "cloud-model:latest-cloud",
    ]) {
      await expect(
        ModelModel.assertAvailable({ provider, modelId }),
      ).rejects.toMatchObject({ statusCode: 403 });
    }
    await expect(
      ModelModel.assertAvailable({ provider, modelId: "cloud-model:local" }),
    ).resolves.toBeUndefined();
    await ModelModel.update(model.id, { ignored: false });
    await expect(
      ModelModel.assertAvailable({ provider, modelId: "llama3.2" }),
    ).resolves.toBeUndefined();
  });
});
