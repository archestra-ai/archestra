/**
 * Gemini Embeddings Adapter
 *
 * Gemini's native embedding API (`embedContent`) is not OpenAI-compatible, so
 * this adapter translates an OpenAI-shaped embeddings request into a Gemini
 * `embedContent` call and maps the result back into the OpenAI embeddings
 * response shape. This keeps the external contract identical to the OpenAI
 * embeddings endpoint while routing to Gemini under the hood.
 *
 * The request/response/stream wrappers are shared with the OpenAI-compatible
 * embeddings adapter (the external wire shape is the same); only `execute`
 * differs, calling the Google GenAI SDK.
 *
 * @see backend/src/knowledge-base/embedding-clients/gemini.ts for the
 *      knowledge-base equivalent this mirrors.
 */

import type {
  ArchestraInternalErrorCode,
  SupportedProvider,
} from "@archestra/shared";
import type { GoogleGenAI } from "@google/genai";
import { get } from "lodash-es";
import {
  createGoogleGenAIClient,
  isVertexAiEnabled,
} from "@/clients/gemini-client";
import config from "@/config";
import type {
  CreateClientOptions,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  OpenAi,
} from "@/types";
import {
  OpenAIEmbeddingRequestAdapter,
  OpenAIEmbeddingResponseAdapter,
  OpenAIEmbeddingStreamAdapter,
} from "./openai";

type OpenAiEmbeddingRequest = OpenAi.Types.EmbeddingRequest;
type OpenAiEmbeddingResponse = OpenAi.Types.EmbeddingResponse;
type OpenAiMessages = OpenAi.Types.ChatCompletionsRequest["messages"];
type OpenAiHeaders = OpenAi.Types.ChatCompletionsHeaders;

const GEMINI_PROVIDER: SupportedProvider = "gemini";

export const geminiEmbeddingsAdapterFactory: LLMProvider<
  OpenAiEmbeddingRequest,
  OpenAiEmbeddingResponse,
  OpenAiMessages,
  never,
  OpenAiHeaders
> = {
  provider: GEMINI_PROVIDER,
  interactionType: "gemini:embeddings",

  createRequestAdapter(
    request: OpenAiEmbeddingRequest,
  ): LLMRequestAdapter<OpenAiEmbeddingRequest, OpenAiMessages> {
    return new OpenAIEmbeddingRequestAdapter(request, GEMINI_PROVIDER);
  },

  createResponseAdapter(
    response: OpenAiEmbeddingResponse,
  ): LLMResponseAdapter<OpenAiEmbeddingResponse> {
    return new OpenAIEmbeddingResponseAdapter(response, GEMINI_PROVIDER);
  },

  createStreamAdapter(): LLMStreamAdapter<never, OpenAiEmbeddingResponse> {
    return new OpenAIEmbeddingStreamAdapter(GEMINI_PROVIDER);
  },

  extractApiKey(headers: OpenAiHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.gemini.baseUrl;
  },

  spanName: "embedding",

  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): GoogleGenAI {
    return createGoogleGenAIClient(
      apiKey,
      "[GeminiEmbeddingProxy]",
      options.baseUrl,
    );
  },

  async execute(
    client: unknown,
    request: OpenAiEmbeddingRequest,
  ): Promise<OpenAiEmbeddingResponse> {
    const genAI = client as GoogleGenAI;
    const inputs = Array.isArray(request.input)
      ? request.input
      : [request.input];

    const response = await genAI.models.embedContent({
      model: getGeminiEmbeddingModelId(request.model),
      contents: inputs,
      config: request.dimensions
        ? { outputDimensionality: request.dimensions }
        : undefined,
    });

    const embeddings = response.embeddings?.map((item) => item.values ?? []);
    if (!embeddings?.length || embeddings.length !== inputs.length) {
      throw new Error(
        "Gemini embedding response did not include embeddings for each input",
      );
    }
    if (embeddings.some((embedding) => embedding.length === 0)) {
      throw new Error(
        "Gemini embedding response did not include embedding values",
      );
    }

    // Gemini's native embedding API does not report token usage.
    return {
      object: "list",
      data: embeddings.map((embedding, index) => ({
        object: "embedding",
        embedding,
        index,
      })),
      model: request.model,
      usage: { prompt_tokens: 0, total_tokens: 0 },
    };
  },

  async executeStream(): Promise<AsyncIterable<never>> {
    throw new Error("Gemini embeddings do not support streaming.");
  },

  extractInternalCode(): ArchestraInternalErrorCode | undefined {
    return undefined;
  },

  extractErrorMessage(error: unknown): string {
    const message = get(error, "message");
    if (typeof message === "string") {
      return message;
    }
    return error instanceof Error ? error.message : "Internal server error";
  },
};

// ===== Internal helpers =====

/**
 * Normalize a Gemini embedding model id. API-key mode expects a `models/` prefix
 * (added if missing); Vertex AI mode expects the bare id (prefix stripped).
 */
function getGeminiEmbeddingModelId(model: string): string {
  if (isVertexAiEnabled()) {
    return model.replace(/^models\//, "");
  }
  return model.startsWith("models/") ? model : `models/${model}`;
}
