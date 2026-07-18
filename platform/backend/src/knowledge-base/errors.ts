/**
 * Typed knowledge-base failure taxonomy.
 *
 * Every diagnosable KB embedding/query failure is a `KnowledgeBaseError` carrying
 * a `userMessage` that names the likely cause and where to fix it. Classification
 * happens at the seam that knows the facts (credential resolution, the embedding
 * adapters, the dispatcher's response validation, the storage boundary); the MCP
 * query handler and the ingestion path present the same messages. A generic
 * catch-all remains only for genuinely-unexpected faults.
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
    this.userMessage =
      `The configured embedding provider "${provider}" does not support embeddings, ` +
      `so knowledge search cannot run. Select a supported embedding model in Settings → Knowledge.`;
  }
}
