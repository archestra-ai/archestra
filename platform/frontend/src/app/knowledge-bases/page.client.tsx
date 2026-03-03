"use client";

import type { archestraApiTypes } from "@shared";
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
  useDeleteKnowledgeBase,
  useKnowledgeBases,
} from "@/lib/knowledge-base.query";
import { formatDate } from "@/lib/utils";
import { CreateKnowledgeBaseDialog } from "./_parts/create-knowledge-base-dialog";

export default function KnowledgeBasesPage() {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <KnowledgeBasesList />
      </ErrorBoundary>
    </div>
  );
}

function KnowledgeBasesList() {
  const router = useRouter();
  const { data: knowledgeBases, isPending } = useKnowledgeBases();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  type KnowledgeBaseItem =
    archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"][number];

  const columns: ColumnDef<KnowledgeBaseItem>[] = [
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
    (row: KnowledgeBaseItem) => {
      router.push(`/knowledge-bases/${row.id}`);
    },
    [router],
  );

  const items = knowledgeBases?.data ?? [];

  return (
    <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
      <PageLayout
        title="Knowledge Bases"
        description="Manage knowledge bases and their data connectors."
        actionButton={
          <PermissionButton
            permissions={{ knowledgeBase: ["create"] }}
            onClick={() => setIsCreateDialogOpen(true)}
          >
            <Plus className="mr-2 h-4 w-4" />
            Create Knowledge Base
          </PermissionButton>
        }
      >
        <div>
          {items.length === 0 ? (
            <div className="text-muted-foreground">
              No knowledge bases found. Create one to get started.
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={items}
              onRowClick={handleRowClick}
            />
          )}

          <CreateKnowledgeBaseDialog
            open={isCreateDialogOpen}
            onOpenChange={setIsCreateDialogOpen}
          />

          {deletingId && (
            <DeleteKnowledgeBaseDialog
              knowledgeBaseId={deletingId}
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

function DeleteKnowledgeBaseDialog({
  knowledgeBaseId,
  open,
  onOpenChange,
}: {
  knowledgeBaseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteKnowledgeBase = useDeleteKnowledgeBase();

  const handleDelete = useCallback(async () => {
    const result = await deleteKnowledgeBase.mutateAsync(knowledgeBaseId);
    if (result) {
      onOpenChange(false);
    }
  }, [knowledgeBaseId, deleteKnowledgeBase, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Delete Knowledge Base</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this knowledge base? All connectors
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
              disabled={deleteKnowledgeBase.isPending}
            >
              {deleteKnowledgeBase.isPending
                ? "Deleting..."
                : "Delete Knowledge Base"}
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
