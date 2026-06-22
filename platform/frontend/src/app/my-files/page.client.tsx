"use client";

import { ChevronRight, Download, FolderKanban, Trash2 } from "lucide-react";
import { useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { FilePreviewSheet } from "@/components/chat/file-preview";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { PageLayout } from "@/components/page-layout";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  groupSandboxFiles,
  type SandboxFileRow,
} from "@/lib/skills-sandbox/group-sandbox-files";
import {
  formatBytes,
  sandboxArtifactUrl,
} from "@/lib/skills-sandbox/sandbox-file-preview";
import {
  useDeleteSandboxFile,
  useUserSandboxFiles,
} from "@/lib/skills-sandbox/sandbox-files.query";

export default function MyFilesPageClient() {
  return (
    <ErrorBoundary>
      <MyFilesList />
    </ErrorBoundary>
  );
}

function MyFilesList() {
  const { data, isPending } = useUserSandboxFiles();
  const groups = groupSandboxFiles(data);
  const deleteFile = useDeleteSandboxFile();
  const [pendingDelete, setPendingDelete] = useState<SandboxFileRow | null>(
    null,
  );
  const [previewing, setPreviewing] = useState<SandboxFileRow | null>(null);

  return (
    <PageLayout title="My Files" description="">
      <DeleteConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete ${pendingDelete?.filename ?? "file"}?`}
        description="This permanently removes the file from your storage. Chats that linked to it will no longer be able to download it."
        isPending={deleteFile.isPending}
        onConfirm={async () => {
          if (pendingDelete) {
            await deleteFile.mutateAsync({ ref: pendingDelete.downloadRef });
            setPendingDelete(null);
          }
        }}
        confirmLabel="Delete"
        pendingLabel="Deleting..."
      />
      <FilePreviewSheet
        file={
          previewing
            ? {
                name: previewing.filename,
                mimeType: previewing.mimeType,
                contentUrl: sandboxArtifactUrl(previewing.downloadRef),
              }
            : null
        }
        onClose={() => setPreviewing(null)}
      />
      {groups.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {isPending ? "Loading…" : "No files yet"}
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map((group) =>
            group.project === null ? (
              <div key="(own)" className="overflow-hidden rounded-md border">
                {group.files.map((file, i) => (
                  <FileRow
                    key={file.downloadRef}
                    file={file}
                    withBorder={i > 0}
                    onDelete={setPendingDelete}
                    onPreview={setPreviewing}
                    isPreviewing={previewing === file}
                  />
                ))}
              </div>
            ) : (
              <ProjectGroup
                key={group.project}
                group={group}
                onDelete={setPendingDelete}
                onPreview={setPreviewing}
                previewing={previewing}
              />
            ),
          )}
        </div>
      )}
    </PageLayout>
  );
}

// === internal components ===

/** A project's files, collapsible under the project's name. */
function ProjectGroup({
  group,
  onDelete,
  onPreview,
  previewing,
}: {
  group: ReturnType<typeof groupSandboxFiles>[number];
  onDelete: (file: SandboxFileRow) => void;
  onPreview: (file: SandboxFileRow) => void;
  previewing: SandboxFileRow | null;
}) {
  const [open, setOpen] = useState(true);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-1 py-1 text-sm font-medium hover:text-foreground">
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
        <FolderKanban
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="truncate">{group.project}</span>
        <span className="ml-1 text-xs font-normal text-muted-foreground">
          {group.files.length}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 overflow-hidden rounded-md border">
          {group.files.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              No files yet
            </p>
          ) : (
            group.files.map((file, i) => (
              <FileRow
                key={file.downloadRef}
                file={file}
                withBorder={i > 0}
                onDelete={onDelete}
                onPreview={onPreview}
                isPreviewing={previewing === file}
              />
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function FileRow({
  file,
  withBorder,
  onDelete,
  onPreview,
  isPreviewing,
}: {
  file: SandboxFileRow;
  withBorder: boolean;
  onDelete: (file: SandboxFileRow) => void;
  onPreview: (file: SandboxFileRow) => void;
  isPreviewing: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50 ${withBorder ? "border-t" : ""} ${isPreviewing ? "bg-muted" : ""}`}
    >
      {file.downloadable ? (
        <button
          type="button"
          onClick={() => onPreview(file)}
          className="min-w-0 flex-1 truncate text-left hover:underline"
        >
          {file.filename}
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate">{file.filename}</span>
      )}
      <span className="w-20 shrink-0 text-right text-muted-foreground">
        {formatBytes(file.sizeBytes)}
      </span>
      <span className="hidden w-44 shrink-0 text-right text-muted-foreground sm:block">
        {new Date(file.createdAt).toLocaleString()}
      </span>
      {file.downloadable ? (
        <>
          <a
            href={sandboxArtifactUrl(file.downloadRef)}
            download={file.filename}
            className="text-muted-foreground hover:text-foreground"
            aria-label={`Download ${file.filename}`}
          >
            <Download className="h-4 w-4" />
          </a>
          <button
            type="button"
            onClick={() => onDelete(file)}
            className="text-muted-foreground hover:text-destructive"
            aria-label={`Delete ${file.filename}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </>
      ) : (
        <span
          role="img"
          className="text-muted-foreground/50"
          title="Download unavailable"
          aria-label={`${file.filename}: download unavailable`}
        >
          <Download className="h-4 w-4" />
        </span>
      )}
    </div>
  );
}
