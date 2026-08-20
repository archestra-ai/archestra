import type {
  ModelInputModality,
  SupportedEmbeddingDimension,
} from "@archestra/shared";

/**
 * The single source of truth for which Cohere (direct API) models the KB
 * supports for embeddings, and at what dimension. Both the embedding client
 * (which models it will drive, and how) and model discovery (which embed
 * models it surfaces + how it tags their dimension and modalities) read from
 * this list, so they can never drift — the same pattern as `bedrock-models.ts`.
 *
 * Cohere's `/v2/models` does list embed models, but it reports neither
 * dimensions nor modalities, so an embed model that is not in this table is
 * deliberately NOT offered: surfacing it would leave the dimension unset and
 * the modality gate guessing.
 */
interface CohereEmbeddingModel {
  /** The model name as accepted by `/v2/embed` (e.g. "embed-v4.0"). */
  modelId: string;
  displayName: string;
  /** The dimension the model produces unless `onRequestDimensions` overrides it. */
  dimensions: SupportedEmbeddingDimension;
  /**
   * Output dimensions the model accepts on request via `output_dimension`, or
   * `undefined` when the dimension is fixed and the model rejects the
   * parameter (the v3 family).
   */
  onRequestDimensions?: readonly number[];
  /** Input modalities the KB embedding client can drive for this model. */
  inputModalities: readonly ModelInputModality[];
  /**
   * Image MIME types the model accepts. Cohere documents JPEG/PNG/WebP/GIF for
   * every image-capable embed model; anything else is an opaque 400, so
   * connectors skip other formats at ingestion and the embedder at embed time.
   */
  acceptedImageMimeTypes?: readonly string[];
  /**
   * How the client sends inputs:
   *   - "inputs": the v4 mixed-content request (`inputs[].content[]`, text and
   *     images interleaved in one call, up to 96 inputs);
   *   - "texts-and-images": the v3 request — `texts[]` batched, and exactly
   *     ONE image per call under `input_type: "image"`.
   */
  requestShape: "inputs" | "texts-and-images";
}

/**
 * Cohere's documented image formats for the Embed API (`images` must be
 * "image/jpeg, image/png, image/webp, or image/gif"). `const` is not hoisted,
 * so it is declared before the table that references it.
 */
const COHERE_IMAGE_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

export const COHERE_EMBEDDING_MODELS: readonly CohereEmbeddingModel[] = [
  {
    modelId: "embed-v4.0",
    displayName: "Cohere Embed v4",
    dimensions: 1536,
    onRequestDimensions: [256, 512, 1024, 1536],
    inputModalities: ["text", "image"],
    acceptedImageMimeTypes: COHERE_IMAGE_MIME_TYPES,
    requestShape: "inputs",
  },
  {
    modelId: "embed-english-v3.0",
    displayName: "Cohere Embed English v3",
    dimensions: 1024,
    inputModalities: ["text", "image"],
    acceptedImageMimeTypes: COHERE_IMAGE_MIME_TYPES,
    requestShape: "texts-and-images",
  },
  {
    modelId: "embed-multilingual-v3.0",
    displayName: "Cohere Embed Multilingual v3",
    dimensions: 1024,
    inputModalities: ["text", "image"],
    acceptedImageMimeTypes: COHERE_IMAGE_MIME_TYPES,
    requestShape: "texts-and-images",
  },
  {
    modelId: "embed-english-light-v3.0",
    displayName: "Cohere Embed English Light v3",
    dimensions: 384,
    inputModalities: ["text", "image"],
    acceptedImageMimeTypes: COHERE_IMAGE_MIME_TYPES,
    requestShape: "texts-and-images",
  },
  {
    modelId: "embed-multilingual-light-v3.0",
    displayName: "Cohere Embed Multilingual Light v3",
    dimensions: 384,
    inputModalities: ["text", "image"],
    acceptedImageMimeTypes: COHERE_IMAGE_MIME_TYPES,
    requestShape: "texts-and-images",
  },
];

/** Look up a KB-supported Cohere embedding model by its API name. */
export function findCohereEmbeddingModel(
  modelId: string,
): CohereEmbeddingModel | undefined {
  const normalized = modelId.toLowerCase();
  return COHERE_EMBEDDING_MODELS.find((model) => model.modelId === normalized);
}
