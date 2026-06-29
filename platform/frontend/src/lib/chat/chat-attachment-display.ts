export function isCsvAttachment(
  mediaType?: string | null,
  filename?: string | null,
): boolean {
  return (
    mediaType === "text/csv" ||
    mediaType === "application/csv" ||
    mediaType === "application/vnd.ms-excel" ||
    hasExtension(filename, "csv")
  );
}

export function isPlainTextAttachment(
  mediaType?: string | null,
  filename?: string | null,
): boolean {
  return mediaType === "text/plain" || hasExtension(filename, "txt");
}

export function getAttachmentFallbackLabel(params: {
  mediaType?: string | null;
  filename?: string | null;
}): string {
  if (isCsvAttachment(params.mediaType, params.filename)) {
    return "CSV file";
  }

  if (isPlainTextAttachment(params.mediaType, params.filename)) {
    return "Text file";
  }

  return "Attachment";
}

function hasExtension(
  filename: string | null | undefined,
  extension: string,
): boolean {
  return filename?.toLowerCase().endsWith(`.${extension}`) ?? false;
}
