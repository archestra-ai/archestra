import { z } from "zod";
import type { LLMProvider, OpenAi } from "@/types";
import { ApiError, OpenAi as OpenAiSchemas } from "@/types";

type EmbeddingsProvider = LLMProvider<
  OpenAi.Types.EmbeddingRequest,
  OpenAi.Types.EmbeddingResponse,
  OpenAi.Types.ChatCompletionsRequest["messages"],
  never,
  OpenAi.Types.ChatCompletionsHeaders
>;

/** The SDK wire accepts both compact base64 and ordinary numeric vectors. */
export const EmbeddingWireResponseSchema =
  OpenAiSchemas.API.EmbeddingResponseSchema.extend({
    data: z.array(
      OpenAiSchemas.API.EmbeddingResponseSchema.shape.data.element.extend({
        embedding: z.union([z.array(z.number()), z.string()]),
      }),
    ),
  });

/** Preserve the caller's vector encoding while logging bounded numeric previews. */
export function withEmbeddingEncoding(
  provider: EmbeddingsProvider,
  encoding: "float" | "base64" = "float",
): EmbeddingsProvider {
  return {
    ...provider,
    createResponseAdapter(response) {
      const normalized = {
        ...response,
        data: response.data.map((item) => ({
          ...item,
          embedding: decodeVector(item.embedding),
        })),
      };
      const inner = provider.createResponseAdapter(normalized);
      const wire =
        encoding === "base64"
          ? {
              ...response,
              data: response.data.map((item) => ({
                ...item,
                embedding:
                  typeof item.embedding === "string"
                    ? item.embedding
                    : encodeVector(item.embedding),
              })),
            }
          : normalized;
      return {
        provider: inner.provider,
        getId: () => inner.getId(),
        getModel: () => inner.getModel(),
        getText: () => inner.getText(),
        getToolCalls: () => inner.getToolCalls(),
        hasToolCalls: () => inner.hasToolCalls(),
        getUsage: () => inner.getUsage(),
        getFinishReasons: () => inner.getFinishReasons(),
        getLoggedResponse: () => normalized,
        getOriginalResponse: () => wire as OpenAi.Types.EmbeddingResponse,
        toRefusalResponse: () => wire as OpenAi.Types.EmbeddingResponse,
      };
    },
  };
}

function decodeVector(vector: number[] | string): number[] {
  if (Array.isArray(vector)) return vector;
  const bytes = Buffer.from(vector, "base64");
  if (bytes.length % 4 !== 0)
    throw new ApiError(502, "Provider returned an invalid base64 embedding.");
  return Array.from({ length: bytes.length / 4 }, (_, index) =>
    bytes.readFloatLE(index * 4),
  );
}

function encodeVector(vector: number[]): string {
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => {
    bytes.writeFloatLE(value, index * 4);
  });
  return bytes.toString("base64");
}
