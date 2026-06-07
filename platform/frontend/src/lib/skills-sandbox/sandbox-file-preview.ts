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
