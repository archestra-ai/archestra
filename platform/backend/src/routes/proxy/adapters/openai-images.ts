import type OpenAI from "openai";
import type { z } from "zod";
import { isOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { ApiError, Azure, type LLMProvider, type OpenAi } from "@/types";
import { mediaProviderError } from "../utils/media-provider-error";
import { createImageGenerationAdapters } from "./image-generation";
import { openaiAdapterFactory } from "./openai";

/** OpenAI's native Images API, using the same governed path as Azure images. */
export const openaiImagesAdapterFactory: LLMProvider<
  z.infer<typeof Azure.API.ImageGenerationRequestSchema>,
  z.infer<typeof Azure.API.ImageGenerationResponseSchema>,
  OpenAi.Types.ChatCompletionsRequest["messages"],
  never,
  OpenAi.Types.ChatCompletionsHeaders
> = {
  ...openaiAdapterFactory,
  ...createImageGenerationAdapters("openai"),
  interactionType: "openai:images",
  spanName: "generate_content",
  unavailableUsageAccounting: true,
  recordRequestDurationInHandler: true,
  cancelOnDisconnect: true,
  createClient(apiKey, options) {
    if (isOpenAiCodexCredential(apiKey))
      throw new ApiError(
        400,
        "ChatGPT subscription credentials do not support the Images API. Use a provider API key.",
      );
    return openaiAdapterFactory.createClient(apiKey, {
      ...options,
      agent: undefined,
    });
  },
  async execute(client, request) {
    try {
      const response = await (client as OpenAI).images.generate({
        ...request,
        stream: false,
      } as OpenAI.Images.ImageGenerateParamsNonStreaming);
      return Azure.API.ImageGenerationResponseSchema.parse({
        ...response,
        model: request.model,
      });
    } catch (error) {
      throw mediaProviderError(error, "image generation", "OpenAI");
    }
  },
  async executeStream() {
    throw new ApiError(
      400,
      "Image streaming is not supported by this endpoint.",
    );
  },
};
