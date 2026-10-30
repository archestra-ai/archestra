import type OpenAI from "openai";
import { toFile } from "openai";
import type { z } from "zod";
import { ApiError, Azure, type LLMProvider, type OpenAi } from "@/types";
import { fetchWithAbortSignal } from "@/utils/client-disconnect-signal";
import { PROXY_BODY_LIMIT } from "../common";
import { boundedMediaFetch } from "../utils/bounded-media-response";
import {
  loggedUploadMetadata,
  type ValidatedImageEditUploads,
} from "../utils/image-edit-input";
import { mediaProviderError } from "../utils/media-provider-error";
import { azureAdapterFactory, getAzureClientForRequest } from "./azure";
import { azureImagesAdapterFactory } from "./azure-images";

export type AzureImageEditRequest = z.infer<
  typeof Azure.API.ImageEditFieldsSchema
> & {
  input_files?: ValidatedImageEditUploads["metadata"];
  metadata?: { operation: "image-edit" };
};
type ImageResponse = z.infer<typeof Azure.API.ImageGenerationResponseSchema>;

/** The uploads live in this request's closure; only the log row keeps a copy. */
export function createAzureImageEditAdapter(
  uploads: ValidatedImageEditUploads,
): LLMProvider<
  AzureImageEditRequest,
  ImageResponse,
  OpenAi.Types.ChatCompletionsRequest["messages"],
  never,
  Azure.Types.ChatCompletionsHeaders
> {
  return {
    ...azureImagesAdapterFactory,
    unavailableUsageAccounting: true,
    recordRequestDurationInHandler: true,
    toLoggedRequest: (request: AzureImageEditRequest) => ({
      ...request,
      input_files: loggedUploadMetadata(uploads),
    }),
    createClient(apiKey, options) {
      // The generic fetch observer logs raw provider error bodies. Keep media
      // failures private and let handleLLMProxy record the request duration.
      const client = azureAdapterFactory.createClient(apiKey, {
        ...options,
        agent: undefined,
      }) as {
        openai: OpenAI;
        fetch?: typeof fetch;
      };
      const mediaFetch = boundedMediaFetch(
        fetchWithAbortSignal(client.fetch, options.abortSignal) ?? fetch,
        PROXY_BODY_LIMIT,
      );
      return {
        ...client,
        fetch: mediaFetch,
        openai: client.openai.withOptions({ fetch: mediaFetch }),
      };
    },

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
      let raw: unknown;
      try {
        raw = await getAzureClientForRequest(client, request.model).images.edit(
          {
            ...fields,
            image,
            ...(mask && { mask }),
            stream: false,
          } as OpenAI.Images.ImageEditParamsNonStreaming,
          { timeout: 180_000 },
        );
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new ApiError(
            502,
            "Azure returned an invalid image edit response.",
          );
        throw mediaProviderError(error, "image edit");
      }
      const result = Azure.API.ImageGenerationResponseSchema.safeParse(raw);
      if (
        !result.success ||
        !result.data.data?.length ||
        result.data.data.some((item) => !validImageOutput(item))
      ) {
        throw new ApiError(
          502,
          "Azure returned an invalid or empty image edit response.",
        );
      }
      return { ...result.data, model: request.model };
    },
  };
}

function validImageOutput(item: { b64_json?: string; url?: string }) {
  if (item.b64_json) {
    const value = item.b64_json;
    const paddingStart = value.indexOf("=");
    // Avoid repeated regex groups: multi-megabyte image outputs can exhaust
    // the regex engine's stack even when the base64 is valid.
    return (
      value.length % 4 === 0 &&
      !/[^A-Za-z0-9+/=]/.test(value) &&
      (paddingStart === -1 ||
        paddingStart === value.length - 1 ||
        (paddingStart === value.length - 2 && value.endsWith("==")))
    );
  }
  if (item.url) {
    try {
      return new URL(item.url).protocol === "https:";
    } catch {
      return false;
    }
  }
  return false;
}
