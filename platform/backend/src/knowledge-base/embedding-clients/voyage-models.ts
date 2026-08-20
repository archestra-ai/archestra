import type {
  ModelInputModality,
  SupportedEmbeddingDimension,
} from "@archestra/shared";

/**
 * The single source of truth for which Voyage AI models the KB supports for
 * embeddings, at what dimension, and over which of Voyage's two endpoints.
 * Both the embedding client (which models it will drive, and how) and model
 * discovery (which models it surfaces + how it tags their dimension and
 * modalities) read from this list, so they can never drift — the same pattern
 * as `cohere-models.ts` and `bedrock-models.ts`.
 *
 * Voyage publishes NO model-listing endpoint at all, so unlike Cohere there is
 * no live catalog to cross-check: this table is the whole catalog. A model
 * absent from it is not offered.
 */
interface VoyageEmbeddingModel {
  /** The model name as accepted by the API (e.g. "voyage-4"). */
  modelId: string;
  displayName: string;
  /**
   * The dimension the model produces unless `onRequestDimensions` overrides it.
   * Every current Voyage model defaults to 1024 — which is also the only
   * dimension Voyage offers that the KB has a `vector(N)` column for.
   */
  dimensions: SupportedEmbeddingDimension;
  /**
   * Output dimensions the model accepts on request via `output_dimension`, or
   * `undefined` when the dimension is fixed and the parameter is not offered
   * (the -2 family and multimodal-3).
   *
   * Voyage's flexible models accept 256/512/1024/2048; only 1024 is listed
   * because the other three have no backing `vector(N)` column in `kb_chunks`,
   * so `EmbeddingDimensionsSchema` rejects them before a request is ever built.
   * Adding a column for 2048 is all it would take to widen this.
   */
  onRequestDimensions?: readonly SupportedEmbeddingDimension[];
  /** Input modalities the KB embedding client can drive for this model. */
  inputModalities: readonly ModelInputModality[];
  /**
   * Image MIME types the model accepts. Only meaningful for the multimodal
   * models; anything else is a provider error that fails the document, so
   * connectors skip other formats at ingestion and the embedder at embed time.
   */
  acceptedImageMimeTypes?: readonly string[];
  /**
   * Which Voyage endpoint serves this model. The two are NOT interchangeable:
   * `/embeddings` takes `input[]` of plain strings and rejects the multimodal
   * model names, while `/multimodalembeddings` takes `inputs[].content[]` and
   * serves only the multimodal ones — text included.
   */
  endpoint: "embeddings" | "multimodalembeddings";
  /**
   * Per-input context limit, in the model's own tokens. Inputs are truncated
   * locally to a margin-reduced share of this before the call.
   */
  contextTokens: number;
  /**
   * Voyage's cap on the SUM of all tokens in one request — separate from, and
   * much smaller than, the per-input limit. Exceeding it is a hard 400 for the
   * whole batch, so the client packs batches against this budget rather than
   * simply counting inputs.
   */
  maxRequestTokens: number;
}

/**
 * Voyage's documented image formats for the multimodal Embed API. Cited as
 * PNG, JPEG, WEBP and GIF; `const` is not hoisted, so it is declared before
 * the table that references it.
 */
const VOYAGE_IMAGE_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

export const VOYAGE_EMBEDDING_MODELS: readonly VoyageEmbeddingModel[] = [
  {
    modelId: "voyage-4-large",
    displayName: "Voyage 4 Large",
    dimensions: 1024,
    onRequestDimensions: [1024],
    inputModalities: ["text"],
    endpoint: "embeddings",
    contextTokens: 32_000,
    maxRequestTokens: 120_000,
  },
  {
    modelId: "voyage-4",
    displayName: "Voyage 4",
    dimensions: 1024,
    onRequestDimensions: [1024],
    inputModalities: ["text"],
    endpoint: "embeddings",
    contextTokens: 32_000,
    maxRequestTokens: 320_000,
  },
  {
    modelId: "voyage-4-lite",
    displayName: "Voyage 4 Lite",
    dimensions: 1024,
    onRequestDimensions: [1024],
    inputModalities: ["text"],
    endpoint: "embeddings",
    contextTokens: 32_000,
    maxRequestTokens: 1_000_000,
  },
  {
    modelId: "voyage-code-4",
    displayName: "Voyage Code 4",
    dimensions: 1024,
    onRequestDimensions: [1024],
    inputModalities: ["text"],
    endpoint: "embeddings",
    contextTokens: 32_000,
    // Not published alongside the others; assume the smallest documented
    // budget rather than risk a 400 on a full batch.
    maxRequestTokens: 120_000,
  },
  {
    modelId: "voyage-finance-2",
    displayName: "Voyage Finance 2",
    dimensions: 1024,
    inputModalities: ["text"],
    endpoint: "embeddings",
    contextTokens: 32_000,
    maxRequestTokens: 120_000,
  },
  {
    modelId: "voyage-law-2",
    displayName: "Voyage Law 2",
    dimensions: 1024,
    inputModalities: ["text"],
    endpoint: "embeddings",
    contextTokens: 16_000,
    maxRequestTokens: 120_000,
  },
  {
    modelId: "voyage-3-large",
    displayName: "Voyage 3 Large",
    dimensions: 1024,
    onRequestDimensions: [1024],
    inputModalities: ["text"],
    endpoint: "embeddings",
    contextTokens: 32_000,
    maxRequestTokens: 120_000,
  },
  {
    modelId: "voyage-3.5",
    displayName: "Voyage 3.5",
    dimensions: 1024,
    onRequestDimensions: [1024],
    inputModalities: ["text"],
    endpoint: "embeddings",
    contextTokens: 32_000,
    maxRequestTokens: 320_000,
  },
  {
    modelId: "voyage-3.5-lite",
    displayName: "Voyage 3.5 Lite",
    dimensions: 1024,
    onRequestDimensions: [1024],
    inputModalities: ["text"],
    endpoint: "embeddings",
    contextTokens: 32_000,
    maxRequestTokens: 1_000_000,
  },
  {
    modelId: "voyage-code-3",
    displayName: "Voyage Code 3",
    dimensions: 1024,
    onRequestDimensions: [1024],
    inputModalities: ["text"],
    endpoint: "embeddings",
    contextTokens: 32_000,
    maxRequestTokens: 120_000,
  },
  {
    modelId: "voyage-multimodal-3.5",
    displayName: "Voyage Multimodal 3.5",
    dimensions: 1024,
    onRequestDimensions: [1024],
    inputModalities: ["text", "image"],
    acceptedImageMimeTypes: VOYAGE_IMAGE_MIME_TYPES,
    endpoint: "multimodalembeddings",
    contextTokens: 32_000,
    maxRequestTokens: 320_000,
  },
  {
    modelId: "voyage-multimodal-3",
    displayName: "Voyage Multimodal 3",
    dimensions: 1024,
    inputModalities: ["text", "image"],
    acceptedImageMimeTypes: VOYAGE_IMAGE_MIME_TYPES,
    endpoint: "multimodalembeddings",
    contextTokens: 32_000,
    maxRequestTokens: 320_000,
  },
];

/** Look up a KB-supported Voyage embedding model by its API name. */
export function findVoyageEmbeddingModel(
  modelId: string,
): VoyageEmbeddingModel | undefined {
  const normalized = modelId.toLowerCase();
  return VOYAGE_EMBEDDING_MODELS.find((model) => model.modelId === normalized);
}
