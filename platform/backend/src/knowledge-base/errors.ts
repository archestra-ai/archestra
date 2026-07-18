/**
 * Typed knowledge-base failure taxonomy.
 *
 * Every diagnosable KB embedding/query failure is a `KnowledgeBaseError` carrying
 * a `userMessage` that names the likely cause and where to fix it. Classification
 * happens at the seam that knows the facts (credential resolution, the embedding
 * adapters, the dispatcher's response validation, the storage boundary); the MCP
 * query handler and the ingestion path present the same messages via the single
 * mapper `toKnowledgeBaseUserMessage`. A generic catch-all remains only for
 * genuinely-unexpected faults.
 */
export abstract class KnowledgeBaseError extends Error {
  /** A user-facing, actionable message. Never leaks internal detail. */
  abstract readonly userMessage: string;
}

/**
 * The configured provider has no embedding path (it does not support embeddings,
 * or not in an OpenAI-compatible shape). The KB must reject it rather than send a
 * doomed request down the OpenAI-compatible path (spec item 2).
 */
export class UnsupportedEmbeddingProviderError extends KnowledgeBaseError {
  readonly userMessage: string;

  constructor(
    public readonly provider: string,
    public readonly model: string,
  ) {
    super(
      `Provider "${provider}" does not support embeddings (model "${model}")`,
    );
    this.name = "UnsupportedEmbeddingProviderError";
    this.userMessage = `The configured embedding provider "${provider}" (model "${model}") does not support embeddings, so knowledge search cannot run.`;
  }
}

/**
 * The embedding call returned a response the KB cannot use — missing/short data,
 * a non-array payload, non-finite values, a count that doesn't match the inputs,
 * or vectors whose length differs from the configured dimension (spec item 3).
 */
export class UnusableEmbeddingResponseError extends KnowledgeBaseError {
  readonly userMessage: string;

  constructor(
    public readonly provider: string,
    public readonly model: string,
    public readonly reason: string,
  ) {
    super(`Unusable embedding response from ${provider}/${model}: ${reason}`);
    this.name = "UnusableEmbeddingResponseError";
    this.userMessage =
      `The embedding provider "${provider}" (model "${model}") returned a response the knowledge base ` +
      `could not use (${reason}). This usually means the selected model is not an embedding model or is ` +
      `misconfigured.`;
  }
}

/**
 * The embedding provider errored or timed out at query/ingestion time — the
 * endpoint is unreachable, or the model is not loaded / is misnamed, even though
 * earlier calls may have succeeded (spec item 6).
 *
 * @public — part of the error taxonomy; produced by `normalizeEmbeddingError`
 * and asserted in tests, so it has no direct in-module importer.
 */
export class EmbeddingProviderUnreachableError extends KnowledgeBaseError {
  readonly userMessage: string;

  constructor(
    public readonly provider: string,
    public readonly model: string,
    public readonly reason: string,
  ) {
    super(`Embedding provider ${provider}/${model} unreachable: ${reason}`);
    this.name = "EmbeddingProviderUnreachableError";
    this.userMessage = `The embedding provider "${provider}" (model "${model}") could not be reached (${reason}).`;
  }
}

/**
 * The configured embedding dimension differs from what the documents were
 * ingested with (or is not a supported size), so the vector search cannot run
 * (spec item 6). Never surfaces a raw pgvector/SQL error.
 */
export class EmbeddingDimensionMismatchError extends KnowledgeBaseError {
  readonly userMessage: string;

  constructor(
    public readonly model: string,
    public readonly configuredDimension: number,
    public readonly ingestedDimensions: number[],
  ) {
    super(
      `Embedding dimension mismatch for ${model}: configured ${configuredDimension}, ingested ${ingestedDimensions.join(", ")}`,
    );
    this.name = "EmbeddingDimensionMismatchError";
    const ingested =
      ingestedDimensions.length > 0
        ? `the documents were embedded at ${ingestedDimensions.join(" / ")} dimensions`
        : "that dimension has no backing storage";
    this.userMessage =
      `The configured embedding model "${model}" produces ${configuredDimension}-dimension vectors, but ` +
      `${ingested}. Knowledge search cannot run until the dimensions match — fix the embedding model and ` +
      `re-ingest the documents.`;
  }
}

/**
 * The embedding configuration is set but cannot be resolved — e.g. a stored
 * credential fails to decrypt (spec item 6).
 */
export class EmbeddingConfigUnresolvableError extends KnowledgeBaseError {
  readonly userMessage =
    "The embedding configuration could not be read — its stored credential may be invalid or could not be " +
    "decrypted. Reconfigure the embedding model.";

  constructor() {
    super("Embedding configuration could not be resolved");
    this.name = "EmbeddingConfigUnresolvableError";
  }
}

/**
 * The reranker configuration is set but cannot be resolved — e.g. a stored
 * credential fails to decrypt (spec item 6). Non-fatal at query time (reranking
 * degrades); surfaced at save time.
 */
export class RerankerConfigUnresolvableError extends KnowledgeBaseError {
  readonly userMessage =
    "The reranker configuration could not be read — its stored credential may be invalid or could not be " +
    "decrypted. Reconfigure the reranker, or clear it.";

  constructor() {
    super("Reranker configuration could not be resolved");
    this.name = "RerankerConfigUnresolvableError";
  }
}

/**
 * The single safe mapper: a `KnowledgeBaseError` yields its actionable
 * `userMessage`; anything else yields `undefined` so the caller falls back to its
 * generic message (never leaking internal detail). Used by both the query handler
 * and ingestion so messages never drift.
 */
export function toKnowledgeBaseUserMessage(error: unknown): string | undefined {
  return error instanceof KnowledgeBaseError ? error.userMessage : undefined;
}

/**
 * Normalize a raw embedding-call failure (a provider SDK error, a network error,
 * or an already-typed `KnowledgeBaseError`) into the taxonomy, attaching
 * provider/model context. Already-typed errors pass through unchanged.
 */
export function normalizeEmbeddingError(
  error: unknown,
  context: { provider: string; model: string },
): KnowledgeBaseError {
  if (error instanceof KnowledgeBaseError) {
    return error;
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new EmbeddingProviderUnreachableError(
    context.provider,
    context.model,
    reason,
  );
}
