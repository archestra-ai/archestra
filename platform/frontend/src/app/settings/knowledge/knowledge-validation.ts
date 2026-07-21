/**
 * Backend `internal_code` values the save route sets when validation fails, so
 * the page can show the message inline on the right field. Keep in sync with the
 * backend (backend/src/routes/organization.ts).
 */
export const EMBEDDING_VALIDATION_FAILED_CODE = "embedding_validation_failed";
export const RERANKER_VALIDATION_FAILED_CODE = "reranker_validation_failed";

export interface KnowledgeSettingsFieldError {
  field: "embedding" | "reranker";
  message: string;
}

/**
 * Map a Knowledge-settings save error to the field it belongs to, from the
 * backend `internal_code` carried on the thrown error. Returns `null` for any
 * other error (which the query hook toasts generically).
 */
export function knowledgeSettingsFieldError(
  error: unknown,
): KnowledgeSettingsFieldError | null {
  const code = (error as { internalCode?: string } | null)?.internalCode;
  const message =
    error instanceof Error && error.message
      ? error.message
      : "Validation failed.";

  if (code === EMBEDDING_VALIDATION_FAILED_CODE) {
    return { field: "embedding", message };
  }
  if (code === RERANKER_VALIDATION_FAILED_CODE) {
    return { field: "reranker", message };
  }
  return null;
}

/** The connection-check state shown per configuration section. */
export type ConnectionStatus = "untested" | "testing" | "connected" | "failed";

export interface SectionStatus {
  status: ConnectionStatus;
  error: string | null;
}

/**
 * Derive each section's connection status from a save's outcome. Save validates
 * the embedding first, then the reranker, so an embedding failure means the
 * reranker was never reached, and a reranker failure means the embedding passed.
 * A non-field error (e.g. a 500) leaves both untested.
 */
export function saveResultStatuses(params: {
  error: unknown;
  embeddingConfigured: boolean;
  rerankerConfigured: boolean;
}): { embedding: SectionStatus; reranker: SectionStatus } {
  const { error, embeddingConfigured, rerankerConfigured } = params;
  const connectedIfConfigured = (configured: boolean): SectionStatus => ({
    status: configured ? "connected" : "untested",
    error: null,
  });

  if (!error) {
    return {
      embedding: connectedIfConfigured(embeddingConfigured),
      reranker: connectedIfConfigured(rerankerConfigured),
    };
  }

  const fieldError = knowledgeSettingsFieldError(error);
  if (fieldError?.field === "embedding") {
    return {
      embedding: { status: "failed", error: fieldError.message },
      reranker: { status: "untested", error: null },
    };
  }
  if (fieldError?.field === "reranker") {
    return {
      embedding: connectedIfConfigured(embeddingConfigured),
      reranker: { status: "failed", error: fieldError.message },
    };
  }
  return {
    embedding: { status: "untested", error: null },
    reranker: { status: "untested", error: null },
  };
}
