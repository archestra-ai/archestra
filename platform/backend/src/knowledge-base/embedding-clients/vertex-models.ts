import type {
  ModelInputModality,
  SupportedEmbeddingDimension,
} from "@archestra/shared";

/**
 * The single source of truth for the Vertex AI publisher embedding models the
 * KB supports beyond the Gemini-native ones: which they are, what they embed,
 * and at what dimension. The embedding client (which request shape it drives),
 * the modality/format gate, Vertex model discovery and model-sync all read
 * from this list, so they can never drift.
 *
 * These models predate the Gemini embedding family and are served ONLY through
 * Vertex AI's `:predict` endpoint with a per-modality instance shape
 * (`{text}` / `{image: {bytesBase64Encoded}}`) — the Gemini API does not list
 * them and the GenAI SDK's `embedContent` cannot express their instances, so
 * the client calls the prediction endpoint directly. Discovery is likewise
 * static: the Vertex model list is the Model Garden catalog, which the Gemini
 * catalog filter would drop these unbranded ids from, so the fetcher injects
 * and probes them by id instead.
 */
interface VertexMultimodalEmbeddingModel {
  /** The publisher model id (e.g. "multimodalembedding@001"). */
  modelId: string;
  displayName: string;
  /** The model's native (and default) output dimension. */
  dimensions: SupportedEmbeddingDimension;
  /**
   * Output dimensions the model accepts via the predict call's `dimension`
   * parameter. Only 1408 intersects the KB's storable dimensions, so it is
   * the only dimension this model is ever configured at in practice.
   */
  onRequestDimensions: readonly number[];
  /** Input modalities the KB embedding client can drive for this model. */
  inputModalities: readonly ModelInputModality[];
  /**
   * The endpoint accepts BMP, GIF, JPG, PNG and WebP. Google documentation
   * omits WebP, but a real `multimodalembedding@001` predict request confirms
   * support. The instance carries raw bytes with no declared MIME type, so any
   * other format reaching the client is a provider error that fails the
   * document; connectors skip it at ingestion and embedding time.
   */
  acceptedImageMimeTypes: readonly string[];
  /**
   * Once a request is accepted, the model shortens text past this token limit
   * internally. The API schema's separate byte cap is enforced first.
   */
  maxInputTextTokens: number;
  /**
   * Hard UTF-8 payload cap applied before model-side token truncation. Vertex's
   * error calls this a character limit, but the endpoint enforces bytes.
   */
  maxInputTextBytes: number;
  /** The model's documented per-image size cap (base64-decoded bytes). */
  maxImageBytes: number;
}

export const VERTEX_MULTIMODAL_EMBEDDING_MODELS: readonly VertexMultimodalEmbeddingModel[] =
  [
    {
      modelId: "multimodalembedding@001",
      displayName: "Multimodal Embedding",
      dimensions: 1408,
      onRequestDimensions: [128, 256, 512, 1408],
      inputModalities: ["text", "image"],
      acceptedImageMimeTypes: [
        "image/png",
        "image/jpeg",
        "image/bmp",
        "image/gif",
        "image/webp",
      ],
      maxInputTextTokens: 32,
      maxInputTextBytes: 1024,
      maxImageBytes: 20 * 1024 * 1024,
    },
  ];

/**
 * Look up a supported Vertex multimodal embedding model by id, tolerating the
 * resource-name prefixes the Vertex catalog returns
 * ("publishers/google/models/multimodalembedding@001") and the GenAI "models/"
 * prefix. Returns `undefined` for an unsupported model.
 */
export function findVertexMultimodalEmbeddingModel(
  modelId: string,
): VertexMultimodalEmbeddingModel | undefined {
  const normalized = modelId
    .replace(/^publishers\/google\/models\//, "")
    .replace(/^models\//, "");
  return VERTEX_MULTIMODAL_EMBEDDING_MODELS.find(
    (m) => m.modelId === normalized,
  );
}
