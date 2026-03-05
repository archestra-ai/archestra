"use client";

import type { archestraApiTypes } from "@shared";
import {
  ChevronDown,
  ChevronRight,
  Globe,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ConnectorStatusBadge } from "@/app/knowledge/knowledge-bases/_parts/connector-status-badge";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useConnectors,
  useDeleteConnector,
  useUpdateConnector,
} from "@/lib/connector.query";
import {
  useDeleteKnowledgeBase,
  useKnowledgeBases,
} from "@/lib/knowledge-base.query";
import { cn, formatDate } from "@/lib/utils";
import { ConnectorTypeIcon } from "./_parts/connector-icons";
import { CreateConnectorDialog } from "./_parts/create-connector-dialog";
import { CreateKnowledgeBaseDialog } from "./_parts/create-knowledge-base-dialog";
import { EditConnectorDialog } from "./_parts/edit-connector-dialog";
import { EditKnowledgeBaseDialog } from "./_parts/edit-knowledge-base-dialog";

type KnowledgeBaseItem =
  archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"][number];

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
  const { data: knowledgeBases, isPending } = useKnowledgeBases();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<KnowledgeBaseItem | null>(
    null,
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
            <div className="space-y-3">
              {items.map((kb) => (
                <KnowledgeBaseCard
                  key={kb.id}
                  kb={kb}
                  isExpanded={expandedId === kb.id}
                  onToggle={() =>
                    setExpandedId(expandedId === kb.id ? null : kb.id)
                  }
                  onEdit={() => setEditingItem(kb)}
                  onDelete={() => setDeletingId(kb.id)}
                />
              ))}
            </div>
          )}

          <CreateKnowledgeBaseDialog
            open={isCreateDialogOpen}
            onOpenChange={setIsCreateDialogOpen}
          />

          {editingItem && (
            <EditKnowledgeBaseDialog
              knowledgeBase={editingItem}
              open={!!editingItem}
              onOpenChange={(open) => !open && setEditingItem(null)}
            />
          )}

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

function KnowledgeBaseCard({
  kb,
  isExpanded,
  onToggle,
  onEdit,
  onDelete,
}: {
  kb: KnowledgeBaseItem;
  isExpanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [isCreateConnectorOpen, setIsCreateConnectorOpen] = useState(false);
  const isOrgWide = kb.visibility === "org-wide";
  const isAutoSync = kb.visibility === "auto-sync-permissions";
  const VisibilityIcon = isAutoSync ? RefreshCw : isOrgWide ? Globe : Users;
  const ExpandIcon = isExpanded ? ChevronDown : ChevronRight;
  const totalConnectors = kb.connectors.length;

  return (
    <div className="rounded-lg border">
      {/* Card header */}
      <button
        type="button"
        className="flex w-full items-center gap-4 px-5 py-4 cursor-pointer hover:bg-muted transition-colors text-left"
        onClick={onToggle}
      >
        <ExpandIcon className="h-5 w-5 shrink-0 text-muted-foreground" />

        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-xl font-semibold">{kb.name}</span>
          {kb.description && (
            <span className="text-sm text-muted-foreground truncate">
              {kb.description}
            </span>
          )}
        </div>

        <div className="flex items-center shrink-0 ml-auto divide-x">
          <StatItem label="Connectors" value={String(totalConnectors)} />
          <StatItem label="Docs Indexed" value={String(kb.totalDocsIndexed)} />
          <StatItem
            className="w-[160px]"
            label="Visibility"
            value={
              <Badge variant="outline" className="gap-1.5">
                <VisibilityIcon className="h-3.5 w-3.5" />
                {isAutoSync
                  ? "Auto Sync"
                  : isOrgWide
                    ? "Org-wide"
                    : "Team-scoped"}
              </Badge>
            }
          />
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              setIsCreateConnectorOpen(true);
            }}
          >
            <Plus className="h-4 w-4 text-muted-foreground" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <Pencil className="h-4 w-4 text-muted-foreground" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
      </button>

      {/* Expanded connectors panel */}
      {isExpanded && (
        <div className="border-t">
          <ExpandedConnectors knowledgeBaseId={kb.id} />
        </div>
      )}

      <CreateConnectorDialog
        knowledgeBaseId={kb.id}
        open={isCreateConnectorOpen}
        onOpenChange={setIsCreateConnectorOpen}
      />
    </div>
  );
}

function StatItem({
  label,
  value,
  className,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5 px-6", className)}>
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-base font-semibold">{value}</span>
    </div>
  );
}

type ConnectorItem =
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number];

function ExpandedConnectors({ knowledgeBaseId }: { knowledgeBaseId: string }) {
  const { data: connectors, isPending } = useConnectors(knowledgeBaseId);
  const updateConnector = useUpdateConnector();
  const [editingConnector, setEditingConnector] =
    useState<ConnectorItem | null>(null);
  const [deletingConnectorId, setDeletingConnectorId] = useState<string | null>(
    null,
  );

  const handleToggleEnabled = useCallback(
    async (connectorId: string, enabled: boolean) => {
      await updateConnector.mutateAsync({ id: connectorId, body: { enabled } });
    },
    [updateConnector],
  );

  if (isPending) {
    return (
      <div className="flex items-center justify-center py-6">
        <LoadingSpinner />
      </div>
    );
  }

  const items = connectors?.data ?? [];

  if (items.length === 0) {
    return (
      <div className="px-6 py-4 text-sm text-muted-foreground">
        No connectors configured.
      </div>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="uppercase text-xs tracking-wider bg-muted">
              Connectors
            </TableHead>
            <TableHead className="uppercase text-xs tracking-wider text-right bg-muted">
              Status
            </TableHead>
            <TableHead className="uppercase text-xs tracking-wider text-center w-[140px] bg-muted">
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((connector) => (
            <TableRow key={connector.id} className="hover:bg-muted/50">
              <TableCell>
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
                    <ConnectorTypeIcon
                      type={connector.connectorType}
                      className="h-6 w-6"
                    />
                  </div>
                  <div className="flex flex-col">
                    <span className="font-medium">{connector.name}</span>
                    <div className="flex items-center gap-2">
                      {connector.lastSyncAt ? (
                        <span className="text-sm text-muted-foreground">
                          {formatDate({ date: connector.lastSyncAt })}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          Never synced
                        </span>
                      )}
                      <ConnectorStatusBadge status={connector.lastSyncStatus} />
                    </div>
                  </div>
                </div>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <Switch
                    checked={connector.enabled}
                    onCheckedChange={(checked) =>
                      handleToggleEnabled(connector.id, checked)
                    }
                  />
                  <span className="text-sm w-14">
                    {connector.enabled ? "Active" : "Paused"}
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    asChild
                  >
                    <Link
                      href={`/knowledge/knowledge-bases/${knowledgeBaseId}/connectors/${connector.id}`}
                    >
                      <Info className="h-3.5 w-3.5 text-muted-foreground" />
                    </Link>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setEditingConnector(connector)}
                  >
                    <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setDeletingConnectorId(connector.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

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
    </>
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
