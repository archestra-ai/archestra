"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Download } from "lucide-react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { PageLayout } from "@/components/page-layout";
import { DataTable } from "@/components/ui/data-table";
import {
  formatBytes,
  sandboxArtifactUrl,
} from "@/lib/skills-sandbox/sandbox-file-preview";
import { useUserSandboxFiles } from "@/lib/skills-sandbox/sandbox-files.query";

type Row = NonNullable<ReturnType<typeof useUserSandboxFiles>["data"]>[number];

export default function XFilesPageClient() {
  return (
    <ErrorBoundary>
      <XFilesList />
    </ErrorBoundary>
  );
}

function XFilesList() {
  const { data, isPending, isFetching } = useUserSandboxFiles();
  const files = data ?? [];

  const columns: ColumnDef<Row>[] = [
    { accessorKey: "filename", header: "Name" },
    {
      accessorKey: "sizeBytes",
      header: "Size",
      cell: ({ row }) => formatBytes(row.original.sizeBytes),
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleString(),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) =>
        row.original.id ? (
          <a
            href={sandboxArtifactUrl(row.original.id)}
            download={row.original.filename}
            className="text-muted-foreground hover:text-foreground"
            aria-label={`Download ${row.original.filename}`}
          >
            <Download className="h-4 w-4" />
          </a>
        ) : (
          <span
            className="text-muted-foreground/50"
            title="Added outside Archestra — open it from the storage folder"
          >
            <Download className="h-4 w-4" />
          </span>
        ),
    },
  ];

  return (
    <PageLayout
      title="X-Files"
      description="Files your agents produced in the sandbox across all conversations."
    >
      <DataTable
        columns={columns}
        data={files}
        getRowId={(row) => row.id ?? row.filename}
        emptyMessage="No files yet"
        isLoading={isFetching || isPending}
      />
    </PageLayout>
  );
}
