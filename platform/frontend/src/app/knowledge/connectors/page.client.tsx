"use client";

import type { archestraApiTypes } from "@shared";
import { Database, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import type React from "react";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { ConnectorStatusBadge } from "@/app/knowledge/knowledge-bases/_parts/connector-status-badge";
import { CreateConnectorDialog } from "@/app/knowledge/knowledge-bases/_parts/create-connector-dialog";
import { EditConnectorDialog } from "@/app/knowledge/knowledge-bases/_parts/edit-connector-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { formatDate } from "@/lib/utils";

type ConnectorItem =
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number];

export default function ConnectorsPage() {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <ConnectorsList />
      </ErrorBoundary>
    </div>
  );
}

function ConnectorsList() {
  const { data: connectors, isPending } = useConnectors();
  const updateConnector = useUpdateConnector();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingConnector, setEditingConnector] =
    useState<ConnectorItem | null>(null);
  const [deletingConnectorId, setDeletingConnectorId] = useState<string | null>(
    null,
  );

  const handleToggleEnabled = useCallback(
    async (connectorId: string, enabled: boolean) => {
      await updateConnector.mutateAsync({
        id: connectorId,
        body: { enabled },
      });
    },
    [updateConnector],
  );

  const items = connectors?.data ?? [];

  return (
    <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
      <PageLayout
        title="Connectors"
        description="Manage data connectors that feed into your knowledge bases."
        actionButton={
          <PermissionButton
            permissions={{ knowledgeBase: ["create"] }}
            onClick={() => setIsCreateDialogOpen(true)}
          >
            <Plus className="mr-2 h-4 w-4" />
            Create Connector
          </PermissionButton>
        }
      >
        <div>
          {items.length === 0 ? (
            <div className="text-muted-foreground">
              No connectors found. Create one to start syncing data into
              knowledge bases.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {items.map((connector) => (
                <ConnectorCard
                  key={connector.id}
                  connector={connector}
                  onToggleEnabled={handleToggleEnabled}
                  onEdit={() => setEditingConnector(connector)}
                  onDelete={() => setDeletingConnectorId(connector.id)}
                />
              ))}
            </div>
          )}

          <CreateConnectorDialog
            open={isCreateDialogOpen}
            onOpenChange={setIsCreateDialogOpen}
          />

          {editingConnector && (
            <EditConnectorDialog
              connector={editingConnector}
              open={!!editingConnector}
              onOpenChange={(open) => !open && setEditingConnector(null)}
            />
          )}

          {deletingConnectorId && (
            <DeleteConnectorDialog
              connectorId={deletingConnectorId}
              open={!!deletingConnectorId}
              onOpenChange={(open) => !open && setDeletingConnectorId(null)}
            />
          )}
        </div>
      </PageLayout>
    </LoadingWrapper>
  );
}

function ConnectorCard({
  connector,
  onToggleEnabled,
  onEdit,
  onDelete,
}: {
  connector: ConnectorItem;
  onToggleEnabled: (connectorId: string, enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const stopPropagation = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <Link href={`/knowledge/connectors/${connector.id}`} className="group">
      <Card className="cursor-pointer transition-all hover:border-foreground/30 hover:shadow-md group-hover:bg-accent/30">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
                <ConnectorTypeIcon
                  type={connector.connectorType}
                  className="h-6 w-6"
                />
              </div>
              <div>
                <CardTitle className="text-base">{connector.name}</CardTitle>
                <CardDescription className="capitalize">
                  {connector.connectorType}
                </CardDescription>
              </div>
            </div>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only prevents link navigation */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation only prevents link navigation */}
            <div className="flex items-center gap-1" onClick={stopPropagation}>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onEdit}
              >
                <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onDelete}
              >
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ConnectorStatusBadge status={connector.lastSyncStatus} />
              {connector.lastSyncAt && (
                <span className="text-xs text-muted-foreground">
                  {formatDate({ date: connector.lastSyncAt })}
                </span>
              )}
              {!connector.lastSyncAt && (
                <span className="text-xs text-muted-foreground">
                  Never synced
                </span>
              )}
            </div>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only prevents link navigation */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation only prevents link navigation */}
            <div className="flex items-center gap-2" onClick={stopPropagation}>
              <Switch
                checked={connector.enabled}
                onCheckedChange={(checked) =>
                  onToggleEnabled(connector.id, checked)
                }
              />
              <span className="text-sm w-14">
                {connector.enabled ? "Active" : "Paused"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Database className="h-3.5 w-3.5" />
            <code className="bg-muted px-1.5 py-0.5 rounded">
              {connector.schedule}
            </code>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function DeleteConnectorDialog({
  connectorId,
  open,
  onOpenChange,
}: {
  connectorId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteConnector = useDeleteConnector();

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
