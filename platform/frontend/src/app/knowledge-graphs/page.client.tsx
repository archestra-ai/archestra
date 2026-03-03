"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  type KnowledgeGraphResponse,
  useDeleteKnowledgeGraph,
  useKnowledgeGraphs,
} from "@/lib/knowledge-graph.query";
import { formatDate } from "@/lib/utils";
import { CreateKnowledgeGraphDialog } from "./_parts/create-knowledge-graph-dialog";

export default function KnowledgeGraphsPage() {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <KnowledgeGraphsList />
      </ErrorBoundary>
    </div>
  );
}

function KnowledgeGraphsList() {
  const router = useRouter();
  const { data: knowledgeGraphs, isPending } = useKnowledgeGraphs();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const columns: ColumnDef<KnowledgeGraphResponse>[] = [
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => <div className="font-medium">{row.original.name}</div>,
    },
    {
      id: "provider",
      accessorKey: "provider",
      header: "Provider",
      cell: ({ row }) => (
        <Badge variant="secondary" className="capitalize">
          {row.original.provider}
        </Badge>
      ),
    },
    {
      id: "status",
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: "connectors",
      header: "Connectors",
      cell: ({ row }) => <div>{row.original.connectorsCount ?? 0}</div>,
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      header: "Created",
      cell: ({ row }) => (
        <div className="font-mono text-xs">
          {formatDate({ date: row.original.createdAt })}
        </div>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      size: 100,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation();
            setDeletingId(row.original.id);
          }}
        >
          <Trash2 className="h-4 w-4 text-muted-foreground" />
        </Button>
      ),
    },
  ];

  const handleRowClick = useCallback(
    (row: KnowledgeGraphResponse) => {
      router.push(`/knowledge-graphs/${row.id}`);
    },
    [router],
  );

  const items = knowledgeGraphs ?? [];

  return (
    <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
      <PageLayout
        title="Knowledge Graphs"
        description="Manage knowledge graphs and their data connectors."
        actionButton={
          <PermissionButton
            permissions={{ knowledgeGraph: ["create"] }}
            onClick={() => setIsCreateDialogOpen(true)}
          >
            <Plus className="mr-2 h-4 w-4" />
            Create Knowledge Graph
          </PermissionButton>
        }
      >
        <div>
          {items.length === 0 ? (
            <div className="text-muted-foreground">
              No knowledge graphs found. Create one to get started.
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={items}
              onRowClick={handleRowClick}
            />
          )}

          <CreateKnowledgeGraphDialog
            open={isCreateDialogOpen}
            onOpenChange={setIsCreateDialogOpen}
          />

          {deletingId && (
            <DeleteKnowledgeGraphDialog
              knowledgeGraphId={deletingId}
              open={!!deletingId}
              onOpenChange={(open) => !open && setDeletingId(null)}
            />
          )}
        </div>
      </PageLayout>
    </LoadingWrapper>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "active"
      ? "default"
      : status === "error"
        ? "destructive"
        : "secondary";
  return (
    <Badge variant={variant} className="capitalize">
      {status}
    </Badge>
  );
}

function DeleteKnowledgeGraphDialog({
  knowledgeGraphId,
  open,
  onOpenChange,
}: {
  knowledgeGraphId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteKnowledgeGraph = useDeleteKnowledgeGraph();

  const handleDelete = useCallback(async () => {
    const result = await deleteKnowledgeGraph.mutateAsync(knowledgeGraphId);
    if (result) {
      onOpenChange(false);
    }
  }, [knowledgeGraphId, deleteKnowledgeGraph, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Delete Knowledge Graph</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this knowledge graph? All connectors
            and sync history will be permanently removed. This action cannot be
            undone.
          </DialogDescription>
        </DialogHeader>
        <DialogForm onSubmit={handleDelete}>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={deleteKnowledgeGraph.isPending}
            >
              {deleteKnowledgeGraph.isPending
                ? "Deleting..."
                : "Delete Knowledge Graph"}
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
