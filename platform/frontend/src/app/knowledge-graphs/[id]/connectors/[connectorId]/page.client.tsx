"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowLeft, FileText, Play, Plug } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ConnectorStatusBadge } from "@/app/knowledge-graphs/_parts/connector-status-badge";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useConnector,
  useConnectorRuns,
  useSyncConnector,
  useTestConnectorConnection,
} from "@/lib/connector.query";
import { useKnowledgeGraph } from "@/lib/knowledge-graph.query";
import { formatDate } from "@/lib/utils";

/**
 * Connector run item type. Extends the generated SDK type with the `logs` field
 * which was recently added to the schema. Once codegen is re-run, the `logs`
 * field will be part of the generated type and this can be simplified.
 */
type ConnectorRunItem =
  archestraApiTypes.GetConnectorRunsResponses["200"]["data"][number] & {
    logs?: string | null;
  };

export default function ConnectorDetailPage({
  knowledgeGraphId,
  connectorId,
}: {
  knowledgeGraphId: string;
  connectorId: string;
}) {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <ConnectorDetail
          knowledgeGraphId={knowledgeGraphId}
          connectorId={connectorId}
        />
      </ErrorBoundary>
    </div>
  );
}

function ConnectorDetail({
  knowledgeGraphId,
  connectorId,
}: {
  knowledgeGraphId: string;
  connectorId: string;
}) {
  const { data: knowledgeGraph } = useKnowledgeGraph(knowledgeGraphId);
  const { data: connector, isPending } = useConnector(
    knowledgeGraphId,
    connectorId,
  );
  const syncConnector = useSyncConnector(knowledgeGraphId);
  const testConnection = useTestConnectorConnection(knowledgeGraphId);

  const [pageIndex, setPageIndex] = useState(0);
  const pageSize = 10;
  const [selectedRun, setSelectedRun] = useState<ConnectorRunItem | null>(null);

  const { data: runsData, isPending: isRunsPending } = useConnectorRuns({
    kgId: knowledgeGraphId,
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
            <Link href={`/knowledge-graphs/${knowledgeGraphId}`}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <span>{connector.name}</span>
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
          <Link
            href={`/knowledge-graphs/${knowledgeGraphId}`}
            className="text-muted-foreground hover:text-foreground"
          >
            {knowledgeGraph?.name ?? "..."}
          </Link>
          <span className="text-muted-foreground">/</span>
          <span>{connector.name}</span>
        </div>
      }
    >
      <div className="space-y-6">
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
