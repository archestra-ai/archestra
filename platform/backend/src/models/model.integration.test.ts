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
});
