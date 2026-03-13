"use client";

import type { archestraApiTypes } from "@shared";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowLeft,
  Check,
  Globe,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Unlink,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { KnowledgePageLayout } from "@/app/knowledge/_parts/knowledge-page-layout";
import { ConnectorStatusDot } from "@/app/knowledge/knowledge-bases/_parts/connector-enabled-dot";
import { ConnectorStatusBadge } from "@/app/knowledge/knowledge-bases/_parts/connector-status-badge";
import { LoadingSpinner } from "@/components/loading";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useConnectors as useAllConnectors,
  useAssignConnectorToKnowledgeBases,
  useConnectors,
  useUnassignConnectorFromKnowledgeBase,
} from "@/lib/connector.query";
import {
  useDeleteKnowledgeBase,
  useKnowledgeBases,
} from "@/lib/knowledge-base.query";
import { useTeams } from "@/lib/team.query";
import { cn, formatDate } from "@/lib/utils";
import { ConnectorTypeIcon } from "./_parts/connector-icons";
import { CreateConnectorDialog } from "./_parts/create-connector-dialog";
import { CreateKnowledgeBaseDialog } from "./_parts/create-knowledge-base-dialog";
import { EditConnectorDialog } from "./_parts/edit-connector-dialog";
import { EditKnowledgeBaseDialog } from "./_parts/edit-knowledge-base-dialog";

const AGENT_TYPE_LABELS: Record<string, string> = {
  agent: "Agent",
  mcp_gateway: "MCP Gateway",
};

function formatAgentType(agentType: string): string {
  return AGENT_TYPE_LABELS[agentType] ?? agentType;
}

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

  const items = knowledgeBases?.data ?? [];

  return (
    <KnowledgePageLayout
      title="Knowledge Bases"
      description="Manage knowledge bases and their data connectors."
      createLabel="Create Knowledge Base"
      onCreateClick={() => setIsCreateDialogOpen(true)}
      isPending={isPending}
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
    </KnowledgePageLayout>
  );
}

function KnowledgeBaseCard({
  kb,
  onEdit,
  onDelete,
}: {
  kb: KnowledgeBaseItem;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [isAddConnectorOpen, setIsAddConnectorOpen] = useState(false);
  const { data: teams } = useTeams();
  const isOrgWide = kb.visibility === "org-wide";
  const isTeamScoped = kb.visibility === "team-scoped";
  const isAutoSync = kb.visibility === "auto-sync-permissions";
  const VisibilityIcon = isAutoSync ? RefreshCw : isOrgWide ? Globe : Users;
  const totalConnectors = kb.connectors.length;
  const matchedTeams = isTeamScoped
    ? (teams ?? []).filter((t) => kb.teamIds.includes(t.id))
    : [];

  return (
    <div className="rounded-lg border">
      {/* Card header */}
      <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4 text-left">
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="text-xl font-semibold">{kb.name}</span>
          {kb.description && (
            <span className="text-sm text-muted-foreground truncate">
              {kb.description}
            </span>
          )}
        </div>
        <div className="flex items-center gap-x-6 shrink-0 order-last lg:order-none w-full lg:w-auto pl-9 lg:pl-0">
          <StatItem label="Connectors" value={String(totalConnectors)} />
          <StatItem label="Docs Indexed" value={String(kb.totalDocsIndexed)} />
          <StatItem
            label="Visibility"
            value={
              isTeamScoped && matchedTeams.length > 0 ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="outline"
                        className="gap-1.5 cursor-default"
                      >
                        <VisibilityIcon className="h-3.5 w-3.5" />
                        Team-scoped
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <div className="space-y-0.5">
                        {matchedTeams.map((team) => (
                          <div key={team.id} className="text-xs">
                            {team.name}
                          </div>
                        ))}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                <Badge variant="outline" className="gap-1.5">
                  <VisibilityIcon className="h-3.5 w-3.5" />
                  {isAutoSync
                    ? "Auto Sync"
                    : isOrgWide
                      ? "Org-wide"
                      : "Team-scoped"}
                </Badge>
              )
            }
          />
          <StatItem
            label="Assigned To"
            value={
              kb.assignedAgents.length > 0 ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-default">
                        {String(kb.assignedAgents.length)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <div className="space-y-2">
                        {Object.entries(
                          kb.assignedAgents.reduce<
                            Record<string, typeof kb.assignedAgents>
                          >((groups, agent) => {
                            const label = formatAgentType(agent.agentType);
                            if (!groups[label]) groups[label] = [];
                            groups[label].push(agent);
                            return groups;
                          }, {}),
                        ).map(([type, agents]) => (
                          <div key={type}>
                            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
                              {type}
                            </div>
                            {agents.map((agent) => (
                              <div key={agent.id} className="text-xs pl-1">
                                {agent.name}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                "0"
              )
            }
          />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              setIsAddConnectorOpen(true);
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
      </div>

      {/* Connectors panel */}
      <div className="border-t">
        <ExpandedConnectors knowledgeBaseId={kb.id} />
      </div>

      <AddConnectorDialog
        knowledgeBaseId={kb.id}
        assignedConnectorIds={new Set(kb.connectors.map((c) => c.id))}
        open={isAddConnectorOpen}
        onOpenChange={setIsAddConnectorOpen}
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
    <div className={cn("flex flex-col gap-0.5", className)}>
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
  const router = useRouter();
  const { data: connectors, isPending } = useConnectors(knowledgeBaseId);
  const [editingConnector, setEditingConnector] =
    useState<ConnectorItem | null>(null);
  const [removingConnectorId, setRemovingConnectorId] = useState<string | null>(
    null,
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
            <TableHead className="uppercase text-xs tracking-wider text-center w-[100px] bg-muted">
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((connector) => (
            <TableRow
              key={connector.id}
              className="hover:bg-muted/50 cursor-pointer"
              onClick={() =>
                router.push(
                  `/knowledge/connectors/${connector.id}?from=knowledge-bases`,
                )
              }
            >
              <TableCell>
                <div className="flex items-center gap-3">
                  <ConnectorStatusDot
                    enabled={connector.enabled}
                    lastSyncStatus={connector.lastSyncStatus}
                  />
                  <Badge variant="secondary" className="gap-1.5 capitalize">
                    <ConnectorTypeIcon
                      type={connector.connectorType}
                      className="h-3.5 w-3.5"
                    />
                    {connector.connectorType}
                  </Badge>
                  <span className="font-medium">{connector.name}</span>
                </div>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
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
              </TableCell>
              <TableCell>
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation wrapper for action buttons inside clickable row */}
                {/* biome-ignore lint/a11y/noStaticElementInteractions: wrapper only prevents row click propagation */}
                <div
                  className="flex items-center justify-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setEditingConnector(connector)}
                  >
                    <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setRemovingConnectorId(connector.id)}
                        >
                          <Unlink className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Remove from knowledge base
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
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

      {removingConnectorId && (
        <RemoveConnectorDialog
          connectorId={removingConnectorId}
          knowledgeBaseId={knowledgeBaseId}
          open={!!removingConnectorId}
          onOpenChange={(open) => !open && setRemovingConnectorId(null)}
        />
      )}
    </>
  );
}

function AddConnectorDialog({
  knowledgeBaseId,
  assignedConnectorIds,
  open,
  onOpenChange,
}: {
  knowledgeBaseId: string;
  assignedConnectorIds: Set<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [step, setStep] = useState<"choose" | "reuse" | "create">("choose");
  const { data: allConnectors } = useAllConnectors();
  const assignMutation = useAssignConnectorToKnowledgeBases();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const availableConnectors = (allConnectors?.data ?? []).filter(
    (c) => !assignedConnectorIds.has(c.id),
  );

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleAssign = useCallback(async () => {
    if (selectedIds.size === 0) return;
    for (const connectorId of selectedIds) {
      await assignMutation.mutateAsync({
        connectorId,
        knowledgeBaseIds: [knowledgeBaseId],
      });
    }
    setSelectedIds(new Set());
    setStep("choose");
    onOpenChange(false);
  }, [selectedIds, knowledgeBaseId, assignMutation, onOpenChange]);

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) {
      setStep("choose");
      setSelectedIds(new Set());
    }
    onOpenChange(isOpen);
  };

  return (
    <>
      <Dialog open={open && step !== "create"} onOpenChange={handleClose}>
        <DialogContent className="max-w-xl">
          {step === "choose" && (
            <>
              <DialogHeader>
                <DialogTitle>Add Connector</DialogTitle>
                <DialogDescription>
                  Reuse an existing connector or create a new one.
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-3 py-2">
                <button
                  type="button"
                  onClick={() => setStep("reuse")}
                  disabled={availableConnectors.length === 0}
                  className="flex flex-col items-center gap-3 rounded-lg border p-5 text-center transition-colors hover:bg-muted/50 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
                    <Link2 className="h-7 w-7 text-muted-foreground" />
                  </div>
                  <div>
                    <div className="font-medium">Reuse Existing</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {availableConnectors.length === 0
                        ? "No unassigned connectors"
                        : `${availableConnectors.length} available`}
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setStep("create")}
                  className="flex flex-col items-center gap-3 rounded-lg border p-5 text-center transition-colors hover:bg-muted/50 cursor-pointer"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
                    <Plus className="h-7 w-7 text-muted-foreground" />
                  </div>
                  <div>
                    <div className="font-medium">Create New</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Set up a new connector
                    </div>
                  </div>
                </button>
              </div>
            </>
          )}

          {step === "reuse" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => {
                      setStep("choose");
                      setSelectedIds(new Set());
                    }}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  Select Connectors
                </DialogTitle>
                <DialogDescription>
                  Choose connectors to assign to this knowledge base.
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-3 py-2 max-h-[50vh] overflow-y-auto">
                {availableConnectors.map((connector) => {
                  const isSelected = selectedIds.has(connector.id);
                  return (
                    <button
                      key={connector.id}
                      type="button"
                      onClick={() => toggleSelected(connector.id)}
                      className={cn(
                        "relative flex items-center gap-3 rounded-lg border p-3 text-left transition-colors cursor-pointer hover:bg-muted/50",
                        isSelected && "border-primary bg-primary/5",
                      )}
                    >
                      {isSelected && (
                        <div className="absolute top-2 right-2">
                          <Check className="h-4 w-4 text-primary" />
                        </div>
                      )}
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
                        <ConnectorTypeIcon
                          type={connector.connectorType}
                          className="h-5 w-5"
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-sm truncate">
                          {connector.name}
                        </div>
                        <div className="text-xs text-muted-foreground capitalize">
                          {connector.connectorType}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setStep("choose");
                    setSelectedIds(new Set());
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleAssign}
                  disabled={selectedIds.size === 0 || assignMutation.isPending}
                >
                  {assignMutation.isPending
                    ? "Assigning..."
                    : `Assign ${selectedIds.size > 0 ? `(${selectedIds.size})` : ""}`}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <CreateConnectorDialog
        knowledgeBaseId={knowledgeBaseId}
        open={open && step === "create"}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setStep("choose");
            onOpenChange(false);
          }
        }}
      />
    </>
  );
}

function RemoveConnectorDialog({
  connectorId,
  knowledgeBaseId,
  open,
  onOpenChange,
}: {
  connectorId: string;
  knowledgeBaseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const unassignMutation = useUnassignConnectorFromKnowledgeBase();

  const handleRemove = useCallback(async () => {
    const result = await unassignMutation.mutateAsync({
      connectorId,
      knowledgeBaseId,
    });
    if (result) {
      onOpenChange(false);
    }
  }, [connectorId, knowledgeBaseId, unassignMutation, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Remove Connector</DialogTitle>
          <DialogDescription>
            Are you sure you want to remove this connector from the knowledge
            base? The connector itself will not be deleted and can be re-added
            later.
          </DialogDescription>
        </DialogHeader>
        <DialogForm onSubmit={handleRemove}>
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
              disabled={unassignMutation.isPending}
            >
              {unassignMutation.isPending ? "Removing..." : "Remove Connector"}
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
            Are you sure you want to delete this knowledge base? Connectors will
            not be deleted but will be unlinked from this knowledge base. This
            action cannot be undone.
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
