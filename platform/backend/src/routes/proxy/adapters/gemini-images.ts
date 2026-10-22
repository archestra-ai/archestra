import type { GenerateContentParameters, GoogleGenAI } from "@google/genai";
import type { z } from "zod";
import {
  ApiError,
  type Azure,
  type CreateClientOptions,
  type Gemini,
  type LLMResponseAdapter,
} from "@/types";
import { ObservedProviderUsageError } from "@/utils/observed-provider-usage-error";
import { mediaProviderError } from "../utils/media-provider-error";
import { type GeminiRequestWithModel, geminiAdapterFactory } from "./gemini";

/** Translate only Images parameters with an exact native Gemini meaning. */
export function toGeminiImageRequest(
  request: z.infer<typeof Azure.API.ImageGenerationRequestSchema>,
): GeminiRequestWithModel {
  for (const [name, value] of Object.entries(request)) {
    if (value == null || name === "model" || name === "prompt") continue;
    if (name === "n" && value === 1) continue;
    if (name === "stream" && value === false) continue;
    if (name === "response_format" && value === "b64_json") continue;
    if (name === "size" && value === "auto") continue;
    throw new ApiError(
      400,
      `Gemini image generation does not support parameter "${name}" with this value. Use the native Gemini endpoint for provider-specific image settings.`,
    );
  }
  return {
    _model: request.model,
    _isStreaming: false,
    contents: [{ role: "user", parts: [{ text: request.prompt }] }],
    generationConfig: { responseModalities: ["IMAGE"] },
  };
}

/** Native inference, usage and logging; only the client response changes shape. */
export const geminiImagesAdapterFactory = {
  ...geminiAdapterFactory,
  unavailableUsageAccounting: true,
  recordRequestDurationInHandler: true,
  cancelOnDisconnect: true,
  createClient(apiKey: string | undefined, options: CreateClientOptions) {
    const native = geminiAdapterFactory.createClient(apiKey, {
      ...options,
      agent: undefined,
    }) as GoogleGenAI;
    // Keep the native adapter's request preparation and observability, adding
    // only the request-scoped cancellation signal supported by the Google SDK.
    return {
      models: {
        generateContent: (params: GenerateContentParameters) =>
          native.models.generateContent({
            ...params,
            config: { ...params.config, abortSignal: options.abortSignal },
          }),
      },
    };
  },
  async executeStream(): Promise<never> {
    throw new ApiError(
      400,
      "Gemini image streaming is not supported by the Images compatibility endpoint.",
    );
  },
  async execute(client: unknown, request: GeminiRequestWithModel) {
    let result: Gemini.Types.GenerateContentResponse;
    try {
      result = await geminiAdapterFactory.execute(client, request);
    } catch (error) {
      throw mediaProviderError(error, "image generation", "Gemini");
    }
    const adapter = new GeminiImagesResponseAdapter(result);
    if (!adapter.getOriginalResponse().data?.length) {
      throw new ObservedProviderUsageError({
        original: new ApiError(
          502,
          "Gemini returned no generated image. Inspect the provider response in the LLM log.",
        ),
        response: result,
        usage: adapter.getUsage(),
      });
    }
    return result;
  },
  createResponseAdapter: (response: Gemini.Types.GenerateContentResponse) =>
    new GeminiImagesResponseAdapter(response),
};

class GeminiImagesResponseAdapter
  implements LLMResponseAdapter<Gemini.Types.GenerateContentResponse>
{
  readonly provider = "gemini" as const;
  private readonly inner: LLMResponseAdapter<Gemini.Types.GenerateContentResponse>;
  private readonly created = Math.floor(Date.now() / 1000);
  constructor(private readonly response: Gemini.Types.GenerateContentResponse) {
    this.inner = geminiAdapterFactory.createResponseAdapter(response);
  }
  getId() {
    return this.inner.getId();
  }
  getModel() {
    return this.inner.getModel();
  }
  getText() {
    return this.inner.getText();
  }
  getToolCalls() {
    return [];
  }
  hasToolCalls() {
    return false;
  }
  getFinishReasons() {
    return this.inner.getFinishReasons();
  }
  getUsage() {
    const usage = this.response.usageMetadata;
    return {
      ...this.inner.getUsage(),
      usageUnavailable:
        usage?.promptTokenCount == null || usage?.candidatesTokenCount == null,
      costUnavailable: true,
    };
  }
  getLoggedResponse() {
    return this.response;
  }
  getOriginalResponse() {
    const data = (this.response.candidates ?? []).flatMap((candidate) =>
      (candidate.content?.parts ?? []).flatMap((part) =>
        "inlineData" in part && part.inlineData?.mimeType?.startsWith("image/")
          ? [{ b64_json: part.inlineData.data }]
          : [],
      ),
    );
    const usage = this.response.usageMetadata;
    return {
      created: this.created,
      data,
      usage_available: !this.getUsage().usageUnavailable,
      cost_available: false,
      // Captions and native usage are preserved as explicit extensions; neither
      // is mislabeled as a revised prompt or an OpenAI billing breakdown.
      gemini_text: this.getText(),
      gemini_usage_metadata: usage,
      ...(!this.getUsage().usageUnavailable && usage
        ? {
            usage: {
              input_tokens: usage.promptTokenCount,
              output_tokens:
                (usage.candidatesTokenCount ?? 0) +
                (usage.thoughtsTokenCount ?? 0),
              total_tokens:
                usage.totalTokenCount ??
                (usage.promptTokenCount ?? 0) +
                  (usage.candidatesTokenCount ?? 0) +
                  (usage.thoughtsTokenCount ?? 0),
            },
          }
        : {}),
    } as unknown as Gemini.Types.GenerateContentResponse &
      z.infer<typeof Azure.API.ImageGenerationResponseSchema>;
  }
  toRefusalResponse() {
    return { ...this.getOriginalResponse(), data: [] };
  }
}
