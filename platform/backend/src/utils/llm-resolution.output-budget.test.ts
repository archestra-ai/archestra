import { describe, expect, test } from "vitest";
import config from "@/config";
import { ModelModel } from "@/models";
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
    ).toEqual({ kind: "catalogued", tokens: 4_096 });
  });

  test("marks a model whose output shares the prompt's window, leaving the prompt half of it", async () => {
    await ModelModel.create({
      externalId: "openai/gpt-4",
      provider: "openai",
      modelId: "gpt-4",
      outputLength: 8_192,
      contextLength: 8_192,
      inputModalities: ["text"],
      outputModalities: ["text"],
    });

    expect(
      await resolveModelOutputBudget({
        provider: "openai",
        modelName: "gpt-4",
      }),
    ).toEqual({ kind: "shared-window", tokens: 4_096 });
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
    ).toEqual({
      kind: "catalogued",
      tokens: config.chat.maxOutputTokensCeiling,
    });
  });

  test("falls back to a conservative budget for a model the catalog lacks", async () => {
    expect(
      await resolveModelOutputBudget({
        provider: "gemini",
        modelName: "gemini-unknown",
      }),
    ).toEqual({ kind: "uncatalogued", tokens: 8_192 });
  });

  test("a caller can assume a smaller cap for a model the catalog lacks", async () => {
    expect(
      await resolveModelOutputBudget({
        provider: "bedrock",
        modelName: "us.anthropic.claude-3-haiku-20240307-v1:0",
        unknownOutputLength: 4_096,
      }),
    ).toEqual({ kind: "uncatalogued", tokens: 4_096 });
  });
});
