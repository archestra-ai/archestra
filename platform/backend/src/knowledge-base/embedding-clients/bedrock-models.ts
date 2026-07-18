import type { SupportedEmbeddingDimension } from "@archestra/shared";

/**
 * The single source of truth for which AWS Bedrock models the KB supports for
 * embeddings, and at what dimension. Both the embedding client (which models it
 * will drive) and model discovery (which models it surfaces + how it tags their
 * dimension) read from this list, so they can never drift.
 *
 * Two buckets of Bedrock embedding models exist, and only one needs injecting:
 *   - `staticInject: true` — on-demand-only models that have NO inference
 *     profile (Amazon Titan). Discovery's `/inference-profiles` call never
 *     returns them, so they are injected into the model list. Their one weakness
 *     — being offered in a region/account that lacks them — is caught by the real
 *     embed call in validate-on-save.
 *   - `staticInject: false` — models that DO have an inference profile (Cohere on
 *     Bedrock). Discovery already fetches them region-accurately in the call it
 *     makes; they only need classifying (tag + keep) instead of dropping. Adding
 *     one here is the entire "Cohere fast-follow": it surfaces from the existing
 *     call the moment the client supports it.
 */
interface BedrockEmbeddingModel {
  /** The foundation-model id (e.g. "amazon.titan-embed-text-v2:0"). */
  modelId: string;
  displayName: string;
  dimensions: SupportedEmbeddingDimension;
  /** Inject into the model list (true) vs discover from inference profiles (false). */
  staticInject: boolean;
  /** Whether the model accepts an on-request output dimension (Titan v2 does; v1 is fixed). */
  supportsDimensionsParam: boolean;
}

export const BEDROCK_EMBEDDING_MODELS: readonly BedrockEmbeddingModel[] = [
  {
    modelId: "amazon.titan-embed-text-v1",
    displayName: "Amazon Titan Text Embeddings V1",
    dimensions: 1536,
    staticInject: true,
    supportsDimensionsParam: false,
  },
  {
    modelId: "amazon.titan-embed-text-v2:0",
    displayName: "Amazon Titan Text Embeddings V2",
    dimensions: 1024,
    staticInject: true,
    supportsDimensionsParam: true,
  },
  // Cohere-on-Bedrock fast-follow — these HAVE inference profiles, so they are
  // discovered (staticInject: false), not injected. Uncommenting here (plus
  // giving the client a Cohere request/response path) surfaces them from the
  // existing /inference-profiles call:
  // { modelId: "cohere.embed-english-v3", displayName: "Cohere Embed English v3", dimensions: 1024, staticInject: false, supportsDimensionsParam: false },
  // { modelId: "cohere.embed-multilingual-v3", displayName: "Cohere Embed Multilingual v3", dimensions: 1024, staticInject: false, supportsDimensionsParam: false },
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
