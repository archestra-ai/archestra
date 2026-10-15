import config from "@/config";
import { ModelModel } from "@/models";
import { describe, expect, test } from "@/test";
import { resolveModelOutputBudget } from "./llm-resolution";

describe("resolveModelOutputBudget", () => {
  test("never asks a catalogued model for more than its own output cap", async () => {
    await ModelModel.create({
      externalId: "openai/gpt-4-turbo",
      provider: "openai",
      modelId: "gpt-4-turbo",
      outputLength: 4_096,
      contextLength: 128_000,
      inputModalities: ["text"],
      outputModalities: ["text"],
    });

    expect(
      await resolveModelOutputBudget({
        provider: "openai",
        modelName: "gpt-4-turbo",
      }),
    ).toBe(4_096);
  });

  test("clamps a large catalogued cap to the operator ceiling", async () => {
    await ModelModel.create({
      externalId: "anthropic/claude-sonnet-5",
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      outputLength: 128_000,
      contextLength: 1_000_000,
      inputModalities: ["text"],
      outputModalities: ["text"],
    });

    expect(
      await resolveModelOutputBudget({
        provider: "anthropic",
        modelName: "claude-sonnet-5",
      }),
    ).toBe(config.chat.maxOutputTokensCeiling);
  });

  test("falls back to a conservative budget for a model the catalog lacks", async () => {
    expect(
      await resolveModelOutputBudget({
        provider: "gemini",
        modelName: "gemini-unknown",
      }),
    ).toBe(8_192);
  });

  test("a caller can assume a smaller cap for a model the catalog lacks", async () => {
    expect(
      await resolveModelOutputBudget({
        provider: "bedrock",
        modelName: "us.anthropic.claude-3-haiku-20240307-v1:0",
        unknownOutputLength: 4_096,
      }),
    ).toBe(4_096);
  });
});
