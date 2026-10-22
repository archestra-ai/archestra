import type OpenAI from "openai";
import { toFile } from "openai";
import type { z } from "zod";
import { ApiError, Azure, type LLMProvider, type OpenAi } from "@/types";
import { fetchWithAbortSignal } from "@/utils/client-disconnect-signal";
import { PROXY_BODY_LIMIT } from "../common";
import { boundedMediaFetch } from "../utils/bounded-media-response";
import type { ValidatedImageEditUploads } from "../utils/image-edit-input";
import { azureAdapterFactory, getAzureClientForRequest } from "./azure";
import { azureImagesAdapterFactory } from "./azure-images";

export type AzureImageEditRequest = z.infer<
  typeof Azure.API.ImageEditFieldsSchema
> & {
  input_files?: ValidatedImageEditUploads["metadata"];
  metadata?: { operation: "image-edit" };
};
type ImageResponse = z.infer<typeof Azure.API.ImageGenerationResponseSchema>;

/** Binary inputs live only in this request's closure, never in interaction bodies. */
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
    createClient(apiKey, options) {
      const client = azureAdapterFactory.createClient(apiKey, options) as {
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
    createResponseAdapter(response) {
      const adapter = azureImagesAdapterFactory.createResponseAdapter(response);
      const measured = adapter.getUsage.bind(adapter);
      adapter.getUsage = () => ({
        ...measured(),
        costUnavailable: true,
        ...(!response.usage && { usageUnavailable: true }),
      });
      return adapter;
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
        throw error;
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
  if (item.b64_json)
    return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      item.b64_json,
    );
  if (item.url) {
    try {
      return new URL(item.url).protocol === "https:";
    } catch {
      return false;
    }
  }
  return false;
}
