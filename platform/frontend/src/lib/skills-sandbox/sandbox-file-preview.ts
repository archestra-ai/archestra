export type SandboxFilePreviewKind = "image" | "text" | "none";

/** Which inline preview a file supports, from its mime type. */
export function sandboxFilePreviewKind(
  mimeType: string,
): SandboxFilePreviewKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    return "text";
  }
  return "none";
}

/** Byte route for an artifact id (download + image preview source). */
export function sandboxArtifactUrl(id: string): string {
  return `/api/skill-sandbox/artifacts/${id}`;
}

/** Human-readable file size for the X-Files list (B / KB / MB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
