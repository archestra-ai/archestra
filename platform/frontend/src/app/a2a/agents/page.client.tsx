"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type {
  ColumnDef,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  CollectionFilters,
  FilterBar,
  filterSearchClass,
} from "@/components/filter-bar";
import { FormDialog } from "@/components/form-dialog";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import {
  TableCard,
  TableCardList,
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
} from "@/components/table-card-view";
import { Badge } from "@/components/ui/badge";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_SORT_BY, DEFAULT_SORT_DIRECTION } from "@/consts";
import {
  useA2aRemoteAgentRuns,
  useA2aRemoteAgents,
  useCreateA2aRemoteAgent,
  useDeleteA2aRemoteAgent,
  useInspectA2aRemoteAgent,
} from "@/lib/a2a-remote-agents.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { reportBulkOutcome, runBulkAction } from "@/lib/bulk-action";
import { useBulkCardSelection } from "@/lib/hooks/use-bulk-card-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";

type DiscoveryMode = "well_known" | "card_url" | "inline_card";
type AuthType = "none" | "bearer" | "api_key";
type RemoteAgent =
  archestraApiTypes.ListA2aRemoteAgentsResponses["200"][number];
type A2aSortBy = "name" | "createdAt" | "updatedAt";

function SortIcon({ isSorted }: { isSorted: false | "asc" | "desc" }) {
  const upArrow = <ChevronUp className="h-3 w-3" />;
  const downArrow = <ChevronDown className="h-3 w-3" />;
  if (isSorted === "asc") return upArrow;
  if (isSorted === "desc") return downArrow;
  return (
    <div className="text-muted-foreground flex flex-col items-center">
      {upArrow}
      <span className="mt-[-4px]">{downArrow}</span>
    </div>
  );
}

function isA2aSortBy(value: string | null): value is A2aSortBy {
  return value === "name" || value === "createdAt" || value === "updatedAt";
}

function compareRemoteAgents(
  left: RemoteAgent,
  right: RemoteAgent,
  sorting: SortingState,
) {
  const activeSort = sorting[0];
  if (!activeSort) return 0;

  const leftValue =
    activeSort.id === "name"
      ? left.name
      : activeSort.id === "updatedAt"
        ? left.updatedAt
        : left.createdAt;
  const rightValue =
    activeSort.id === "name"
      ? right.name
      : activeSort.id === "updatedAt"
        ? right.updatedAt
        : right.createdAt;
  const result = leftValue.localeCompare(rightValue);
  if (result !== 0) return activeSort.desc ? -result : result;
  return left.name.localeCompare(right.name);
}

export default function OutboundA2aAgentsPage() {
  const {
    searchParams,
    pageIndex,
    pageSize,
    updateQueryParams,
    setPagination,
  } = useDataTableQueryParams();
  const query = useA2aRemoteAgents();
  const { data: canManage } = useHasPermissions({
    agentSettings: ["update"],
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RemoteAgent | null>(null);
  const deleteMutation = useDeleteA2aRemoteAgent();
  const bulkDeleteMutation = useDeleteA2aRemoteAgent({ notify: false });
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const remoteAgents = query.data ?? [];

  const nameFilter = searchParams.get("name") || "";
  const sortByFromUrl = searchParams.get("sortBy");
  const sortDirectionFromUrl = searchParams.get("sortDirection");
  const sortBy: A2aSortBy = isA2aSortBy(sortByFromUrl)
    ? sortByFromUrl
    : isA2aSortBy(DEFAULT_SORT_BY)
      ? DEFAULT_SORT_BY
      : "createdAt";
  const sortDirection =
    sortDirectionFromUrl === "asc" || sortDirectionFromUrl === "desc"
      ? sortDirectionFromUrl
      : DEFAULT_SORT_DIRECTION;
  const [sorting, setSorting] = useState<SortingState>([
    { id: sortBy, desc: sortDirection === "desc" },
  ]);

  useEffect(() => {
    setSorting([{ id: sortBy, desc: sortDirection === "desc" }]);
  }, [sortBy, sortDirection]);

  const handleSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      const nextSorting =
        typeof updater === "function" ? updater(sorting) : updater;
      setSorting(nextSorting);

      if (nextSorting.length > 0 && isA2aSortBy(nextSorting[0].id)) {
        updateQueryParams({
          page: "1",
          sortBy: nextSorting[0].id,
          sortDirection: nextSorting[0].desc ? "desc" : "asc",
        });
      } else {
        updateQueryParams({
          page: "1",
          sortBy: null,
          sortDirection: null,
        });
      }
    },
    [sorting, updateQueryParams],
  );

  const filteredAgents = useMemo(() => {
    const normalizedFilter = nameFilter.trim().toLocaleLowerCase();
    return remoteAgents
      .filter(
        (agent) =>
          !normalizedFilter ||
          agent.name.toLocaleLowerCase().includes(normalizedFilter),
      )
      .sort((left, right) => compareRemoteAgents(left, right, sorting));
  }, [nameFilter, remoteAgents, sorting]);

  const totalPages = Math.max(Math.ceil(filteredAgents.length / pageSize), 1);
  useEffect(() => {
    if (pageIndex > 0 && pageIndex >= totalPages) {
      setPagination({ pageIndex: totalPages - 1, pageSize });
    }
  }, [pageIndex, pageSize, setPagination, totalPages]);

  const visibleAgents = filteredAgents.slice(
    pageIndex * pageSize,
    (pageIndex + 1) * pageSize,
  );
  const cardSelection = useBulkCardSelection({
    rows: visibleAgents,
    getRowId: (agent) => agent.id,
    rowSelection,
    setRowSelection,
  });
  const selectedRemoteAgents = visibleAgents.filter(
    (agent) => rowSelection[agent.id],
  );
  const clearSelection = () => setRowSelection({});

  const handlePaginationChange = useCallback(
    (pagination: { pageIndex: number; pageSize: number }) => {
      setPagination(pagination);
    },
    [setPagination],
  );

  const clearFilters = useCallback(() => {
    updateQueryParams({ page: "1", name: null });
  }, [updateQueryParams]);

  const columns = useMemo<ColumnDef<RemoteAgent>[]>(
    () => [
      ...(canManage
        ? [
            createSelectColumn<RemoteAgent>({
              rowLabel: (agent) => `Select ${agent.name}`,
              allLabel: "Select all external A2A agents on this page",
            }),
          ]
        : []),
      {
        id: "icon",
        size: 40,
        enableSorting: false,
        header: "",
        cell: () => (
          <div className="flex items-center justify-center">
            <AgentIcon size={20} />
          </div>
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        size: 240,
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Name
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.original.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.original.description || "External A2A agent"}
            </div>
          </div>
        ),
      },
      {
        id: "protocol",
        header: "Protocol",
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant="outline">
            {row.original.connection.selectedInterface.protocolBinding}
          </Badge>
        ),
      },
      {
        id: "status",
        header: "Status",
        enableSorting: false,
        cell: ({ row }) => (
          <Badge
            variant={row.original.connection.enabled ? "default" : "secondary"}
          >
            {row.original.connection.enabled ? "Enabled" : "Disabled"}
          </Badge>
        ),
      },
      {
        id: "endpoint",
        header: "Endpoint",
        enableSorting: false,
        cell: ({ row }) => (
          <span
            className="block max-w-64 truncate text-sm"
            title={row.original.connection.selectedInterface.url}
          >
            {row.original.connection.selectedInterface.url}
          </span>
        ),
      },
      {
        id: "activity",
        header: "Recent activity",
        enableSorting: false,
        cell: ({ row }) => <RecentRun remoteAgentId={row.original.id} />,
      },
      {
        id: "actions",
        header: "Actions",
        enableHiding: false,
        size: 88,
        cell: ({ row }) =>
          canManage ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${row.original.name}`}
              onClick={() => setDeleteTarget(row.original)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : null,
      },
    ],
    [canManage],
  );

  const showLoading = query.isPending && remoteAgents.length === 0;
  const pagination = {
    pageIndex,
    pageSize,
    total: filteredAgents.length,
  };

  const handleBulkDelete = async () => {
    const outcome = await runBulkAction({
      items: selectedRemoteAgents,
      run: (agent) => bulkDeleteMutation.mutateAsync(agent.id),
      describe: (agent) => agent.name,
    });
    reportBulkOutcome({
      outcome,
      verb: "Deleted",
      failureVerb: "delete",
      noun: "external A2A agent",
    });
    setBulkDeleteOpen(false);
    if (outcome.failed.length === 0) clearSelection();
  };

  return (
    <PageLayout
      title="External A2A agents"
      description="Connect Agent2Agent-compatible systems, then assign them from an agent's Subagents section."
      actionButton={
        canManage ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            Connect agent
          </Button>
        ) : undefined
      }
    >
      {query.isLoadingError ? (
        <QueryLoadError
          title="External A2A agents could not be loaded"
          description="Retry the connection to load configured external agents."
          onRetry={() => query.refetch()}
        />
      ) : (
        <TableCardView storageKey="archestra-a2a-agents-view">
          <CollectionFilters>
            <FilterBar leading actions={<TableCardViewToggle />}>
              <SearchInput
                isLoading={query.isFetching}
                objectNamePlural="external A2A agents"
                searchFields={["name"]}
                paramName="name"
                className={filterSearchClass}
              />
            </FilterBar>
          </CollectionFilters>

          <BulkActions
            count={selectedRemoteAgents.length}
            noun="external A2A agent"
            onClear={clearSelection}
            busy={bulkDeleteMutation.isPending}
          >
            {canManage && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setBulkDeleteOpen(true)}
              >
                <Trash2 className="h-4 w-4" />
                <span>Delete</span>
              </Button>
            )}
          </BulkActions>

          <TableCardViewContent
            cards={
              <TableCardList
                itemCount={visibleAgents.length}
                isLoading={showLoading}
                emptyIcon={Bot}
                emptyMessage="No external A2A agents connected"
                emptyDescription="Start with a well-known Agent Card URL or paste a card manually."
                hasActiveFilters={!!nameFilter}
                filteredEmptyMessage="No external A2A agents match your search"
                onClearFilters={clearFilters}
                pagination={pagination}
                onPaginationChange={handlePaginationChange}
              >
                {visibleAgents.map((agent) => (
                  <TableCard
                    key={agent.id}
                    testId={`a2a-remote-agent-card-${agent.id}`}
                    icon={<AgentIcon size={20} />}
                    title={agent.name}
                    description={agent.description || "External A2A agent"}
                    actions={
                      canManage ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${agent.name}`}
                          onClick={() => setDeleteTarget(agent)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      ) : undefined
                    }
                    footer={
                      canManage ? (
                        <RecentRun remoteAgentId={agent.id} />
                      ) : undefined
                    }
                    {...(canManage ? cardSelection(agent) : {})}
                    selectionLabel={`Select ${agent.name}`}
                  >
                    <div className="space-y-3">
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="secondary">A2A 1.x</Badge>
                        <Badge variant="outline">
                          {agent.connection.selectedInterface.protocolBinding}
                        </Badge>
                        <Badge
                          variant={
                            agent.connection.enabled ? "default" : "secondary"
                          }
                        >
                          {agent.connection.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </div>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                        <dt className="text-muted-foreground">Discovery</dt>
                        <dd className="truncate">
                          {agent.discoveryMode.replaceAll("_", " ")}
                        </dd>
                        <dt className="text-muted-foreground">
                          Authentication
                        </dt>
                        <dd>
                          {agent.connection.authType.replaceAll("_", " ")}
                        </dd>
                        <dt className="text-muted-foreground">Endpoint</dt>
                        <dd
                          className="truncate"
                          title={agent.connection.selectedInterface.url}
                        >
                          {agent.connection.selectedInterface.url}
                        </dd>
                      </dl>
                    </div>
                  </TableCard>
                ))}
              </TableCardList>
            }
            table={
              <DataTable
                columns={columns}
                data={visibleAgents}
                isLoading={showLoading}
                getRowId={(agent) => agent.id}
                rowSelection={rowSelection}
                onRowSelectionChange={setRowSelection}
                hideSelectedCount
                sorting={sorting}
                onSortingChange={handleSortingChange}
                manualSorting
                manualPagination
                pagination={pagination}
                onPaginationChange={handlePaginationChange}
                emptyIcon={Bot}
                emptyMessage="No external A2A agents connected"
                emptyDescription="Start with a well-known Agent Card URL or paste a card manually."
                hasActiveFilters={!!nameFilter}
                filteredEmptyMessage="No external A2A agents match your search"
                onClearFilters={clearFilters}
              />
            }
          />
        </TableCardView>
      )}

      <ConnectA2aAgentDialog open={createOpen} onOpenChange={setCreateOpen} />
      <DeleteConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Remove external A2A agent?"
        description={
          deleteTarget
            ? `This removes ${deleteTarget.name} and its stored connection credential.`
            : ""
        }
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          deleteMutation.mutate(deleteTarget.id, {
            onSuccess: () => setDeleteTarget(null),
          });
        }}
      />
      <DeleteConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title="Delete external A2A agents"
        description={`Delete ${selectedRemoteAgents.length} ${
          selectedRemoteAgents.length === 1
            ? "external A2A agent"
            : "external A2A agents"
        }? This cannot be undone.`}
        isPending={bulkDeleteMutation.isPending}
        onConfirm={() => {
          void handleBulkDelete();
        }}
        confirmLabel="Delete external A2A agents"
        pendingLabel="Deleting..."
      />
    </PageLayout>
  );
}

function RecentRun({ remoteAgentId }: { remoteAgentId: string }) {
  const query = useA2aRemoteAgentRuns(remoteAgentId);
  const run = query.data?.[0];
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Activity className="h-3.5 w-3.5" />
        Recent activity
      </span>
      {query.isPending ? (
        <span className="text-muted-foreground">Loading…</span>
      ) : query.isError ? (
        <span className="text-destructive">Unavailable</span>
      ) : run ? (
        <span title={new Date(run.startedAt).toLocaleString()}>
          {run.state.replaceAll("_", " ")} ·{" "}
          {new Date(run.startedAt).toLocaleDateString()}
        </span>
      ) : (
        <span className="text-muted-foreground">No runs yet</span>
      )}
    </div>
  );
}

function ConnectA2aAgentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<DiscoveryMode>("well_known");
  const [url, setUrl] = useState("");
  const [agentCard, setAgentCard] = useState("");
  const [name, setName] = useState("");
  const [authType, setAuthType] = useState<AuthType>("none");
  const [headerName, setHeaderName] = useState("X-API-Key");
  const [credential, setCredential] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const inspectMutation = useInspectA2aRemoteAgent();
  const createMutation = useCreateA2aRemoteAgent();

  const buildBody = () => {
    let source: archestraApiTypes.InspectA2aRemoteAgentData["body"]["source"];
    if (mode === "inline_card") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(agentCard);
      } catch {
        setParseError("Agent Card must be valid JSON.");
        return null;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setParseError("Agent Card must be a JSON object.");
        return null;
      }
      source = {
        type: "inline_card",
        agentCard: parsed as Record<string, unknown>,
      };
    } else {
      source = { type: mode, url };
    }
    setParseError(null);
    const auth =
      authType === "none"
        ? ({ type: "none" } as const)
        : authType === "bearer"
          ? ({ type: "bearer", credential } as const)
          : ({ type: "api_key", headerName, credential } as const);
    return { source, auth };
  };

  const reset = () => {
    setMode("well_known");
    setUrl("");
    setAgentCard("");
    setName("");
    setAuthType("none");
    setHeaderName("X-API-Key");
    setCredential("");
    setParseError(null);
    inspectMutation.reset();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      title="Connect external A2A agent"
      description="Discover a protocol endpoint from its Agent Card. Credentials are stored separately from the card."
      size="medium"
    >
      <DialogForm
        onSubmit={(event) => {
          event.preventDefault();
          const body = buildBody();
          if (!body) return;
          createMutation.mutate(
            { ...body, name: name || undefined, connectionName: "Default" },
            {
              onSuccess: () => {
                onOpenChange(false);
                reset();
              },
            },
          );
        }}
      >
        <DialogBody className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="a2a-discovery-mode">Agent Card source</Label>
            <Select
              value={mode}
              onValueChange={(value) => {
                setMode(value as DiscoveryMode);
                inspectMutation.reset();
              }}
            >
              <SelectTrigger id="a2a-discovery-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="well_known">Well-known URL</SelectItem>
                <SelectItem value="card_url">Direct Agent Card URL</SelectItem>
                <SelectItem value="inline_card">
                  Paste Agent Card JSON
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {mode === "inline_card" ? (
            <div className="space-y-2">
              <Label htmlFor="a2a-agent-card">Agent Card JSON</Label>
              <Textarea
                id="a2a-agent-card"
                rows={9}
                value={agentCard}
                onChange={(event) => {
                  setAgentCard(event.target.value);
                  inspectMutation.reset();
                }}
                placeholder='{"name":"My agent", ...}'
                required
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="a2a-url">
                {mode === "well_known" ? "Agent base URL" : "Agent Card URL"}
              </Label>
              <Input
                id="a2a-url"
                type="url"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  inspectMutation.reset();
                }}
                placeholder="https://agent.example.com"
                required
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="a2a-name">Display name (optional)</Label>
            <Input
              id="a2a-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Uses the Agent Card name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="a2a-auth">Authentication</Label>
            <Select
              value={authType}
              onValueChange={(value) => {
                setAuthType(value as AuthType);
                inspectMutation.reset();
              }}
            >
              <SelectTrigger id="a2a-auth">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="bearer">Bearer token</SelectItem>
                <SelectItem value="api_key">API key header</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {authType === "api_key" && (
            <div className="space-y-2">
              <Label htmlFor="a2a-header">Header name</Label>
              <Input
                id="a2a-header"
                value={headerName}
                onChange={(event) => {
                  setHeaderName(event.target.value);
                  inspectMutation.reset();
                }}
                required
              />
            </div>
          )}
          {authType !== "none" && (
            <div className="space-y-2">
              <Label htmlFor="a2a-credential">Credential</Label>
              <Input
                id="a2a-credential"
                type="password"
                value={credential}
                onChange={(event) => {
                  setCredential(event.target.value);
                  inspectMutation.reset();
                }}
                autoComplete="new-password"
                required
              />
            </div>
          )}
          {parseError && (
            <p role="alert" className="text-sm text-destructive">
              {parseError}
            </p>
          )}
          {inspectMutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              The Agent Card could not be reached or validated.
            </p>
          )}
          {inspectMutation.data && (
            <output className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
              <CheckCircle2 className="mt-0.5 h-4 w-4 text-green-600" />
              <div>
                <p className="font-medium">{inspectMutation.data.name}</p>
                <p className="text-muted-foreground">
                  {inspectMutation.data.selectedInterface.protocolBinding} ·{" "}
                  {inspectMutation.data.selectedInterface.protocolVersion}
                </p>
              </div>
            </output>
          )}
        </DialogBody>
        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            disabled={inspectMutation.isPending || createMutation.isPending}
            onClick={() => {
              const body = buildBody();
              if (body) inspectMutation.mutate(body);
            }}
          >
            {inspectMutation.isPending ? "Checking…" : "Validate Agent Card"}
          </Button>
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Connecting…" : "Connect agent"}
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}
