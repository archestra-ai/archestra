import { ApiError } from "@shared";
import { vi } from "vitest";
import { ModelModel } from "@/models";
import { afterEach, describe, expect, test } from "@/test";
import {
  buildRoutableModelId,
  parseProviderQualifiedModel,
  resolveModelRoute,
  sortRoutableModels,
} from "./model-router-resolver";

describe("model-router-resolver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("parseProviderQualifiedModel", () => {
    test("parses the first colon as the provider separator", () => {
      expect(parseProviderQualifiedModel("anthropic:claude:haiku")).toEqual({
        provider: "anthropic",
        modelId: "claude:haiku",
      });
    });

    test("returns null for unqualified or unsupported provider model IDs", () => {
      expect(parseProviderQualifiedModel("gpt-4o-mini")).toBeNull();
      expect(parseProviderQualifiedModel(":gpt-4o-mini")).toBeNull();
      expect(parseProviderQualifiedModel("openai:")).toBeNull();
      expect(parseProviderQualifiedModel("unknown:gpt-4o-mini")).toBeNull();
    });
  });

  describe("resolveModelRoute", () => {
    test("resolves a provider-qualified text model", async () => {
      await createTextModel({
        provider: "anthropic",
        modelId: "claude-haiku-resolver-test",
      });

      const resolution = await resolveModelRoute({
        requestedModel: " anthropic:claude-haiku-resolver-test ",
      });

      expect(resolution).toEqual({
        provider: "anthropic",
        modelId: "claude-haiku-resolver-test",
        requestedModel: "anthropic:claude-haiku-resolver-test",
      });
    });

    test("preserves colons inside the provider-specific model ID", async () => {
      await createTextModel({
        provider: "bedrock",
        modelId: "us.anthropic:claude-haiku-resolver-test",
      });

      await expect(
        resolveModelRoute({
          requestedModel: "bedrock:us.anthropic:claude-haiku-resolver-test",
        }),
      ).resolves.toMatchObject({
        provider: "bedrock",
        modelId: "us.anthropic:claude-haiku-resolver-test",
      });
    });

    test("rejects a provider not mapped to the Model Router virtual key", async () => {
      await createTextModel({
        provider: "anthropic",
        modelId: "claude-unmapped-resolver-test",
      });

      await expectApiError(
        resolveModelRoute({
          requestedModel: "anthropic:claude-unmapped-resolver-test",
          allowedProviders: new Set(["openai"]),
        }),
        {
          statusCode: 400,
          message:
            'Model "anthropic:claude-unmapped-resolver-test" is scoped to provider "anthropic", but the Model Router virtual key is not mapped to that provider.',
        },
      );
    });

    test("returns 404 for unqualified, unknown, and non-text models", async () => {
      await createTextModel({
        provider: "openai",
        modelId: "known-resolver-test",
      });
      await createModel({
        provider: "gemini",
        modelId: "image-only-resolver-test",
        inputModalities: ["text"],
        outputModalities: ["image"],
      });

      for (const requestedModel of [
        "known-resolver-test",
        "openai:missing-resolver-test",
        "gemini:image-only-resolver-test",
      ]) {
        await expectApiError(resolveModelRoute({ requestedModel }), {
          statusCode: 404,
          message: `Model "${requestedModel}" is not available. Use a provider-qualified model id such as "anthropic:claude-opus-4-6-20250918".`,
        });
      }
    });

    test("returns 500 when a provider-qualified model resolves ambiguously", async () => {
      const firstModel = await createTextModel({
        provider: "openai",
        modelId: "duplicate-resolver-test-a",
      });
      const secondModel = await createTextModel({
        provider: "openai",
        modelId: "duplicate-resolver-test-b",
      });
      vi.spyOn(ModelModel, "findTextChatModelsByModelId").mockResolvedValue([
        firstModel,
        secondModel,
      ]);

      await expectApiError(
        resolveModelRoute({
          requestedModel: "openai:duplicate-resolver-test",
        }),
        {
          statusCode: 500,
          message:
            'Ambiguous model resolution: "openai:duplicate-resolver-test" matched 2 models.',
        },
      );
    });

    test("returns 400 when the model is blank", async () => {
      await expectApiError(resolveModelRoute({ requestedModel: "   " }), {
        statusCode: 400,
        message: "Model is required.",
      });
    });
  });

  describe("routable model helpers", () => {
    test("builds provider-qualified IDs and sorts by provider order then model ID", async () => {
      const gemini = await createTextModel({
        provider: "gemini",
        modelId: "gemini-z-resolver-test",
      });
      const openAiB = await createTextModel({
        provider: "openai",
        modelId: "gpt-b-resolver-test",
      });
      const openAiA = await createTextModel({
        provider: "openai",
        modelId: "gpt-a-resolver-test",
      });

      expect(buildRoutableModelId(openAiA)).toBe("openai:gpt-a-resolver-test");
      expect(
        sortRoutableModels([gemini, openAiB, openAiA]).map((model) =>
          buildRoutableModelId(model),
        ),
      ).toEqual([
        "openai:gpt-a-resolver-test",
        "openai:gpt-b-resolver-test",
        "gemini:gemini-z-resolver-test",
      ]);
    });
  });
});

async function expectApiError(
  promise: Promise<unknown>,
  expected: { statusCode: number; message: string },
) {
  try {
    await promise;
    throw new Error("Expected promise to reject with ApiError");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(expected.statusCode);
    expect((error as ApiError).message).toBe(expected.message);
  }
}

async function createTextModel(params: {
  provider: "anthropic" | "bedrock" | "gemini" | "openai";
  modelId: string;
}) {
  return await createModel({
    ...params,
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
}

async function createModel(params: {
  provider: "anthropic" | "bedrock" | "gemini" | "openai";
  modelId: string;
  inputModalities: ["text"];
  outputModalities: ["image"] | ["text"];
}) {
  return await ModelModel.create({
    externalId: `${params.provider}/${params.modelId}`,
    provider: params.provider,
    modelId: params.modelId,
    inputModalities: params.inputModalities,
    outputModalities: params.outputModalities,
    promptPricePerToken: "0.000001",
    completionPricePerToken: "0.000002",
    lastSyncedAt: new Date(),
  });
}
