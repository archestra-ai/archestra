import { EmbeddingErrorCode, mapHttpStatusToEmbeddingError } from "@archestra/shared";
import { DrizzleQueryError } from "drizzle-orm/errors";
import {
  AzureEmbeddingError,
  GeminiEmbeddingError,
  OpenAIEmbeddingError,
} from "./embedding-clients";

const MAX_DEPTH = 5;

function isDimensionsMismatchError(error: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || !(error instanceof Error)) {
    return false;
  }

  if (error.message.toLowerCase().includes("dimensions")) {
    return true;
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause) {
    return isDimensionsMismatchError(cause, depth + 1);
  }

  return false;
}

export function classifyEmbeddingError(error: unknown): EmbeddingErrorCode {
  const isApiError =
    error instanceof AzureEmbeddingError ||
    error instanceof GeminiEmbeddingError ||
    error instanceof OpenAIEmbeddingError;

  const isLengthMismatchError =
    error instanceof Error &&
    error.message.match(/^Embedding API returned \d+ results for \d+ inputs$/);

  const isDBError = error instanceof DrizzleQueryError;

  if (isApiError) {
    if (
      error.status === 400 &&
      error.message.includes("the input length exceeds the context length")
    ) {
      return EmbeddingErrorCode.ContextTooLong;
    }
    return mapHttpStatusToEmbeddingError(error.status);
  }

  if (isLengthMismatchError) {
    return EmbeddingErrorCode.LengthMismatch;
  }

  if (isDBError && isDimensionsMismatchError(error)) {
    return EmbeddingErrorCode.DimensionsMismatch;
  }

  return EmbeddingErrorCode.Unknown;
}
