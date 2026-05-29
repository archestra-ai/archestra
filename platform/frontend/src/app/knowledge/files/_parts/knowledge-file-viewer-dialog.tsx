"use client";

import { Download } from "lucide-react";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { formatFileSize } from "@/lib/knowledge/knowledge-files.query";

export type KnowledgeFileViewerFile = {
  id: string;
  originalName: string;
  fileSize?: number | null;
};

export function KnowledgeFileViewerDialog({
  file,
  open,
  onOpenChange,
}: {
  file: KnowledgeFileViewerFile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title="View File"
      description={
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0 flex-1 truncate">{file.originalName}</div>
          {typeof file.fileSize === "number" && (
            <div className="text-xs text-muted-foreground">
              Size: {formatFileSize(file.fileSize)}
            </div>
          )}
        </div>
      }
      size="large"
      bodyClassName="flex min-h-0 flex-col"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => downloadKnowledgeFile(file)}
          >
            <Download className="h-4 w-4" />
            Download
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </>
      }
    >
      <iframe
        title={file.originalName}
        src={getKnowledgeFileContentUrl(file.id)}
        className="min-h-0 flex-1 rounded-md border bg-background"
      />
    </StandardDialog>
  );
}

export function getKnowledgeFileContentUrl(fileId: string, download = false) {
  return `/api/knowledge-files/${fileId}/content${download ? "?download=true" : ""}`;
}

export function downloadKnowledgeFile(file: KnowledgeFileViewerFile) {
  const link = document.createElement("a");
  link.href = getKnowledgeFileContentUrl(file.id, true);
  link.download = file.originalName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
