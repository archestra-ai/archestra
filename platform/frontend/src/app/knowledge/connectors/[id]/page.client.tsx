"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowLeft,
  Database,
  FileText,
  Play,
  Plug,
  Plus,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { ConnectorStatusBadge } from "@/app/knowledge/knowledge-bases/_parts/connector-status-badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAssignConnectorToKnowledgeBases,
  useConnector,
  useConnectorKnowledgeBases,
  useConnectorRuns,
  useSyncConnector,
  useTestConnectorConnection,
  useUnassignConnectorFromKnowledgeBase,
} from "@/lib/connector.query";
import { useKnowledgeBases } from "@/lib/knowledge-base.query";
import { formatDate } from "@/lib/utils";

type ConnectorRunItem =
  archestraApiTypes.GetConnectorRunsResponses["200"]["data"][number] & {
    logs?: string | null;
  };

export default function ConnectorDetailPage({
  connectorId,
}: {
  connectorId: string;
}) {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <ConnectorDetail connectorId={connectorId} />
      </ErrorBoundary>
    </div>
  );
}

function ConnectorDetail({ connectorId }: { connectorId: string }) {
  const { data: connector, isPending } = useConnector(connectorId);
  const syncConnector = useSyncConnector();
  const testConnection = useTestConnectorConnection();

  const [pageIndex, setPageIndex] = useState(0);
  const pageSize = 10;
  const [selectedRun, setSelectedRun] = useState<ConnectorRunItem | null>(null);

  const { data: runsData, isPending: isRunsPending } = useConnectorRuns({
    connectorId,
    limit: pageSize,
    offset: pageIndex * pageSize,
  });

  const handleSync = useCallback(async () => {
    await syncConnector.mutateAsync(connectorId);
  }, [syncConnector, connectorId]);

  const handleTestConnection = useCallback(async () => {
    await testConnection.mutateAsync(connectorId);
  }, [testConnection, connectorId]);

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      setPageIndex(newPagination.pageIndex);
    },
    [],
  );

  const columns: ColumnDef<ConnectorRunItem>[] = [
    {
      id: "status",
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <ConnectorStatusBadge status={row.original.status} />,
    },
    {
      id: "startedAt",
      accessorKey: "startedAt",
      header: "Started",
      cell: ({ row }) => (
        <div className="font-mono text-xs">
          {formatDate({ date: row.original.startedAt })}
        </div>
      ),
    },
    {
      id: "completedAt",
      header: "Completed",
      cell: ({ row }) => (
        <div className="font-mono text-xs">
          {row.original.completedAt
            ? formatDate({ date: row.original.completedAt })
            : "-"}
        </div>
      ),
    },
    {
      id: "documentsProcessed",
      header: "Processed",
      cell: ({ row }) => <div>{row.original.documentsProcessed ?? 0}</div>,
    },
    {
      id: "documentsIngested",
      header: "Ingested",
      cell: ({ row }) => <div>{row.original.documentsIngested ?? 0}</div>,
    },
    {
      id: "logs",
      header: "Logs",
      cell: ({ row }) => {
        const run = row.original;
        const hasLogs = run.logs || run.error;
        if (!hasLogs) return <span className="text-muted-foreground">-</span>;
        return (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => setSelectedRun(run)}
          >
            <FileText className="mr-1 h-3.5 w-3.5" />
            View
          </Button>
        );
      },
    },
  ];

  if (isPending) {
    return <LoadingSpinner />;
  }

  if (!connector) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Connector not found.</p>
      </div>
    );
  }

  return (
    <PageLayout
      title={
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/knowledge/connectors">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <ConnectorTypeIcon
            type={connector.connectorType}
            className="h-5 w-5"
          />
          <span>{connector.name}</span>
        </div>
      }
      description={
        <div className="flex items-center gap-2">
          <Link
            href="/knowledge/connectors"
            className="text-muted-foreground hover:text-foreground"
          >
            Connectors
          </Link>
          <span className="text-muted-foreground">/</span>
          <span>{connector.name}</span>
        </div>
      }
    >
      <div className="space-y-6">
        {/* Connector info + actions */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>{connector.name}</CardTitle>
                <CardDescription>
                  <Badge variant="secondary" className="capitalize mr-2">
                    {connector.connectorType}
                  </Badge>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                    {connector.schedule}
                  </code>
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <ConnectorStatusBadge status={connector.lastSyncStatus} />
                <Badge variant={connector.enabled ? "default" : "secondary"}>
                  {connector.enabled ? "Enabled" : "Disabled"}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleSync}
                disabled={syncConnector.isPending}
              >
                <Play className="mr-2 h-4 w-4" />
                {syncConnector.isPending ? "Starting..." : "Sync Now"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestConnection}
                disabled={testConnection.isPending}
              >
                <Plug className="mr-2 h-4 w-4" />
                {testConnection.isPending ? "Testing..." : "Test Connection"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Knowledge Base Assignments */}
        <KnowledgeBaseAssignments connectorId={connectorId} />

        {/* Sync Runs */}
        <h2 className="text-lg font-semibold">Sync Runs</h2>

        <LoadingWrapper
          isPending={isRunsPending}
          loadingFallback={<LoadingSpinner />}
        >
          {(runsData?.data ?? []).length === 0 ? (
            <div className="text-muted-foreground">
              No sync runs yet. Trigger a manual sync or wait for the scheduled
              sync.
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={runsData?.data ?? []}
              manualPagination={true}
              pagination={{
                pageIndex,
                pageSize,
                total: runsData?.pagination?.total ?? 0,
              }}
              onPaginationChange={handlePaginationChange}
            />
          )}
        </LoadingWrapper>

        {/* Run logs dialog */}
        <Dialog
          open={selectedRun !== null}
          onOpenChange={(open) => {
            if (!open) setSelectedRun(null);
          }}
        >
          <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                Sync Run Logs
                {selectedRun && (
                  <ConnectorStatusBadge status={selectedRun.status} />
                )}
              </DialogTitle>
            </DialogHeader>
            {selectedRun && (
              <div className="flex-1 overflow-auto space-y-4">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Started:</span>{" "}
                    {formatDate({ date: selectedRun.startedAt })}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Completed:</span>{" "}
                    {selectedRun.completedAt
                      ? formatDate({ date: selectedRun.completedAt })
                      : "-"}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Processed:</span>{" "}
                    {selectedRun.documentsProcessed ?? 0}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Ingested:</span>{" "}
                    {selectedRun.documentsIngested ?? 0}
                  </div>
                </div>
                {selectedRun.error && (
                  <div>
                    <h4 className="text-sm font-medium text-destructive mb-1">
                      Error
                    </h4>
                    <pre className="text-xs bg-destructive/10 text-destructive p-3 rounded-md whitespace-pre-wrap break-words max-h-32 overflow-auto">
                      {selectedRun.error}
                    </pre>
                  </div>
                )}
                {selectedRun.logs ? (
                  <div>
                    <h4 className="text-sm font-medium mb-1">Output</h4>
                    <pre className="text-xs bg-muted p-3 rounded-md whitespace-pre-wrap break-words max-h-96 overflow-auto font-mono">
                      {selectedRun.logs}
                    </pre>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No logs available for this run.
                  </p>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </PageLayout>
  );
}

function KnowledgeBaseAssignments({ connectorId }: { connectorId: string }) {
  const { data: assignedKbs, isPending } =
    useConnectorKnowledgeBases(connectorId);
  const { data: allKbs } = useKnowledgeBases();
  const assignMutation = useAssignConnectorToKnowledgeBases();
  const unassignMutation = useUnassignConnectorFromKnowledgeBase();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [selectedKbId, setSelectedKbId] = useState<string>("");

  const assignedIds = new Set((assignedKbs?.data ?? []).map((kb) => kb.id));
  const availableKbs = (allKbs?.data ?? []).filter(
    (kb) => !assignedIds.has(kb.id),
  );

  const handleAssign = useCallback(async () => {
    if (!selectedKbId) return;
    const result = await assignMutation.mutateAsync({
      connectorId,
      knowledgeBaseIds: [selectedKbId],
    });
    if (result) {
      setSelectedKbId("");
      setIsAddDialogOpen(false);
    }
  }, [selectedKbId, connectorId, assignMutation]);

  const handleUnassign = useCallback(
    async (knowledgeBaseId: string) => {
      await unassignMutation.mutateAsync({ connectorId, knowledgeBaseId });
    },
    [connectorId, unassignMutation],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Knowledge Bases</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIsAddDialogOpen(true)}
          disabled={availableKbs.length === 0}
        >
          <Plus className="mr-2 h-4 w-4" />
          Assign
        </Button>
      </div>

      <LoadingWrapper
        isPending={isPending}
        loadingFallback={<LoadingSpinner />}
      >
        {(assignedKbs?.data ?? []).length === 0 ? (
          <div className="text-sm text-muted-foreground">
            Not assigned to any knowledge bases.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(assignedKbs?.data ?? []).map((kb) => (
              <Badge key={kb.id} variant="secondary" className="gap-1.5 pr-1">
                <Database className="h-3 w-3" />
                {kb.name}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-4 w-4 ml-1 hover:bg-destructive/20"
                  onClick={() => handleUnassign(kb.id)}
                  disabled={unassignMutation.isPending}
                >
                  <X className="h-3 w-3" />
                </Button>
              </Badge>
            ))}
          </div>
        )}
      </LoadingWrapper>

      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Assign to Knowledge Base</DialogTitle>
            <DialogDescription>
              Select a knowledge base to assign this connector to.
            </DialogDescription>
          </DialogHeader>
          <DialogForm onSubmit={handleAssign}>
            <div className="py-2">
              <Select value={selectedKbId} onValueChange={setSelectedKbId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a knowledge base" />
                </SelectTrigger>
                <SelectContent>
                  {availableKbs.map((kb) => (
                    <SelectItem key={kb.id} value={kb.id}>
                      {kb.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsAddDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!selectedKbId || assignMutation.isPending}
              >
                {assignMutation.isPending ? "Assigning..." : "Assign"}
              </Button>
            </DialogFooter>
          </DialogForm>
        </DialogContent>
      </Dialog>
    </div>
  );
}
