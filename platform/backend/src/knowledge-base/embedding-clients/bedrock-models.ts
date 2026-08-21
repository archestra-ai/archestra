import type {
  ModelInputModality,
  SupportedEmbeddingDimension,
} from "@archestra/shared";

/**
 * The single source of truth for which AWS Bedrock models the KB supports for
 * embeddings, and at what dimension. Both the embedding client (which models it
 * will drive) and model discovery (which models it surfaces + how it tags their
 * dimension) read from this list, so they can never drift.
 *
 * AWS publishes NO system inference profiles for embedding models (every
 * cataloged model's card lists Geo/Global inference IDs as "Not supported"),
 * so discovery's `/inference-profiles` call never returns them and its
 * ListFoundationModels fallback filters to TEXT-output models. Every entry is
 * therefore `staticInject: true`: injected into the model list by id, which is
 * exactly how these on-demand models are invoked. The one weakness — being
 * offered in a region/account that lacks the model — is caught by the real
 * embed call in validate-on-save. `findBedrockEmbeddingModel` still tolerates a
 * region-prefixed id, so if AWS ever ships embedding inference profiles the
 * profile path classifies them instead of dropping them (the profile id would
 * then be listed alongside the injected bare id — both are invokable).
 */
interface BedrockEmbeddingModel {
  /** The foundation-model id (e.g. "amazon.titan-embed-text-v2:0"). */
  modelId: string;
  displayName: string;
  dimensions: SupportedEmbeddingDimension;
  /** Inject into the model list (true) vs discover from inference profiles (false). */
  staticInject: boolean;
  /**
   * Output dimensions the model accepts on request, or `undefined` when the
   * dimension is fixed and the model rejects the parameter (Titan text v1,
   * Cohere). Titan text v2 takes 256/512/1024; Titan Multimodal G1 takes
   * 256/384/1024.
   */
  onRequestDimensions?: readonly number[];
  /** Input modalities the KB embedding client can drive for this model. */
  inputModalities: readonly ModelInputModality[];
  /**
   * The model's hard per-request text token limit, or `undefined` when it is
   * large enough that chunk-sized inputs never hit it (Titan text v1/v2 take
   * 8192) or the request handles overflow itself (Cohere via `truncate`).
   * The embedding client truncates text inputs to fit — the model REJECTS
   * over-limit input with a ValidationException rather than truncating.
   */
  maxInputTextTokens?: number;
  /**
   * The request schema's hard per-text CHARACTER cap, or `undefined` when
   * there is none. Bedrock's Cohere schema rejects any `texts` entry over
   * 2048 characters ("Malformed input request: expected maxLength: 2048")
   * BEFORE the token-level `truncate` parameter ever applies, so the
   * embedding client must clamp texts to this cap client-side.
   */
  maxInputTextChars?: number;
  /**
   * Image MIME types the model accepts, for models with an image modality.
   * Live InvokeModel probes confirm JPEG/PNG/WebP/GIF for Titan Multimodal G1
   * and both Cohere Embed v3 models. AWS documentation lists a narrower subset,
   * so this table records observed endpoint behavior rather than pre-filtering
   * inputs the models actually accept.
   */
  acceptedImageMimeTypes?: readonly string[];
}

const BEDROCK_MULTIMODAL_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export const BEDROCK_EMBEDDING_MODELS: readonly BedrockEmbeddingModel[] = [
  {
    modelId: "amazon.titan-embed-text-v1",
    displayName: "Amazon Titan Text Embeddings V1",
    dimensions: 1536,
    staticInject: true,
    inputModalities: ["text"],
  },
  {
    modelId: "amazon.titan-embed-text-v2:0",
    displayName: "Amazon Titan Text Embeddings V2",
    dimensions: 1024,
    staticInject: true,
    onRequestDimensions: [256, 512, 1024],
    inputModalities: ["text"],
  },
  {
    modelId: "amazon.titan-embed-image-v1",
    displayName: "Amazon Titan Multimodal Embeddings G1",
    dimensions: 1024,
    staticInject: true,
    onRequestDimensions: [256, 384, 1024],
    inputModalities: ["text", "image"],
    maxInputTextTokens: 256,
    acceptedImageMimeTypes: BEDROCK_MULTIMODAL_IMAGE_MIME_TYPES,
  },
  {
    modelId: "cohere.embed-english-v3",
    displayName: "Cohere Embed English v3",
    dimensions: 1024,
    staticInject: true,
    inputModalities: ["text", "image"],
    maxInputTextChars: 2048,
    acceptedImageMimeTypes: BEDROCK_MULTIMODAL_IMAGE_MIME_TYPES,
  },
  {
    modelId: "cohere.embed-multilingual-v3",
    displayName: "Cohere Embed Multilingual v3",
    dimensions: 1024,
    staticInject: true,
    inputModalities: ["text", "image"],
    maxInputTextChars: 2048,
    acceptedImageMimeTypes: BEDROCK_MULTIMODAL_IMAGE_MIME_TYPES,
  },
];

/**
 * Look up a supported Bedrock embedding model by foundation-model id, tolerating
 * a cross-region inference-profile prefix (e.g. "eu.cohere.embed-v4:0"). Returns
 * `undefined` for an unsupported model.
 */
export function findBedrockEmbeddingModel(
  modelId: string,
): BedrockEmbeddingModel | undefined {
  const normalized = modelId.replace(/^(us|eu|ap|global)\./, "");
  return BEDROCK_EMBEDDING_MODELS.find(
    (m) => m.modelId === modelId || m.modelId === normalized,
  );
}
