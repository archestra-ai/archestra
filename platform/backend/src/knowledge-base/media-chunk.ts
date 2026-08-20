/**
 * Media chunks — the one place that knows how a non-text chunk is stored.
 *
 * A media document is chunked into a single chunk whose `content` is a data
 * URL (`data:<mimeType>;base64,<payload>`) rather than prose. Several stages
 * need to tell such a chunk apart from text — the embedder sends it as an
 * inline image, the keyword lane can never match it, and the query path must
 * not hand a 180KB base64 blob to a model as if it were readable text — so the
 * predicate and the parser live here instead of being re-derived per call site.
 */

/** True when a chunk's content is a media payload rather than text. */
export function isMediaChunkContent(content: string): boolean {
  return content.startsWith(IMAGE_DATA_URL_PREFIX);
}

/**
 * Parse an image data URL (`data:<mimeType>;base64,<data>`) into an inline
 * image input, or null when the content is ordinary text.
 */
export function parseImageDataUrl(
  content: string,
): { mimeType: string; data: string } | null {
  if (!isMediaChunkContent(content)) {
    return null;
  }
  const semicolonIdx = content.indexOf(BASE64_MARKER);
  if (semicolonIdx <= DATA_PREFIX.length) {
    return null;
  }
  return {
    mimeType: content.slice(DATA_PREFIX.length, semicolonIdx),
    data: content.slice(semicolonIdx + BASE64_MARKER.length),
  };
}

// ===== Internal constants =====

const DATA_PREFIX = "data:";
const IMAGE_DATA_URL_PREFIX = "data:image/";
const BASE64_MARKER = ";base64,";
