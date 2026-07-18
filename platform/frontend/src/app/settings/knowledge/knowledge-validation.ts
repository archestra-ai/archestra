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
