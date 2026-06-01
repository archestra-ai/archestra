"use client";

import { DownloadIcon, FileIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

const INLINE_SAFE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export interface ArtifactRef {
  artifactId: string;
  sandboxId: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  downloadUrl: string;
}

/**
 * Heuristic for detecting an ArtifactRef-shaped object inside a tool result.
 * Used at the call site to decide whether to render the preview alongside the
 * standard JSON ToolOutput.
 */
export function isArtifactRef(value: unknown): value is ArtifactRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.artifactId === "string" &&
    typeof ref.downloadUrl === "string" &&
    typeof ref.mimeType === "string" &&
    typeof ref.sizeBytes === "number"
  );
}

/**
 * Render an artifact from `get_skill_sandbox_artifact`: inline preview for
 * known-safe raster images, download button for everything else (SVG, PDF,
 * binaries — anything the backend serves with Content-Disposition:
 * attachment).
 */
export function SandboxArtifactPreview({
  artifact,
}: {
  artifact: ArtifactRef;
}) {
  const basename = artifact.path.split("/").pop() ?? "artifact";
  const sizeText = formatBytes(artifact.sizeBytes);

  if (INLINE_SAFE_MIMES.has(artifact.mimeType)) {
    return (
      <div className="space-y-2 p-4">
        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Artifact preview
        </h4>
        <div className="rounded-md bg-muted/50 p-3 space-y-2">
          <a
            href={artifact.downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block"
          >
            <img
              src={artifact.downloadUrl}
              alt={basename}
              className="max-h-96 max-w-full rounded border"
            />
          </a>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-mono truncate">{basename}</span>
            <span>
              {artifact.mimeType} · {sizeText}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-4">
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Artifact
      </h4>
      <div className="rounded-md bg-muted/50 p-3 flex items-center gap-3">
        <FileIcon className="size-5 flex-none text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm truncate">{basename}</div>
          <div className="text-xs text-muted-foreground">
            {artifact.mimeType} · {sizeText}
          </div>
        </div>
        <Button asChild size="sm" variant="secondary">
          <a href={artifact.downloadUrl} download={basename}>
            <DownloadIcon className="size-3.5" />
            Download
          </a>
        </Button>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
