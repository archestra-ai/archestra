export const TOKEN_ESTIMATE = {
  /** Characters per token for text content (provider-independent approximation). */
  charsPerToken: 4,
  /** Bytes per token for PDF binary payloads. */
  pdfBytesPerToken: 12,
  /** Bytes per token for non-PDF, non-text binary payloads (images, audio, etc.). */
  binaryBytesPerToken: 4,
  /**
   * Images are billed by dimensions, not byte size. Without this ceiling a
   * multi-MB image would estimate at ~1 M tokens and spuriously inflate the bar
   * (and trip auto-compaction every turn).
   */
  imageTokenMaxEstimate: 1_600,
} as const;

export function isTextLikeMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/xml" ||
    mediaType === "application/csv"
  );
}

export function estimateFileTokens(params: {
  mediaType: string;
  byteLength: number;
}): number {
  const { mediaType, byteLength } = params;
  if (isTextLikeMediaType(mediaType)) {
    return Math.ceil(byteLength / TOKEN_ESTIMATE.charsPerToken);
  }
  if (mediaType === "application/pdf") {
    // todo: estimate PDFs from locally extracted text first, then use this byte fallback for scanned/failed parses.
    return Math.ceil(byteLength / TOKEN_ESTIMATE.pdfBytesPerToken);
  }
  const estimate = Math.ceil(byteLength / TOKEN_ESTIMATE.binaryBytesPerToken);
  if (mediaType.startsWith("image/")) {
    return Math.min(estimate, TOKEN_ESTIMATE.imageTokenMaxEstimate);
  }
  return estimate;
}
