"use client";

import { Download, Folder } from "lucide-react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { PageLayout } from "@/components/page-layout";
import {
  groupSandboxFiles,
  type SandboxFileRow,
} from "@/lib/skills-sandbox/group-sandbox-files";
import {
  formatBytes,
  sandboxArtifactUrl,
} from "@/lib/skills-sandbox/sandbox-file-preview";
import { useUserSandboxFiles } from "@/lib/skills-sandbox/sandbox-files.query";

export default function XFilesPageClient() {
  return (
    <ErrorBoundary>
      <XFilesList />
    </ErrorBoundary>
  );
}

function XFilesList() {
  const { data, isPending } = useUserSandboxFiles();
  const groups = groupSandboxFiles(data);

  return (
    <PageLayout
      title="X-Files"
      description="Files your agents produced in the sandbox across all conversations. Folders belong to projects."
    >
      {groups.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {isPending ? "Loading…" : "No files yet"}
        </p>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <FileGroup key={group.folder ?? "(root)"} group={group} />
          ))}
        </div>
      )}
    </PageLayout>
  );
}

// === internal components ===

function FileGroup({
  group,
}: {
  group: ReturnType<typeof groupSandboxFiles>[number];
}) {
  return (
    <div>
      {group.folder !== null && (
        <div className="mb-1 flex items-center gap-2 px-1">
          <Folder className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="text-sm font-medium">{group.folder}</span>
        </div>
      )}
      <div className="overflow-hidden rounded-md border">
        {group.files.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">(empty)</p>
        ) : (
          group.files.map((file, i) => (
            <FileRow
              key={file.id ?? `${group.folder}/${file.filename}`}
              file={file}
              withBorder={i > 0}
            />
          ))
        )}
      </div>
    </div>
  );
}

function FileRow({
  file,
  withBorder,
}: {
  file: SandboxFileRow;
  withBorder: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50 ${withBorder ? "border-t" : ""}`}
    >
      <span className="min-w-0 flex-1 truncate">{file.filename}</span>
      <span className="w-20 shrink-0 text-right text-muted-foreground">
        {formatBytes(file.sizeBytes)}
      </span>
      <span className="hidden w-44 shrink-0 text-right text-muted-foreground sm:block">
        {new Date(file.createdAt).toLocaleString()}
      </span>
      {file.id ? (
        <a
          href={sandboxArtifactUrl(file.id)}
          download={file.filename}
          className="text-muted-foreground hover:text-foreground"
          aria-label={`Download ${file.filename}`}
        >
          <Download className="h-4 w-4" />
        </a>
      ) : (
        <span
          role="img"
          className="text-muted-foreground/50"
          title="Added outside Archestra — open it from the storage folder"
          aria-label={`${file.filename} was added outside Archestra; download unavailable`}
        >
          <Download className="h-4 w-4" />
        </span>
      )}
    </div>
  );
}
