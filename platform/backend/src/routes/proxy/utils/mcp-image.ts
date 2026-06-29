export type McpImageBlock = {
  type: "image";
  data: string;
  mimeType?: string;
};

/**
 * Check if item is an MCP image block.
 */
export function isMcpImageBlock(item: unknown): item is McpImageBlock {
  if (typeof item !== "object" || item === null) return false;
  const candidate = item as Record<string, unknown>;
  if (candidate.type !== "image") return false;
  return typeof candidate.data === "string";
}

/**
 * Check if content contains image blocks (defaults to MCP image blocks).
 */
export function hasImageContent(
  content: unknown,
  isImageBlock: (item: unknown) => boolean = isMcpImageBlock,
): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((item) => isImageBlock(item));
}

/**
 * Models that are known to NOT support image/vision inputs.
 * This is a blocklist approach - models not in this list are assumed to support images.
 *
 * Reasoning models (o1, o3) don't support images.
 * Most modern GPT-4 models support vision.
 */
const MODELS_WITHOUT_IMAGE_SUPPORT = [
  // OpenAI reasoning models
  "o1-preview",
  "o1-mini",
  "o1",
  "o3-mini",
  "o3",
  // Legacy models that don't support vision
  "gpt-3.5-turbo",
  "gpt-3.5-turbo-0125",
  "gpt-3.5-turbo-1106",
  "gpt-3.5-turbo-16k",
];

/**
 * Maximum image size in bytes (base64-decoded) before stripping.
 * Large images consume many tokens and can cause rate limit errors.
 *
 * ~100KB limit is conservative - a 100KB image in base64 is ~133KB,
 * which roughly translates to ~33K tokens for OpenAI (using 4 bytes per token estimate).
 */
const MAX_IMAGE_SIZE_BYTES = 100 * 1024; // 100KB

/**
 * Check if a model supports image inputs.
 *
 * Uses a blocklist approach: models known to not support images return false,
 * all other models are assumed to support images.
 *
 * @param model - The model name/ID to check
 * @returns true if the model supports image inputs, false otherwise
 */
export function doesModelSupportImages(model: string): boolean {
  const normalizedModel = model.toLowerCase();

  // Check exact matches first
  if (MODELS_WITHOUT_IMAGE_SUPPORT.includes(normalizedModel)) {
    return false;
  }

  // Check prefix matches for model variants (e.g., o1-preview-2024-09-12)
  for (const unsupportedModel of MODELS_WITHOUT_IMAGE_SUPPORT) {
    if (normalizedModel.startsWith(`${unsupportedModel}-`)) {
      return false;
    }
  }

  // Default: assume model supports images
  return true;
}

/**
 * Check if an MCP image block exceeds the size threshold.
 * Base64 encoding inflates size by ~33%, so we calculate actual image size.
 *
 * @param imageBlock - MCP image block with base64 data
 * @returns true if image is too large and should be stripped
 */
export function isImageTooLarge(imageBlock: McpImageBlock): boolean {
  if (typeof imageBlock.data !== "string") {
    return false;
  }

  // Base64 encoded size is ~4/3 of original size
  // Reverse: actual size = base64 length * 3/4
  const estimatedSizeBytes = Math.ceil((imageBlock.data.length * 3) / 4);
  return estimatedSizeBytes > MAX_IMAGE_SIZE_BYTES;
}

/**
 * Get the maximum allowed image size in bytes.
 */
export function getMaxImageSizeBytes(): number {
  return MAX_IMAGE_SIZE_BYTES;
}
