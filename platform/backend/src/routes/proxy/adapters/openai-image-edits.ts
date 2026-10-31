import type OpenAI from "openai";
import { toFile } from "openai";
import type { z } from "zod";
import { Azure, type LLMProvider, type OpenAi } from "@/types";
import {
  loggedUploadMetadata,
  type ValidatedImageEditUploads,
} from "../utils/image-edit-input";
import { mediaProviderError } from "../utils/media-provider-error";
import type { AzureImageEditRequest } from "./azure-image-edits";
import { openaiImagesAdapterFactory } from "./openai-images";

type ImageResponse = z.infer<typeof Azure.API.ImageGenerationResponseSchema>;

/**
 * OpenAI's native image edits, on the governed path its image generations use.
 * The uploads live in this request's closure; only the log row keeps a copy.
 */
export function createOpenAiImageEditAdapter(
  uploads: ValidatedImageEditUploads,
): LLMProvider<
  AzureImageEditRequest,
  ImageResponse,
  OpenAi.Types.ChatCompletionsRequest["messages"],
  never,
  OpenAi.Types.ChatCompletionsHeaders
> {
  return {
    ...openaiImagesAdapterFactory,
    toLoggedRequest: (request: AzureImageEditRequest) => ({
      ...request,
      input_files: loggedUploadMetadata(uploads),
    }),
    async execute(client, request) {
      const {
        input_files: _inputFiles,
        metadata: _metadata,
        ...fields
      } = request;
      const image = await Promise.all(
        uploads.images.map((file, index) =>
          toFile(file.data, file.filename, {
            type: uploads.metadata.images[index].mime_type,
          }),
        ),
      );
      const mask =
        uploads.mask &&
        (await toFile(uploads.mask.data, uploads.mask.filename, {
          type: "image/png",
        }));
      try {
        const response = await (client as OpenAI).images.edit({
          ...fields,
          // One reference goes out as the single `image` field a client sends;
          // several as the `image[]` array.
          image: image.length === 1 ? image[0] : image,
          ...(mask && { mask }),
          stream: false,
        } as OpenAI.Images.ImageEditParamsNonStreaming);
        return Azure.API.ImageGenerationResponseSchema.parse({
          ...response,
          model: request.model,
        });
      } catch (error) {
        throw mediaProviderError(error, "image edit", "OpenAI");
      }
    },
  };
}
