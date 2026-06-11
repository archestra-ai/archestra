"use client";

import { ChevronRight, Download, FolderKanban } from "lucide-react";
import { useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
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
import { useUserSandboxFiles } from "@/lib/skills-sandbox/sandbox-files.query";

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

  return (
    <PageLayout title="My Files" description="">
      {groups.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {isPending ? "Loading…" : "No files yet"}
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map((group) =>
            group.folder === null ? (
              <div key="(root)" className="overflow-hidden rounded-md border">
                {group.files.map((file, i) => (
                  <FileRow
                    key={file.id ?? file.filename}
                    file={file}
                    withBorder={i > 0}
                  />
                ))}
              </div>
            ) : (
              <ProjectGroup key={group.folder} group={group} />
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
}: {
  group: ReturnType<typeof groupSandboxFiles>[number];
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
        <span className="truncate">{group.folder}</span>
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
                key={file.id ?? `${group.folder}/${file.filename}`}
                file={file}
                withBorder={i > 0}
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
          title="Added outside the app — open it from the storage folder"
          aria-label={`${file.filename} was added outside the app; download unavailable`}
        >
          <Download className="h-4 w-4" />
        </span>
      )}
    </div>
  );
}
