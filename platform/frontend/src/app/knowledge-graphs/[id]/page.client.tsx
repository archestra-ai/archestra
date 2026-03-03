"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowLeft, Heart, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ConnectorStatusBadge } from "@/app/knowledge-graphs/_parts/connector-status-badge";
import { CreateConnectorDialog } from "@/app/knowledge-graphs/_parts/create-connector-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import {
  useConnectors,
  useDeleteConnector,
  useUpdateConnector,
} from "@/lib/connector.query";
import {
  useKnowledgeGraph,
  useKnowledgeGraphHealth,
} from "@/lib/knowledge-graph.query";
import { formatDate } from "@/lib/utils";

export default function KnowledgeGraphDetailPage({ id }: { id: string }) {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <KnowledgeGraphDetail id={id} />
      </ErrorBoundary>
    </div>
  );
}

function KnowledgeGraphDetail({ id }: { id: string }) {
  const router = useRouter();
  const { data: knowledgeGraph, isPending } = useKnowledgeGraph(id);
  const {
    data: healthData,
    refetch: checkHealth,
    isFetching: isCheckingHealth,
  } = useKnowledgeGraphHealth(id);
  const { data: connectors, isPending: isConnectorsPending } =
    useConnectors(id);
  const updateConnector = useUpdateConnector(id);
  const [isCreateConnectorOpen, setIsCreateConnectorOpen] = useState(false);
  const [deletingConnectorId, setDeletingConnectorId] = useState<string | null>(
    null,
  );

  type ConnectorItem =
    archestraApiTypes.GetConnectorsResponses["200"]["data"][number];

  const handleToggleEnabled = useCallback(
    async (connectorId: string, enabled: boolean) => {
      await updateConnector.mutateAsync({
        id: connectorId,
        body: { enabled },
      });
    },
    [updateConnector],
  );

  const handleRowClick = useCallback(
    (row: ConnectorItem) => {
      router.push(`/knowledge-graphs/${id}/connectors/${row.id}`);
    },
    [router, id],
  );

  const columns: ColumnDef<ConnectorItem>[] = [
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => <div className="font-medium">{row.original.name}</div>,
    },
    {
      id: "connectorType",
      accessorKey: "connectorType",
      header: "Type",
      cell: ({ row }) => (
        <Badge variant="secondary" className="capitalize">
          {row.original.connectorType}
        </Badge>
      ),
    },
    {
      id: "schedule",
      accessorKey: "schedule",
      header: "Schedule",
      cell: ({ row }) => (
        <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
          {row.original.schedule}
        </code>
      ),
    },
    {
      id: "lastSync",
      header: "Last Sync",
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <ConnectorStatusBadge status={row.original.lastSyncStatus} />
          {row.original.lastSyncAt && (
            <span className="text-xs text-muted-foreground">
              {formatDate({ date: row.original.lastSyncAt })}
            </span>
          )}
        </div>
      ),
    },
    {
      id: "enabled",
      header: "Enabled",
      cell: ({ row }) => (
        <Switch
          checked={row.original.enabled}
          onCheckedChange={(checked) =>
            handleToggleEnabled(row.original.id, checked)
          }
          onClick={(e) => e.stopPropagation()}
        />
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
            setDeletingConnectorId(row.original.id);
          }}
        >
          <Trash2 className="h-4 w-4 text-muted-foreground" />
        </Button>
      ),
    },
  ];

  if (isPending) {
    return <LoadingSpinner />;
  }

  if (!knowledgeGraph) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Knowledge graph not found.</p>
      </div>
    );
  }

  return (
    <PageLayout
      title={
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/knowledge-graphs">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <span>{knowledgeGraph.name}</span>
        </div>
      }
      description={
        <div className="flex items-center gap-2">
          <Link
            href="/knowledge-graphs"
            className="text-muted-foreground hover:text-foreground"
          >
            Knowledge Graphs
          </Link>
          <span className="text-muted-foreground">/</span>
          <span>{knowledgeGraph.name}</span>
        </div>
      }
    >
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>{knowledgeGraph.name}</CardTitle>
                <CardDescription>
                  Provider: {knowledgeGraph.provider}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    knowledgeGraph.status === "active"
                      ? "default"
                      : "destructive"
                  }
                  className="capitalize"
                >
                  {knowledgeGraph.status}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => checkHealth()}
                  disabled={isCheckingHealth}
                >
                  <Heart className="mr-2 h-4 w-4" />
                  {isCheckingHealth ? "Checking..." : "Health Check"}
                </Button>
              </div>
            </div>
          </CardHeader>
          {healthData && (
            <CardContent>
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    healthData.status === "healthy" ? "default" : "destructive"
                  }
                >
                  {healthData.status}
                </Badge>
                {healthData.message && (
                  <span className="text-sm text-muted-foreground">
                    {healthData.message}
                  </span>
                )}
              </div>
            </CardContent>
          )}
        </Card>

        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Connectors</h2>
          <PermissionButton
            permissions={{ knowledgeGraph: ["create"] }}
            onClick={() => setIsCreateConnectorOpen(true)}
            size="sm"
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Connector
          </PermissionButton>
        </div>

        <LoadingWrapper
          isPending={isConnectorsPending}
          loadingFallback={<LoadingSpinner />}
        >
          {(connectors?.data ?? []).length === 0 ? (
            <div className="text-muted-foreground">
              No connectors yet. Add one to start syncing data.
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={connectors?.data ?? []}
              onRowClick={handleRowClick}
            />
          )}
        </LoadingWrapper>

        <CreateConnectorDialog
          knowledgeGraphId={id}
          open={isCreateConnectorOpen}
          onOpenChange={setIsCreateConnectorOpen}
        />

        {deletingConnectorId && (
          <DeleteConnectorDialog
            knowledgeGraphId={id}
            connectorId={deletingConnectorId}
            open={!!deletingConnectorId}
            onOpenChange={(open) => !open && setDeletingConnectorId(null)}
          />
        )}
      </div>
    </PageLayout>
  );
}

function DeleteConnectorDialog({
  knowledgeGraphId,
  connectorId,
  open,
  onOpenChange,
}: {
  knowledgeGraphId: string;
  connectorId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteConnector = useDeleteConnector(knowledgeGraphId);

  const handleDelete = useCallback(async () => {
    const result = await deleteConnector.mutateAsync(connectorId);
    if (result) {
      onOpenChange(false);
    }
  }, [connectorId, deleteConnector, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Delete Connector</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this connector? All sync history
            will be permanently removed. This action cannot be undone.
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
              disabled={deleteConnector.isPending}
            >
              {deleteConnector.isPending ? "Deleting..." : "Delete Connector"}
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
