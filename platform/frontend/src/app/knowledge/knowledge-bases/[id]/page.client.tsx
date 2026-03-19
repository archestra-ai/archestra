"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft, Check, Heart, Link2, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { ConnectorStatusBadge } from "@/app/knowledge/knowledge-bases/_parts/connector-status-badge";
import { CreateConnectorDialog } from "@/app/knowledge/knowledge-bases/_parts/create-connector-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { StandardDialog } from "@/components/standard-dialog";
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
import { PermissionButton } from "@/components/ui/permission-button";
import { Switch } from "@/components/ui/switch";
import {
  useAssignConnectorToKnowledgeBases,
  useConnectors,
  useDeleteConnector,
  useUpdateConnector,
} from "@/lib/connector.query";
import { formatCronSchedule } from "@/lib/format-cron";
import {
  useKnowledgeBase,
  useKnowledgeBaseHealth,
} from "@/lib/knowledge-base.query";
import { cn, formatDate } from "@/lib/utils";

export default function KnowledgeBaseDetailPage({ id }: { id: string }) {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <KnowledgeBaseDetail id={id} />
      </ErrorBoundary>
    </div>
  );
}

function KnowledgeBaseDetail({ id }: { id: string }) {
  const router = useRouter();
  const { data: knowledgeBase, isPending } = useKnowledgeBase(id);
  const {
    data: healthData,
    refetch: checkHealth,
    isFetching: isCheckingHealth,
  } = useKnowledgeBaseHealth(id);
  const { data: connectors, isPending: isConnectorsPending } =
    useConnectors(id);
  const connectorItems = connectors ?? [];
  const updateConnector = useUpdateConnector();
  const [isAddConnectorOpen, setIsAddConnectorOpen] = useState(false);
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
      router.push(`/knowledge/connectors/${row.id}`);
    },
    [router],
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
        <span className="text-xs">
          {formatCronSchedule(row.original.schedule)}
        </span>
      ),
    },
    {
      id: "lastSync",
      header: "Last Sync",
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <ConnectorStatusBadge status={row.original.lastSyncStatus} />
          {row.original.lastSyncAt ? (
            <span
              className="text-xs text-muted-foreground"
              title={formatDate({ date: row.original.lastSyncAt })}
            >
              {formatDistanceToNow(new Date(row.original.lastSyncAt), {
                addSuffix: true,
              })}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Never</span>
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

  if (!knowledgeBase) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Knowledge base not found.</p>
      </div>
    );
  }

  return (
    <PageLayout
      title={
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/knowledge/knowledge-bases">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <span>{knowledgeBase.name}</span>
        </div>
      }
      description={
        <div className="flex items-center gap-2">
          <Link
            href="/knowledge/knowledge-bases"
            className="text-muted-foreground hover:text-foreground"
          >
            Knowledge Bases
          </Link>
          <span className="text-muted-foreground">/</span>
          <span>{knowledgeBase.name}</span>
        </div>
      }
    >
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>{knowledgeBase.name}</CardTitle>
                {knowledgeBase.description && (
                  <CardDescription>{knowledgeBase.description}</CardDescription>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    knowledgeBase.status === "active"
                      ? "default"
                      : "destructive"
                  }
                  className="capitalize"
                >
                  {knowledgeBase.status}
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
            permissions={{ knowledgeBase: ["create"] }}
            onClick={() => setIsAddConnectorOpen(true)}
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
          {connectorItems.length === 0 ? (
            <div className="text-muted-foreground">
              No connectors yet. Add one to start syncing data.
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={connectorItems}
              onRowClick={handleRowClick}
            />
          )}
        </LoadingWrapper>

        <AddConnectorDialog
          knowledgeBaseId={id}
          assignedConnectorIds={new Set(connectorItems.map((c) => c.id))}
          open={isAddConnectorOpen}
          onOpenChange={setIsAddConnectorOpen}
        />

        {deletingConnectorId && (
          <DeleteConnectorDialog
            connectorId={deletingConnectorId}
            open={!!deletingConnectorId}
            onOpenChange={(open) => !open && setDeletingConnectorId(null)}
          />
        )}
      </div>
    </PageLayout>
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
  const { data: allConnectors } = useConnectors();
  const assignMutation = useAssignConnectorToKnowledgeBases();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const availableConnectors = (allConnectors ?? []).filter(
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
      <StandardDialog
        open={open && step !== "create"}
        onOpenChange={handleClose}
        title={
          step === "choose" ? (
            "Add Connector"
          ) : (
            <div className="flex items-center gap-2">
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
              <span>Select Connectors</span>
            </div>
          )
        }
        description={
          step === "choose"
            ? "Reuse an existing connector or create a new one."
            : "Choose connectors to assign to this knowledge base."
        }
        size="small"
        footer={
          step === "reuse" ? (
            <>
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
            </>
          ) : null
        }
      >
        {step === "choose" && (
          <div className="grid grid-cols-2 gap-3">
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
        )}

        {step === "reuse" && (
          <div className="grid max-h-[50vh] grid-cols-2 gap-3 overflow-y-auto">
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
        )}
      </StandardDialog>

      <CreateConnectorDialog
        knowledgeBaseId={knowledgeBaseId}
        open={open && step === "create"}
        onBack={() => setStep("choose")}
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
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete Connector"
      description="Are you sure you want to delete this connector? All sync history will be permanently removed. This action cannot be undone."
      isPending={deleteConnector.isPending}
      onConfirm={handleDelete}
      confirmLabel="Delete Connector"
      pendingLabel="Deleting..."
    />
  );
}
