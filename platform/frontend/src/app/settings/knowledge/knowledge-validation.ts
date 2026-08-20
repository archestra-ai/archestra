/**
 * Backend `internal_code` values the save route sets when validation fails, so
 * the page can show the message inline on the right field. Keep in sync with the
 * backend (backend/src/routes/organization.ts).
 */
export const EMBEDDING_VALIDATION_FAILED_CODE = "embedding_validation_failed";
export const RERANKER_VALIDATION_FAILED_CODE = "reranker_validation_failed";
export const OCR_VALIDATION_FAILED_CODE = "ocr_validation_failed";

export interface KnowledgeSettingsFieldError {
  field: "embedding" | "reranker" | "ocr";
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
  if (code === OCR_VALIDATION_FAILED_CODE) {
    return { field: "ocr", message };
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
 * the embedding first, then the reranker, then OCR — so a failure on one field
 * means every earlier field passed and every later field was never reached.
 * A non-field error (e.g. a 500) leaves all sections untested.
 */
export function saveResultStatuses(params: {
  error: unknown;
  embeddingConfigured: boolean;
  rerankerConfigured: boolean;
  ocrConfigured: boolean;
}): { embedding: SectionStatus; reranker: SectionStatus; ocr: SectionStatus } {
  const { error, embeddingConfigured, rerankerConfigured, ocrConfigured } =
    params;
  const connectedIfConfigured = (configured: boolean): SectionStatus => ({
    status: configured ? "connected" : "untested",
    error: null,
  });
  const untested: SectionStatus = { status: "untested", error: null };

  if (!error) {
    return {
      embedding: connectedIfConfigured(embeddingConfigured),
      reranker: connectedIfConfigured(rerankerConfigured),
      ocr: connectedIfConfigured(ocrConfigured),
    };
  }

  const fieldError = knowledgeSettingsFieldError(error);
  if (fieldError?.field === "embedding") {
    return {
      embedding: { status: "failed", error: fieldError.message },
      reranker: untested,
      ocr: untested,
    };
  }
  if (fieldError?.field === "reranker") {
    return {
      embedding: connectedIfConfigured(embeddingConfigured),
      reranker: { status: "failed", error: fieldError.message },
      ocr: untested,
    };
  }
  if (fieldError?.field === "ocr") {
    return {
      embedding: connectedIfConfigured(embeddingConfigured),
      reranker: connectedIfConfigured(rerankerConfigured),
      ocr: { status: "failed", error: fieldError.message },
    };
  }
  return { embedding: untested, reranker: untested, ocr: untested };
}
