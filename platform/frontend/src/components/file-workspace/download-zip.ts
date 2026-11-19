/** A file to put in a workspace's archive, at its path inside the archive. */
export interface ArchiveFile {
  path: string;
  content: string;
  /** Binary files arrive base64 encoded; text is the default. */
  encoding?: "utf8" | "base64";
}

/** What a workspace's download button saves: every file it shows, zipped. */
export interface WorkspaceDownload {
  /** Names the archive: `<name>.zip`, made safe for a file name. */
  name: string;
  /** Gathers the files when the button is clicked, fetching any it must. */
  files: () => ArchiveFile[] | Promise<ArchiveFile[]>;
}

/** Zips the files and has the browser save the archive. */
export async function downloadZip({
  name,
  files,
}: {
  name: string;
  files: ArchiveFile[];
}) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const file of files) {
    zip.file(
      file.path.replace(/^\/+/, ""),
      file.content,
      file.encoding === "base64" ? { base64: true } : undefined,
    );
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${archiveBaseName(name)}.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke after the click has handed the URL to the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ============================================================================
// Internal helpers
// ============================================================================

function archiveBaseName(name: string): string {
  return (
    name
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 80) || "files"
  );
}
