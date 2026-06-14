import { z } from "zod";
import { ChatErrorCode, mapHttpStatusToChatError } from "./chat-error";

export const EmbeddingErrorCode = {
  ...ChatErrorCode,
  /** Embedding API returned a different number of results than inputs */
  LengthMismatch: "length_mismatch",
  /** Stored embedding dimensions don't match the database vector column */
  DimensionsMismatch: "dimensions_mismatch",
} as const;
export type EmbeddingErrorCode =
  (typeof EmbeddingErrorCode)[keyof typeof EmbeddingErrorCode];

export const EmbeddingErrorCodeSchema = z.nativeEnum(EmbeddingErrorCode);

/**
 * Maps an HTTP status code to a normalized EmbeddingErrorCode.
 * Delegates to mapHttpStatusToChatError — ChatErrorCode is a subset of
 * EmbeddingErrorCode so the return value is directly assignable.
 */
export function mapHttpStatusToEmbeddingError(
  status: number | undefined,
): EmbeddingErrorCode {
  return mapHttpStatusToChatError(status);
}

/** User-facing messages shown in the Knowledge Base UI (e.g. file status tooltips) */
export const KbEmbeddingErrorMessages: Record<EmbeddingErrorCode, string> = {
  [EmbeddingErrorCode.Authentication]:
    "Unauthorized. Check your embedding API key.",
  [EmbeddingErrorCode.PermissionDenied]:
    "Your API key doesn't have permission for this embedding model.",
  [EmbeddingErrorCode.InvalidRequest]:
    "Invalid embedding request. Check your model configuration.",
  [EmbeddingErrorCode.NotFound]:
    "Embedding model not found. Check your model configuration.",
  [EmbeddingErrorCode.ContextTooLong]:
    "File content is too large to embed with the configured model.",
  [EmbeddingErrorCode.RateLimit]: "Embedding API rate limit exceeded.",
  [EmbeddingErrorCode.ServerError]:
    "The embedding provider experienced an error.",
  [EmbeddingErrorCode.LengthMismatch]:
    "An internal error occurred during embedding.",
  [EmbeddingErrorCode.DimensionsMismatch]:
    "Embedding dimensions don't match the database. Re-embed all documents after updating your model configuration.",
  [EmbeddingErrorCode.ContentFiltered]: "An unexpected error occurred.",
  [EmbeddingErrorCode.NetworkError]: "An unexpected error occurred.",
  [EmbeddingErrorCode.Unknown]: "An unexpected error occurred.",
};
