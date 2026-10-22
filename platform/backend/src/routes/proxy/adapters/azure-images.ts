import type OpenAI from "openai";
import type { z } from "zod";
import type { LLMProvider, OpenAi } from "@/types";
import { ApiError, Azure } from "@/types";
import { mediaProviderError } from "../utils/media-provider-error";
import { azureAdapterFactory, getAzureClientForRequest } from "./azure";
import { createImageGenerationAdapters } from "./image-generation";

type ImageRequest = z.infer<typeof Azure.API.ImageGenerationRequestSchema>;
type ImageResponse = z.infer<typeof Azure.API.ImageGenerationResponseSchema>;
type Messages = OpenAi.Types.ChatCompletionsRequest["messages"];

/** Image generation goes through the normal proxy auth, limits and audit path. */
export const azureImagesAdapterFactory: LLMProvider<
  ImageRequest,
  ImageResponse,
  Messages,
  never,
  Azure.Types.ChatCompletionsHeaders
> = {
  provider: "azure",
  interactionType: "azure:images",
  spanName: "generate_content",
  unavailableUsageAccounting: true,
  recordRequestDurationInHandler: true,
  getBaseUrl: azureAdapterFactory.getBaseUrl,
  extractApiKey: azureAdapterFactory.extractApiKey,
  createClient: (apiKey, options) =>
    azureAdapterFactory.createClient(apiKey, { ...options, agent: undefined }),
  extractErrorMessage: azureAdapterFactory.extractErrorMessage,
  extractInternalCode: azureAdapterFactory.extractInternalCode,
  ...createImageGenerationAdapters("azure"),
  async execute(client, request) {
    try {
      const response = await getAzureClientForRequest(
        client,
        request.model,
      ).images.generate({
        ...request,
        stream: false,
      } as OpenAI.Images.ImageGenerateParamsNonStreaming);
      return Azure.API.ImageGenerationResponseSchema.parse({
        ...response,
        model: request.model,
      });
    } catch (error) {
      throw mediaProviderError(error, "image generation", "Azure");
    }
  },
  async executeStream() {
    throw new ApiError(
      400,
      "Image generation returns a complete image; use stream: false.",
    );
  },
};
