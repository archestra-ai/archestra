"use client";

import type { archestraApiTypes } from "@shared";
import { formatDistanceToNow } from "date-fns";
import { Database, Pencil, Trash2, Users } from "lucide-react";
import Link from "next/link";
import type React from "react";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { KnowledgePageLayout } from "@/app/knowledge/_parts/knowledge-page-layout";
import { ConnectorStatusDot } from "@/app/knowledge/knowledge-bases/_parts/connector-enabled-dot";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { ConnectorStatusBadge } from "@/app/knowledge/knowledge-bases/_parts/connector-status-badge";
import { CreateConnectorDialog } from "@/app/knowledge/knowledge-bases/_parts/create-connector-dialog";
import { EditConnectorDialog } from "@/app/knowledge/knowledge-bases/_parts/edit-connector-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useConnectors, useDeleteConnector } from "@/lib/connector.query";
import { formatCronSchedule } from "@/lib/format-cron";
import { formatDate } from "@/lib/utils";

type ConnectorItem =
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number];

const AGENT_TYPE_LABELS: Record<string, string> = {
  agent: "Agent",
  mcp_gateway: "MCP Gateway",
};

function formatAgentType(agentType: string): string {
  return AGENT_TYPE_LABELS[agentType] ?? agentType;
}

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
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingConnector, setEditingConnector] =
    useState<ConnectorItem | null>(null);
  const [deletingConnectorId, setDeletingConnectorId] = useState<string | null>(
    null,
  );

  const items = connectors?.data ?? [];

  return (
    <KnowledgePageLayout
      title="Connectors"
      description="Manage data connectors that feed into your knowledge bases."
      createLabel="Create Connector"
      onCreateClick={() => setIsCreateDialogOpen(true)}
      isPending={isPending}
    >
      <div>
        {items.length === 0 ? (
          <div className="text-muted-foreground">
            No connectors found. Create one to start syncing data into knowledge
            bases.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((connector) => (
              <ConnectorCard
                key={connector.id}
                connector={connector}
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
    </KnowledgePageLayout>
  );
}

function ConnectorCard({
  connector,
  onEdit,
  onDelete,
}: {
  connector: ConnectorItem;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const stopPropagation = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <Link href={`/knowledge/connectors/${connector.id}`} className="group">
      <Card className="h-full flex flex-col cursor-pointer transition-all hover:border-foreground/30 hover:shadow-md group-hover:bg-accent/30">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2.5">
              <ConnectorStatusDot
                enabled={connector.enabled}
                lastSyncStatus={connector.lastSyncStatus}
              />
              <div>
                <CardTitle className="text-base">{connector.name}</CardTitle>
                <Badge variant="secondary" className="gap-1.5 capitalize mt-1">
                  <ConnectorTypeIcon
                    type={connector.connectorType}
                    className="h-3.5 w-3.5"
                  />
                  {connector.connectorType}
                </Badge>
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
        <CardContent className="space-y-3 mt-auto">
          <div className="flex items-center gap-2">
            {connector.lastSyncAt ? (
              <>
                <ConnectorStatusBadge status={connector.lastSyncStatus} />
                <span
                  className="text-xs text-muted-foreground"
                  title={formatDate({ date: connector.lastSyncAt })}
                >
                  {formatDistanceToNow(new Date(connector.lastSyncAt), {
                    addSuffix: true,
                  })}
                </span>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">
                Never synced
              </span>
            )}
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Database className="h-3.5 w-3.5" />
              <span>{formatCronSchedule(connector.schedule)}</span>
            </div>
            <AssignedAgentsTooltip connector={connector} />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function AssignedAgentsTooltip({ connector }: { connector: ConnectorItem }) {
  const { assignedAgents } = connector;

  if (!assignedAgents || assignedAgents.length === 0) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            <span>Assigned to {assignedAgents.length}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <div className="space-y-1">
            {assignedAgents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">
                  {formatAgentType(agent.agentType)}
                </span>
                <span>{agent.name}</span>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
