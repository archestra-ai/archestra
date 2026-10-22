import type OpenAI from "openai";
import type { z } from "zod";
import { isOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { ApiError, Azure, type LLMProvider, type OpenAi } from "@/types";
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
  cancelOnDisconnect: true,
  createClient(apiKey, options) {
    if (isOpenAiCodexCredential(apiKey))
      throw new ApiError(
        400,
        "ChatGPT subscription credentials do not support the Images API. Use a provider API key.",
      );
    return openaiAdapterFactory.createClient(apiKey, options);
  },
  async execute(client, request) {
    const response = await (client as OpenAI).images.generate({
      ...request,
      stream: false,
    } as OpenAI.Images.ImageGenerateParamsNonStreaming);
    return Azure.API.ImageGenerationResponseSchema.parse({
      ...response,
      model: request.model,
    });
  },
  async executeStream() {
    throw new ApiError(
      400,
      "Image streaming is not supported by this endpoint.",
    );
  },
};
