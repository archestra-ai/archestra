"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowLeft, Play, Plug } from "lucide-react";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useConnector,
  useConnectorRuns,
  useSyncConnector,
  useTestConnectorConnection,
} from "@/lib/connector.query";
import { useKnowledgeGraph } from "@/lib/knowledge-graph.query";
import { formatDate } from "@/lib/utils";

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

  type ConnectorRunItem =
    archestraApiTypes.GetConnectorRunsResponses["200"]["data"][number];

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
      id: "error",
      header: "Error",
      cell: ({ row }) => {
        const error = row.original.error;
        if (!error) return <span className="text-muted-foreground">-</span>;
        const truncated =
          error.length > 80 ? `${error.substring(0, 80)}...` : error;
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-destructive cursor-help">
                {truncated}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm">
              <p className="text-xs whitespace-pre-wrap">{error}</p>
            </TooltipContent>
          </Tooltip>
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
      </div>
    </PageLayout>
  );
}
