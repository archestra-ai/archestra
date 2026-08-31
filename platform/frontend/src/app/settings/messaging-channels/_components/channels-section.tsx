"use client";

import type { AgentScope, archestraApiTypes } from "@archestra/shared";
import {
  Bot,
  CheckIcon,
  ChevronDown,
  ChevronUp,
  Hash,
  Inbox,
  MessageSquareText,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type MouseEvent, useCallback, useMemo, useRef, useState } from "react";
import { AgentBadge } from "@/components/agent-badge";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import Divider from "@/components/divider";
import { EmptyState } from "@/components/empty-state";
import {
  CollectionFilters,
  FilterBar,
  filterSearchClass,
} from "@/components/filter-bar";
import { LoadingState } from "@/components/loading";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TablePagination } from "@/components/ui/table-pagination";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useProfiles } from "@/lib/agent.query";
import { useSession } from "@/lib/auth/auth.query";
import { BulkRangeSelectionController } from "@/lib/bulk-range-selection";
import {
  useBulkUpdateChatOpsBindings,
  useChatOpsBindings,
  useChatOpsStatus,
  useCreateChatOpsDmBinding,
  useRefreshChatOpsChannelDiscovery,
  useUpdateChatOpsBinding,
} from "@/lib/chatops/chatops.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils";
import { ChannelDetailsDialog } from "./channel-details-dialog";
import { ChannelsEmptyState } from "./channels-empty-state";
import type { ProviderConfig } from "./types";

interface Agent {
  id: string;
  name: string;
  scope: AgentScope;
  authorId?: string | null;
}

const VIRTUAL_DM_ID = "__virtual-dm__";
type BindingsQuery = NonNullable<
  archestraApiTypes.ListChatOpsBindingsData["query"]
>;
type StatusFilter = "all" | NonNullable<BindingsQuery["status"]>;
type SortByColumn = NonNullable<BindingsQuery["sortBy"]>;
type SortDirection = NonNullable<BindingsQuery["sortDirection"]>;

export function ChannelsSection({
  providerConfig,
}: {
  providerConfig: ProviderConfig;
}) {
  const appName = useAppName();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Read pagination/filter state from URL params
  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const searchFromUrl = searchParams.get("search") || "";
  const statusFromUrl = (searchParams.get("status") as StatusFilter) || "all";
  const sortByFromUrl =
    (searchParams.get("sortBy") as SortByColumn) || "channelName";
  const sortDirectionFromUrl =
    (searchParams.get("sortDirection") as SortDirection) || "asc";
  const workspaceIdFromUrl = searchParams.get("workspaceId") || "";

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_TABLE_LIMIT);
  const offset = pageIndex * pageSize;

  // Data queries
  const {
    data: bindingsResponse,
    isLoading,
    isFetching,
    isLoadingError,
    refetch: refetchBindings,
  } = useChatOpsBindings({
    provider: providerConfig.provider,
    limit: pageSize,
    offset,
    sortBy: sortByFromUrl,
    sortDirection: sortDirectionFromUrl,
    search: searchFromUrl || undefined,
    workspaceId: workspaceIdFromUrl || undefined,
    status: statusFromUrl !== "all" ? statusFromUrl : undefined,
  });

  const { data: agents } = useProfiles({ filters: { agentType: "agent" } });
  const { data: chatOpsProviders } = useChatOpsStatus();
  const updateMutation = useUpdateChatOpsBinding();
  const bulkMutation = useBulkUpdateChatOpsBindings();
  const dmMutation = useCreateChatOpsDmBinding();
  const refreshMutation = useRefreshChatOpsChannelDiscovery();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const rangeSelection = useRef(new BulkRangeSelectionController());
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
  /** Binding whose editable details are open, if any. */
  const [instructionsBindingId, setInstructionsBindingId] = useState<
    string | null
  >(null);
  const [pendingReassignment, setPendingReassignment] =
    useState<PendingReassignment | null>(null);

  const toggleAll = useCallback((ids: string[], checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const providerStatus =
    chatOpsProviders?.find((p) => p.id === providerConfig.provider) ?? null;

  const bindings = bindingsResponse?.data ?? [];
  const pagination = bindingsResponse?.pagination;
  const counts = bindingsResponse?.counts;
  const workspaces = bindingsResponse?.workspaces ?? [];
  const hasDmBinding = bindingsResponse?.hasDmBinding ?? false;
  const workspacesWithUnmentionedTraffic = useMemo(
    () => new Set(bindingsResponse?.workspacesWithUnmentionedTraffic ?? []),
    [bindingsResponse?.workspacesWithUnmentionedTraffic],
  );
  const hasMultipleWorkspaces = workspaces.length > 1;
  const instructionsBinding =
    bindings.find((b) => b.id === instructionsBindingId) ?? null;

  const totalCount = (counts?.configured ?? 0) + (counts?.unassigned ?? 0);

  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  // Agent list + map
  const agentList = useMemo(
    () =>
      (agents ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        scope: a.scope,
        authorId: a.authorId,
      })),
    [agents],
  );

  // Virtual DM row logic
  const providerConfigured = providerStatus
    ? !!(providerStatus as { configured?: boolean }).configured
    : false;
  // Show virtual DM only when: no DM binding exists globally, first page, no search/workspace filter
  const showVirtualDmRow =
    (providerConfig.showVirtualDmRow ?? true) &&
    !hasDmBinding &&
    providerConfigured &&
    pageIndex === 0 &&
    !searchFromUrl &&
    statusFromUrl !== "configured" &&
    !workspaceIdFromUrl;
  const dmDeepLink = providerStatus
    ? (providerConfig.getDmDeepLink?.(providerStatus) ?? null)
    : null;

  // URL param updaters
  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const handleSearchChange = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

  const handleStatusChange = useCallback(
    (status: StatusFilter) => {
      clearSelection();
      updateUrlParams({
        status: status === "all" ? null : status,
        page: "1",
      });
    },
    [updateUrlParams, clearSelection],
  );

  const handleWorkspaceChange = useCallback(
    (wsId: string | null) => {
      clearSelection();
      updateUrlParams({ workspaceId: wsId, page: "1" });
    },
    [updateUrlParams, clearSelection],
  );

  const handleSortToggle = useCallback(
    (column: SortByColumn) => {
      clearSelection();
      if (sortByFromUrl === column) {
        updateUrlParams({
          sortDirection: sortDirectionFromUrl === "asc" ? "desc" : "asc",
          page: "1",
        });
      } else {
        updateUrlParams({ sortBy: column, sortDirection: "asc", page: "1" });
      }
    },
    [sortByFromUrl, sortDirectionFromUrl, updateUrlParams, clearSelection],
  );

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      clearSelection();
      updateUrlParams({
        page: String(newPagination.pageIndex + 1),
        pageSize: String(newPagination.pageSize),
      });
    },
    [updateUrlParams, clearSelection],
  );

  const applyAssignment = async ({
    ids,
    agentId,
    expectedAgentAssignments,
    includesVirtualDm,
    clearAfterSuccess,
  }: AssignmentRequest) => {
    const mutations: Promise<unknown>[] = [];
    if (ids.length > 0) {
      mutations.push(
        bulkMutation.mutateAsync({ ids, agentId, expectedAgentAssignments }),
      );
    }
    if (includesVirtualDm) {
      mutations.push(
        dmMutation.mutateAsync({
          provider: providerConfig.provider,
          agentId,
          requireNoExistingBinding: true,
        }),
      );
    }

    const results = await Promise.all(mutations);
    const succeeded = results.every(Boolean);
    if (succeeded && clearAfterSuccess) clearSelection();
    if (!succeeded) await refetchBindings();
    return succeeded;
  };

  const requestAssignment = (request: AssignmentRequest) => {
    const movedAssignments = request.expectedAgentAssignments.filter(
      (assignment) =>
        request.agentId !== null &&
        assignment.agentId !== null &&
        assignment.agentId !== request.agentId,
    );
    if (movedAssignments.length > 0) {
      const targetAgent = agentList.find(
        (agent) => agent.id === request.agentId,
      );
      setPendingReassignment({
        ...request,
        currentAgentNames: movedAssignments.map(
          (assignment) =>
            agentList.find((agent) => agent.id === assignment.agentId)?.name ??
            "Unknown agent",
        ),
        targetAgentName: targetAgent?.name ?? "Unknown agent",
      });
      return;
    }
    void applyAssignment(request);
  };

  const handleAssignAgent = ({
    bindingId,
    currentAgentId,
    agentId,
  }: {
    bindingId: string;
    currentAgentId: string | null;
    agentId: string | null;
  }) => {
    requestAssignment({
      ids: [bindingId],
      agentId,
      expectedAgentAssignments: [{ id: bindingId, agentId: currentAgentId }],
      includesVirtualDm: false,
      clearAfterSuccess: false,
    });
  };

  const handleToggleAnswerAll = (bindingId: string, answerAll: boolean) => {
    updateMutation.mutate({ id: bindingId, answerAllMessages: answerAll });
  };

  const handleSaveDetails = (params: {
    bindingId: string;
    channelInstructions: string | null;
    answerAllMessages: boolean;
  }) => {
    const binding = bindings.find((item) => item.id === params.bindingId);
    updateMutation.mutate(
      {
        id: params.bindingId,
        channelInstructions: params.channelInstructions,
        ...(!binding?.isDm &&
          binding?.provider !== "telegram" && {
            answerAllMessages: params.answerAllMessages,
          }),
      },
      { onSuccess: () => setInstructionsBindingId(null) },
    );
  };

  const handleDmAssignAgent = (agentId: string | null) => {
    dmMutation.mutate({ provider: providerConfig.provider, agentId });
  };

  const handleBulkAssign = (agentId: string | null) => {
    if (selectedIds.size === 0) return;
    const selectedBindings = bindings.filter((binding) =>
      selectedIds.has(binding.id),
    );
    requestAssignment({
      ids: selectedBindings.map((binding) => binding.id),
      agentId,
      expectedAgentAssignments: selectedBindings.map((binding) => ({
        id: binding.id,
        agentId: binding.agentId ?? null,
      })),
      includesVirtualDm: selectedIds.has(VIRTUAL_DM_ID),
      clearAfterSuccess: true,
    });
  };

  const hasActiveFilters =
    !!searchFromUrl || statusFromUrl !== "all" || !!workspaceIdFromUrl;
  const hasAnyChannels = totalCount > 0 || showVirtualDmRow || hasActiveFilters;
  const showFilteredEmptyState =
    hasActiveFilters && bindings.length === 0 && !showVirtualDmRow;

  // Selectable IDs on current page
  const selectableIds = useMemo(() => {
    const ids = bindings.map((b) => b.id);
    if (showVirtualDmRow) ids.push(VIRTUAL_DM_ID);
    return ids;
  }, [bindings, showVirtualDmRow]);
  const allChecked =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selectedIds.has(id));
  const someChecked =
    !allChecked && selectableIds.some((id) => selectedIds.has(id));
  const selectedBindings = bindings.filter((binding) =>
    selectedIds.has(binding.id),
  );
  const selectedDmsOnly =
    selectedIds.size > 0 &&
    selectedBindings.every((binding) => binding.isDm) &&
    selectedBindings.length + Number(selectedIds.has(VIRTUAL_DM_ID)) ===
      selectedIds.size;
  const selectedDmsOwnedByCurrentUser = selectedBindings.every(
    (binding) =>
      !binding.isDm ||
      binding.dmOwnerEmail?.toLowerCase() ===
        session?.user?.email?.toLowerCase(),
  );
  const handleSelectionClick = useCallback(
    (id: string, event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      event.preventDefault();
      setSelectedIds((current) => {
        const selection = Object.fromEntries(
          [...current].map((selectedId) => [selectedId, true]),
        );
        const next = rangeSelection.current.update({
          current: selection,
          orderedIds: selectableIds,
          targetId: id,
          range: event.shiftKey,
        });
        return new Set(Object.keys(next));
      });
    },
    [selectableIds],
  );

  const clearFilters = useCallback(() => {
    clearSelection();
    updateUrlParams({
      search: null,
      status: null,
      workspaceId: null,
      page: "1",
    });
  }, [clearSelection, updateUrlParams]);

  return (
    <section className="flex flex-col gap-3">
      <div>
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold relative">
            Channels
            {isFetching && (
              <LoadingState
                className="absolute right-[-24px] top-[5px]"
                variant="inline"
              />
            )}
          </h2>
        </div>
        <div className="text-xs text-muted-foreground mt-2 flex flex-col gap-2.5 max-w-3xl leading-relaxed">
          {providerConfig.channelsAppearNote ?? (
            <div>
              <div className="font-medium text-foreground mb-0.5">
                New channels
              </div>
              <p>
                New channels appear after adding the bot to a channel and the
                first interaction with it.
              </p>
            </div>
          )}
          <div>
            <div className="font-medium text-foreground mb-0.5">
              Default agents
            </div>
            <p>
              Then, assign a default agent to each channel you want {appName}{" "}
              bot to reply in. Use the Assign button below or{" "}
              <code className="bg-muted px-1 py-0.5 rounded text-xs">
                {providerConfig.slashCommand}
              </code>{" "}
              in {providerConfig.providerLabel}.
            </p>
          </div>
        </div>
      </div>

      {isLoading && !bindingsResponse ? (
        <ChannelTableSkeleton />
      ) : isLoadingError ? (
        <QueryLoadError
          title="Couldn't load your channels"
          onRetry={() => refetchBindings()}
        />
      ) : hasAnyChannels ? (
        <div>
          {/* Search + filters + bulk assign */}
          <CollectionFilters>
            <FilterBar
              onClearFilters={hasActiveFilters ? clearFilters : undefined}
              actions={
                <BulkAssignButton
                  agents={agentList}
                  currentUserId={currentUserId}
                  selectedCount={selectedIds.size}
                  selectedDmsOnly={selectedDmsOnly}
                  selectedDmsOwnedByCurrentUser={selectedDmsOwnedByCurrentUser}
                  isUpdating={bulkMutation.isPending || dmMutation.isPending}
                  onAssign={handleBulkAssign}
                />
              }
            >
              <SearchInput
                isLoading={isFetching}
                placeholder="Search channels..."
                paramName="search"
                className={filterSearchClass}
                debounceMs={300}
                onSearchChange={handleSearchChange}
              />

              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-8 rounded-full text-xs gap-1.5",
                  statusFromUrl === "all" && "bg-primary/10 text-primary",
                )}
                onClick={() => handleStatusChange("all")}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
                All{counts ? <span> ({totalCount})</span> : null}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-8 rounded-full text-xs gap-1.5",
                  statusFromUrl === "configured"
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground",
                )}
                onClick={() => handleStatusChange("configured")}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Configured{counts ? <span> ({counts.configured})</span> : null}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-8 rounded-full text-xs gap-1.5",
                  statusFromUrl === "unassigned"
                    ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground",
                )}
                onClick={() => handleStatusChange("unassigned")}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                Unassigned{counts ? <span> ({counts.unassigned})</span> : null}
              </Button>

              {hasMultipleWorkspaces && (
                <>
                  <span className="mx-1 hidden self-stretch border-l border-border sm:block" />
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "h-8 rounded-full text-xs",
                      !workspaceIdFromUrl && "bg-muted",
                    )}
                    onClick={() => handleWorkspaceChange(null)}
                  >
                    All workspaces
                  </Button>
                  {workspaces.map((ws) => (
                    <Button
                      key={ws.id}
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-8 rounded-full text-xs",
                        workspaceIdFromUrl === ws.id && "bg-muted",
                      )}
                      onClick={() => handleWorkspaceChange(ws.id)}
                    >
                      {ws.name}
                    </Button>
                  ))}
                </>
              )}
            </FilterBar>
          </CollectionFilters>

          {/* Table */}
          <div className="max-w-full overflow-x-auto rounded-md border">
            <Table className={CHANNEL_TABLE_MIN_WIDTH}>
              <TableHeader className="bg-muted border-b-2 border-border">
                <TableRow>
                  <TableHead className="w-[40px]">
                    <Checkbox
                      checked={
                        allChecked
                          ? true
                          : someChecked
                            ? "indeterminate"
                            : false
                      }
                      onCheckedChange={(checked) =>
                        toggleAll(selectableIds, !!checked)
                      }
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead>
                    <Button
                      variant="ghost"
                      className="h-auto !p-0 font-medium hover:bg-transparent"
                      onClick={() => handleSortToggle("channelName")}
                    >
                      Channel
                      <SortIcon
                        isSorted={
                          sortByFromUrl === "channelName"
                            ? sortDirectionFromUrl
                            : false
                        }
                      />
                    </Button>
                  </TableHead>
                  {/* `table-fixed` splits the leftover width evenly, so the
                      narrow columns are pinned to keep it for the two that
                      carry long names. */}
                  <TableHead>Default Agent</TableHead>
                  <TableHead className="w-[110px]">Instructions</TableHead>
                  {providerConfig.supportsAnswerAll && (
                    <TableHead className="w-[150px]">Replies to</TableHead>
                  )}
                  <TableHead className="w-[110px]">Status</TableHead>
                  <TableHead className="w-[80px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              {showFilteredEmptyState ? (
                <TableBody>
                  <TableRow>
                    <TableCell
                      colSpan={providerConfig.supportsAnswerAll ? 7 : 6}
                      className="h-48"
                    >
                      <EmptyState
                        className="py-0"
                        icon={Inbox}
                        title="No channels match your filters"
                        onClearFilters={clearFilters}
                      />
                    </TableCell>
                  </TableRow>
                </TableBody>
              ) : (
                <TableBody>
                  <ChannelRows
                    bindings={bindings}
                    agents={agentList}
                    currentUserId={currentUserId}
                    providerConfig={providerConfig}
                    providerStatus={providerStatus}
                    onAssignAgent={handleAssignAgent}
                    onToggleAnswerAll={handleToggleAnswerAll}
                    onEditInstructions={setInstructionsBindingId}
                    workspacesWithUnmentionedTraffic={
                      workspacesWithUnmentionedTraffic
                    }
                    isUpdating={
                      updateMutation.isPending || bulkMutation.isPending
                    }
                    selectedIds={selectedIds}
                    onSelectionClick={handleSelectionClick}
                    showVirtualDmRow={showVirtualDmRow}
                    dmDeepLink={dmDeepLink}
                    onDmAssignAgent={handleDmAssignAgent}
                    isDmUpdating={dmMutation.isPending}
                  />
                </TableBody>
              )}
            </Table>
          </div>

          {/* Pagination */}
          {pagination && (
            <TablePagination
              pageIndex={pageIndex}
              pageSize={pageSize}
              total={pagination.total}
              onPaginationChange={handlePaginationChange}
              leftContent={
                selectedIds.size > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {selectedIds.size} selected
                  </span>
                ) : undefined
              }
            />
          )}
        </div>
      ) : (
        <ChannelsEmptyState
          onRefresh={() => refreshMutation.mutate(providerConfig.provider)}
          isRefreshing={refreshMutation.isPending}
          provider={providerConfig.provider}
        />
      )}

      {instructionsBinding && (
        <ChannelDetailsDialog
          binding={instructionsBinding}
          assignedAgent={
            agentList.find(
              (agent) => agent.id === instructionsBinding.agentId,
            ) ?? null
          }
          open
          readOnly={false}
          onOpenChange={(next) => {
            if (!next) setInstructionsBindingId(null);
          }}
          isSaving={updateMutation.isPending}
          onSave={({ channelInstructions, answerAllMessages }) =>
            handleSaveDetails({
              bindingId: instructionsBinding.id,
              channelInstructions,
              answerAllMessages,
            })
          }
        />
      )}

      <DeleteConfirmDialog
        open={!!pendingReassignment}
        onOpenChange={(open) => {
          if (!open && !bulkMutation.isPending && !dmMutation.isPending) {
            setPendingReassignment(null);
          }
        }}
        title={
          pendingReassignment?.currentAgentNames.length === 1
            ? `Move channel to ${pendingReassignment.targetAgentName}?`
            : `Move ${pendingReassignment?.currentAgentNames.length ?? 0} channels to ${pendingReassignment?.targetAgentName ?? "this agent"}?`
        }
        description={reassignmentDescription(pendingReassignment)}
        isPending={bulkMutation.isPending || dmMutation.isPending}
        onConfirm={() => {
          if (!pendingReassignment) return;
          void applyAssignment(pendingReassignment).then(() => {
            setPendingReassignment(null);
          });
        }}
        confirmLabel={
          pendingReassignment?.currentAgentNames.length === 1
            ? "Move channel"
            : "Move channels"
        }
        pendingLabel="Moving..."
        confirmVariant="default"
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Channel rows (extracted to keep main component clean)
// ---------------------------------------------------------------------------

function ChannelRows({
  bindings,
  agents,
  currentUserId,
  providerConfig,
  providerStatus,
  onAssignAgent,
  onToggleAnswerAll,
  onEditInstructions,
  workspacesWithUnmentionedTraffic,
  isUpdating,
  selectedIds,
  onSelectionClick,
  showVirtualDmRow,
  dmDeepLink,
  onDmAssignAgent,
  isDmUpdating,
}: {
  bindings: Array<{
    id: string;
    channelId: string;
    channelName?: string | null;
    workspaceId?: string | null;
    workspaceName?: string | null;
    isDm?: boolean;
    agentId?: string | null;
    answerAllMessages?: boolean;
    channelInstructions?: string | null;
    dmOwnerEmail?: string | null;
  }>;
  agents: Agent[];
  currentUserId: string | undefined;
  providerConfig: ProviderConfig;
  providerStatus: {
    dmInfo?: { botUserId?: string; teamId?: string; appId?: string } | null;
  } | null;
  onAssignAgent: (assignment: {
    bindingId: string;
    currentAgentId: string | null;
    agentId: string | null;
  }) => void;
  onToggleAnswerAll: (bindingId: string, answerAll: boolean) => void;
  onEditInstructions: (bindingId: string) => void;
  workspacesWithUnmentionedTraffic: Set<string>;
  isUpdating: boolean;
  selectedIds: Set<string>;
  onSelectionClick: (id: string, event: MouseEvent<HTMLButtonElement>) => void;
  showVirtualDmRow: boolean;
  dmDeepLink: string | null;
  onDmAssignAgent: (agentId: string | null) => void;
  isDmUpdating: boolean;
}) {
  const { data: session } = useSession();
  const user = session?.user;
  const showAnswerAll = providerConfig.supportsAnswerAll;

  return (
    <>
      {showVirtualDmRow && (
        <TableRow>
          <TableCell>
            <Checkbox
              checked={selectedIds.has(VIRTUAL_DM_ID)}
              onClick={(event) => onSelectionClick(VIRTUAL_DM_ID, event)}
              aria-label="Select Direct Message"
            />
          </TableCell>
          <TableCell>
            <span className="text-sm font-medium">
              Direct Message ({user?.email})
            </span>
          </TableCell>
          <TableCell>
            <AgentPicker
              agents={agents}
              assignedAgent={undefined}
              isUpdating={isDmUpdating}
              onAssign={onDmAssignAgent}
              isDm
              currentUserId={currentUserId}
            />
          </TableCell>
          <TableCell>
            <InstructionsCell />
          </TableCell>
          {showAnswerAll && (
            <TableCell>
              <AnswerAllCell isDm />
            </TableCell>
          )}
          <TableCell>
            <StatusBadge assigned={false} />
          </TableCell>
          <TableCell className="pr-2">
            {dmDeepLink && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                asChild
              >
                <a
                  href={dmDeepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="!bg-transparent !px-0"
                >
                  <Image
                    src={providerConfig.providerIcon}
                    alt={providerConfig.providerLabel}
                    width={14}
                    height={14}
                  />
                  Open
                </a>
              </Button>
            )}
          </TableCell>
        </TableRow>
      )}
      {bindings.length === 0 && !showVirtualDmRow && (
        <TableRow>
          <TableCell
            colSpan={showAnswerAll ? 7 : 6}
            className="h-16 text-center text-sm text-muted-foreground"
          >
            No matching channels
          </TableCell>
        </TableRow>
      )}
      {bindings.map((binding) => {
        const assignedAgent = binding.agentId
          ? agents.find((a) => a.id === binding.agentId)
          : undefined;
        const pendingDm =
          binding.isDm && binding.channelId.startsWith("dm:pending:");
        const deepLink = pendingDm
          ? null
          : binding.isDm
            ? providerStatus
              ? providerConfig.getDmDeepLink?.(providerStatus, binding)
              : null
            : providerConfig.buildDeepLink(binding);

        return (
          <TableRow key={binding.id}>
            <TableCell>
              <Checkbox
                checked={selectedIds.has(binding.id)}
                onClick={(event) => onSelectionClick(binding.id, event)}
                aria-label={`Select ${binding.channelName ?? binding.channelId}`}
              />
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-1.5">
                {binding.isDm ? (
                  <span className="text-sm font-medium">
                    Direct Message ({binding.dmOwnerEmail ?? "Unknown owner"})
                  </span>
                ) : (
                  <>
                    <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="text-sm font-medium truncate">
                      {binding.channelName ?? binding.channelId}
                    </span>
                  </>
                )}
              </div>
            </TableCell>
            <TableCell>
              <AgentPicker
                agents={agents}
                assignedAgent={assignedAgent}
                isUpdating={isUpdating}
                onAssign={(agentId) =>
                  onAssignAgent({
                    bindingId: binding.id,
                    currentAgentId: binding.agentId ?? null,
                    agentId,
                  })
                }
                isDm={binding.isDm}
                currentUserId={currentUserId}
                dmOwnedByCurrentUser={
                  !binding.isDm ||
                  binding.dmOwnerEmail?.toLowerCase() ===
                    user?.email?.toLowerCase()
                }
              />
            </TableCell>
            <TableCell>
              <InstructionsCell
                instructions={binding.channelInstructions ?? null}
                onEdit={() => onEditInstructions(binding.id)}
              />
            </TableCell>
            {showAnswerAll && (
              <TableCell>
                <AnswerAllCell
                  isDm={binding.isDm}
                  checked={!!binding.answerAllMessages}
                  disabled={isUpdating}
                  onToggle={(value) => onToggleAnswerAll(binding.id, value)}
                  unverified={
                    !!providerConfig.answerAllNeedsConsent &&
                    !workspacesWithUnmentionedTraffic.has(
                      binding.workspaceId ?? "",
                    )
                  }
                />
              </TableCell>
            )}
            <TableCell>
              <StatusBadge assigned={!!binding.agentId} />
            </TableCell>
            <TableCell className="pr-2">
              {deepLink && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  asChild
                >
                  <a
                    href={deepLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="!bg-transparent !px-0"
                  >
                    <Image
                      src={providerConfig.providerIcon}
                      alt={providerConfig.providerLabel}
                      width={14}
                      height={14}
                    />
                    Open
                  </a>
                </Button>
              )}
            </TableCell>
          </TableRow>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sort icon (matches agents page pattern)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Bulk assign button with agent picker popover
// ---------------------------------------------------------------------------

function BulkAssignButton({
  agents,
  currentUserId,
  selectedCount,
  selectedDmsOnly,
  selectedDmsOwnedByCurrentUser,
  isUpdating,
  onAssign,
}: {
  agents: Agent[];
  currentUserId: string | undefined;
  selectedCount: number;
  selectedDmsOnly: boolean;
  selectedDmsOwnedByCurrentUser: boolean;
  isUpdating: boolean;
  onAssign: (agentId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex items-center gap-2">
      {selectedCount > 0 && (
        <span className="text-xs text-muted-foreground">
          {selectedCount} selected
        </span>
      )}
      <Popover open={open} onOpenChange={setOpen} modal>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 text-xs"
            disabled={selectedCount === 0 || isUpdating}
          >
            <Bot className="h-3.5 w-3.5" />
            Bulk Assign
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="end">
          <Command>
            <CommandInput placeholder="Search agents..." />
            <CommandList>
              <CommandEmpty>
                <div className="px-2 py-3 text-center">
                  <p className="text-sm">No agents found.</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Only organization and team agents can be a channel's
                    default. Personal agents are available in direct messages
                    only.
                  </p>
                </div>
              </CommandEmpty>
              <CommandGroup>
                <CommandItem
                  onSelect={() => {
                    onAssign(null);
                    setOpen(false);
                  }}
                >
                  <X className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Unassign</span>
                </CommandItem>
                <Divider className="my-1" />
                {agents.map((agent) => {
                  const disabledReason = agentDisabledReason({
                    agent,
                    isDm: selectedDmsOnly,
                    currentUserId,
                    dmOwnedByCurrentUser: selectedDmsOwnedByCurrentUser,
                  });
                  return (
                    <CommandItem
                      key={agent.id}
                      value={agent.name}
                      disabled={!!disabledReason}
                      onSelect={() => {
                        if (disabledReason) return;
                        onAssign(agent.id);
                        setOpen(false);
                      }}
                    >
                      <Bot className="mr-2 h-4 w-4" />
                      <span className="truncate">{agent.name}</span>
                      <AgentBadge type={agent.scope} />
                      {disabledReason && (
                        <span className="ml-auto text-xs text-muted-foreground">
                          {disabledReason}
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ assigned }: { assigned: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full",
        assigned
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          assigned ? "bg-emerald-500" : "bg-amber-500",
        )}
      />
      {assigned ? "Active" : "Inactive"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Per-channel "answer all messages" toggle
// ---------------------------------------------------------------------------

/**
 * The Instructions column: a button that opens the editor, labelled by whether
 * the channel already has instructions, with the text itself in a tooltip so
 * the table shows what is configured without opening anything.
 *
 * Rendered with no props for the placeholder DM row, which has no binding yet —
 * there is nothing to attach instructions to until an agent is assigned.
 */
function InstructionsCell({
  instructions,
  onEdit,
}: {
  instructions?: string | null;
  onEdit?: () => void;
}) {
  if (!onEdit) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const button = (
    <Button
      variant="ghost"
      size="sm"
      // -ml-2 cancels the button's own px-2 so the icon starts on the column's
      // text origin, level with the "Instructions" header and with the dash the
      // agent-less row renders. Keeping px-2 (rather than dropping it) leaves
      // the hover target its padding, same as the file-detail header's button.
      className="-ml-2 h-7 gap-1.5 px-2 text-xs"
      onClick={onEdit}
    >
      <MessageSquareText
        className={cn(
          "h-3.5 w-3.5",
          instructions ? "text-primary" : "text-muted-foreground",
        )}
      />
      <span className={instructions ? undefined : "text-muted-foreground"}>
        {instructions ? "Edit" : "Add"}
      </span>
    </Button>
  );
  if (!instructions) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent className="max-w-sm whitespace-pre-wrap text-left">
        {instructions}
      </TooltipContent>
    </Tooltip>
  );
}

function AnswerAllCell({
  isDm,
  checked = false,
  disabled = false,
  onToggle,
  unverified = false,
}: {
  isDm?: boolean;
  checked?: boolean;
  disabled?: boolean;
  onToggle?: (value: boolean) => void;
  /**
   * Answer-all is on, but no un-mentioned message has arrived from this
   * workspace yet — so the setting may be inert for want of the provider-side
   * permission. Only ever a hint: a channel nobody has posted in looks the same,
   * so the toggle stays usable.
   */
  unverified?: boolean;
}) {
  // DMs always reply to every message, so the per-channel toggle doesn't apply.
  if (isDm) {
    return <span className="text-xs text-muted-foreground">All messages</span>;
  }
  return (
    <div className="flex items-center gap-2">
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onToggle?.(value)}
        aria-label="Answer all messages in this channel"
      />
      <span className="text-xs text-muted-foreground">
        {checked ? "All messages" : "Mentions only"}
      </span>
      {checked && unverified && (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A bare svg can't take focus, and the tooltip is the only place
                the fix is written down — so this needs a real button. */}
            <button
              type="button"
              className="shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="No un-mentioned messages received from this workspace yet — how to fix"
            >
              <TriangleAlert className="h-3.5 w-3.5 text-amber-500" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            No un-mentioned messages have arrived from this workspace yet. If
            the bot stays quiet here, reinstall the app so a team owner is asked
            to grant permission for it to read channel messages.
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent picker popover
// ---------------------------------------------------------------------------

function AgentPicker({
  agents,
  assignedAgent,
  isUpdating,
  onAssign,
  isDm = false,
  currentUserId,
  dmOwnedByCurrentUser = true,
}: {
  agents: Agent[];
  assignedAgent: Agent | undefined;
  isUpdating: boolean;
  onAssign: (agentId: string | null) => void;
  isDm?: boolean;
  currentUserId: string | undefined;
  dmOwnedByCurrentUser?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      {assignedAgent ? (
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            // max-w-full so a long agent name truncates inside its cell
            // instead of widening the button over the next column — the table
            // is `table-fixed`, so the cell will not grow to fit it.
            className="h-7 gap-1.5 text-xs min-w-[180px] max-w-full"
            disabled={isUpdating}
          >
            <Bot className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{assignedAgent.name}</span>
            <AgentBadge
              type={assignedAgent.scope}
              className="px-1 py-0 ml-auto"
            />
          </Button>
        </PopoverTrigger>
      ) : (
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 gap-1.5 text-xs"
            disabled={isUpdating}
          >
            <Plus className="h-3.5 w-3.5" />
            Assign
          </Button>
        </PopoverTrigger>
      )}
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search agents..." />
          <CommandList>
            <CommandEmpty>
              <div className="px-2 py-3 text-center">
                <p className="text-sm">No agents found.</p>
                {!isDm && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Only organization and team agents can be a channel's
                    default. Personal agents are available in direct messages
                    only.
                  </p>
                )}
              </div>
            </CommandEmpty>
            <CommandGroup>
              {assignedAgent && (
                <>
                  <CommandItem
                    onSelect={() => {
                      onAssign(null);
                      setOpen(false);
                    }}
                  >
                    <X className="mr-2 h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Unassign</span>
                  </CommandItem>
                  <Divider className="my-1" />
                </>
              )}
              {agents.map((agent) => {
                const disabledReason = agentDisabledReason({
                  agent,
                  isDm,
                  currentUserId,
                  dmOwnedByCurrentUser,
                });
                return (
                  <CommandItem
                    key={agent.id}
                    value={agent.name}
                    disabled={!!disabledReason}
                    onSelect={() => {
                      if (disabledReason) return;
                      onAssign(agent.id);
                      setOpen(false);
                    }}
                  >
                    <Bot className="mr-2 h-4 w-4" />
                    <span className="truncate">{agent.name}</span>
                    <AgentBadge type={agent.scope} className="ml-auto" />
                    {assignedAgent?.id === agent.id && (
                      <CheckIcon className="h-4 w-4" />
                    )}
                    {disabledReason && (
                      <span className="text-xs text-muted-foreground">
                        {disabledReason}
                      </span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

/**
 * Placeholder for the first load. Its columns and width floor mirror the loaded
 * table's, so the page does not reflow the moment the data lands.
 */
function ChannelTableSkeleton() {
  return (
    <div className="max-w-full overflow-x-auto rounded-md border">
      <Table className={CHANNEL_TABLE_MIN_WIDTH}>
        <TableHeader className="bg-muted border-b-2 border-border">
          <TableRow>
            <TableHead className="w-[40px]" />
            <TableHead>Channel</TableHead>
            <TableHead>Default Agent</TableHead>
            <TableHead className="w-[110px]">Instructions</TableHead>
            <TableHead className="w-[110px]">Status</TableHead>
            <TableHead className="w-[80px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[1, 2, 3].map((i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton className="h-4 w-4 rounded" />
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  <Skeleton className="h-3.5 w-3.5 rounded" />
                  <Skeleton className="h-4 w-28" />
                </div>
              </TableCell>
              <TableCell>
                <Skeleton className="h-7 w-20 rounded" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-7 w-12 rounded" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-20 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-7 w-14 rounded" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * `table-fixed` shrinks every column to fit, so on a narrow viewport the cells
 * stop being wide enough for their content and it spills over the neighbouring
 * column. A floor lets the table's own horizontal scroll take over instead.
 */
const CHANNEL_TABLE_MIN_WIDTH = "min-w-[70rem]";

type AssignmentRequest = {
  ids: string[];
  agentId: string | null;
  expectedAgentAssignments: Array<{ id: string; agentId: string | null }>;
  includesVirtualDm: boolean;
  clearAfterSuccess: boolean;
};

type PendingReassignment = AssignmentRequest & {
  currentAgentNames: string[];
  targetAgentName: string;
};

function agentDisabledReason({
  agent,
  isDm,
  currentUserId,
  dmOwnedByCurrentUser = true,
}: {
  agent: Agent;
  isDm: boolean;
  currentUserId: string | undefined;
  dmOwnedByCurrentUser?: boolean;
}) {
  if (!isDm && agent.scope === "personal") {
    return "Personal agents can only receive direct messages.";
  }
  if (isDm && agent.scope === "personal" && agent.authorId !== currentUserId) {
    return "Only your personal agents can receive direct messages.";
  }
  if (isDm && agent.scope === "personal" && !dmOwnedByCurrentUser) {
    return "Personal agents can only be assigned to your own direct messages.";
  }
  return null;
}

function reassignmentDescription(reassignment: PendingReassignment | null) {
  if (!reassignment) return "";
  const currentAgents = [...new Set(reassignment.currentAgentNames)].join(", ");
  const channels =
    reassignment.currentAgentNames.length === 1
      ? "this channel"
      : "these channels";
  return `Each messaging channel can be assigned to only one agent at a time. New messages will go to ${reassignment.targetAgentName}. ${currentAgents} will stop receiving messages from ${channels}.`;
}
