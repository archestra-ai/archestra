"use client";

import {
  type archestraApiTypes,
  CONNECTOR_TYPE_LABELS,
  type ConnectorType,
} from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { Database, Pencil, Trash2, Users } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { KnowledgePageLayout } from "@/app/knowledge/_parts/knowledge-page-layout";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { ConnectorStatusBadge } from "@/app/knowledge/knowledge-bases/_parts/connector-status-badge";
import { CreateConnectorDialog } from "@/app/knowledge/knowledge-bases/_parts/create-connector-dialog";
import { EditConnectorDialog } from "@/app/knowledge/knowledge-bases/_parts/edit-connector-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { DataTable } from "@/components/ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import {
  useConnectorsPaginated,
  useDeleteConnector,
} from "@/lib/knowledge/connector.query";
import { formatDate } from "@/lib/utils";
import { formatCronSchedule } from "@/lib/utils/format-cron";

type ConnectorItem =
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number];

const AGENT_TYPE_LABELS: Record<string, string> = {
  agent: "Agent",
  mcp_gateway: "MCP Gateway",
};

const CONNECTOR_TYPE_OPTIONS = [
  "jira",
  "confluence",
  "github",
  "gitlab",
  "servicenow",
  "file_upload",
] as ConnectorType[];

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
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const search = searchParams.get("search") || "";
  const connectorTypeFilter = searchParams.get("connectorType") || "all";

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_TABLE_LIMIT);
  const offset = pageIndex * pageSize;

  const {
    data: connectors,
    isPending,
    isFetching,
  } = useConnectorsPaginated({
    limit: pageSize,
    offset,
    search: search || undefined,
    connectorType:
      connectorTypeFilter === "all"
        ? undefined
        : (connectorTypeFilter as NonNullable<
            archestraApiTypes.GetConnectorsData["query"]
          >["connectorType"]),
  });
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingConnector, setEditingConnector] =
    useState<ConnectorItem | null>(null);
  const [deletingConnectorId, setDeletingConnectorId] = useState<string | null>(
    null,
  );

  const items = connectors?.data ?? [];
  const pagination = connectors?.pagination;

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(newPagination.pageIndex + 1));
      params.set("pageSize", String(newPagination.pageSize));
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const handleConnectorTypeChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "all") {
        params.delete("connectorType");
      } else {
        params.set("connectorType", value);
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const clearFilters = useCallback(() => {
    router.push(pathname, { scroll: false });
  }, [router, pathname]);

  const columns: ColumnDef<ConnectorItem>[] = [
    {
      id: "icon",
      size: 40,
      header: "",
      cell: ({ row }) => (
        <div className="flex items-center justify-center">
          <ConnectorTypeIcon
            type={row.original.connectorType}
            className="h-5 w-5"
          />
        </div>
      ),
    },
    {
      id: "name",
      accessorKey: "name",
      header: "Connector",
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium truncate">{row.original.name}</div>
          {row.original.description && (
            <div className="text-xs text-muted-foreground truncate">
              {row.original.description}
            </div>
          )}
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => {
        if (row.original.connectorType === "file_upload") {
          return (
            <span className="text-xs text-muted-foreground">
              Manual uploads
            </span>
          );
        }
        return (
          <div className="flex items-center gap-2">
            {row.original.lastSyncAt ? (
              <>
                <ConnectorStatusBadge status={row.original.lastSyncStatus} />
                <span
                  className="text-xs text-muted-foreground"
                  title={formatDate({ date: row.original.lastSyncAt })}
                >
                  {formatDistanceToNow(new Date(row.original.lastSyncAt), {
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
        );
      },
    },
    {
      id: "schedule",
      header: "Schedule",
      cell: ({ row }) => {
        if (row.original.connectorType === "file_upload") {
          return (
            <span className="text-xs text-muted-foreground">
              Manual uploads
            </span>
          );
        }
        return (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Database className="h-3.5 w-3.5" />
            <span>{formatCronSchedule(row.original.schedule)}</span>
          </div>
        );
      },
    },
    {
      id: "assigned",
      header: "Assigned",
      cell: ({ row }) => <AssignedAgentsTooltip connector={row.original} />,
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => (
        <TableRowActions
          actions={[
            {
              icon: <Pencil className="h-4 w-4" />,
              label: "Edit connector",
              onClick: () => setEditingConnector(row.original),
            },
            {
              icon: <Trash2 className="h-4 w-4" />,
              label: "Delete connector",
              variant: "destructive",
              onClick: () => setDeletingConnectorId(row.original.id),
            },
          ]}
        />
      ),
    },
  ];

  return (
    <KnowledgePageLayout
      title="Connectors"
      description="Manage data connectors that feed into your knowledge bases."
      createLabel="Create Connector"
      onCreateClick={() => setIsCreateDialogOpen(true)}
      isPending={isPending && !connectors}
    >
      <div>
        <div className="mb-6 flex flex-col gap-2">
          <div className="flex items-center gap-4">
            <SearchInput paramName="search" className="relative w-[330px]" />
            <Select
              value={connectorTypeFilter}
              onValueChange={handleConnectorTypeChange}
            >
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Filter by connector type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All connector types</SelectItem>
                {CONNECTOR_TYPE_OPTIONS.map((type) => (
                  <SelectItem key={type} value={type}>
                    <div className="flex items-center gap-2">
                      <ConnectorTypeIcon type={type} className="h-4 w-4" />
                      {CONNECTOR_TYPE_LABELS[type]}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DataTable
          columns={columns}
          data={items}
          getRowId={(row) => row.id}
          emptyMessage="No connectors found"
          hasActiveFilters={!!search || connectorTypeFilter !== "all"}
          onClearFilters={clearFilters}
          filteredEmptyMessage="No connectors match your filters. Try adjusting your search."
          hideSelectedCount
          manualPagination
          pagination={{
            pageIndex,
            pageSize,
            total: pagination?.total ?? 0,
          }}
          onPaginationChange={handlePaginationChange}
          isLoading={isFetching || isPending}
          onRowClick={(row) => router.push(`/knowledge/connectors/${row.id}`)}
        />

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

function AssignedAgentsTooltip({ connector }: { connector: ConnectorItem }) {
  const { assignedAgents } = connector;

  if (!assignedAgents || assignedAgents.length === 0) {
    return <span className="text-xs text-muted-foreground">Not assigned</span>;
  }

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
