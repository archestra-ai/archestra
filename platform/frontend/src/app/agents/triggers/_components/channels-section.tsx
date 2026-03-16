"use client";

import type { AgentScope, archestraApiTypes } from "@shared";
import {
  Bot,
  CheckIcon,
  ChevronDown,
  ChevronUp,
  Hash,
  Plus,
  Search,
  X,
} from "lucide-react";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { AgentBadge } from "@/components/agent-badge";
import Divider from "@/components/divider";
import { LoadingSpinner } from "@/components/loading";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TablePagination } from "@/components/ui/table-pagination";
import { useProfiles } from "@/lib/agent.query";
import { useSession } from "@/lib/auth.query";
import {
  useBulkUpdateChatOpsBindings,
  useChatOpsBindings,
  useChatOpsStatus,
  useCreateChatOpsDmBinding,
  useRefreshChatOpsChannelDiscovery,
  useUpdateChatOpsBinding,
} from "@/lib/chatops.query";
import { useAppName } from "@/lib/use-app-name";
import { cn, DEFAULT_TABLE_LIMIT } from "@/lib/utils";
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
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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
  const hasMultipleWorkspaces = workspaces.length > 1;

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

  // For channel rows: exclude personal agents
  const channelAgentList = useMemo(
    () => agentList.filter((a) => a.scope !== "personal"),
    [agentList],
  );

  // For DM rows: include only the current user's personal agents + non-personal
  const dmAgentList = useMemo(
    () =>
      agentList.filter(
        (a) =>
          a.scope !== "personal" ||
          (a.scope === "personal" && a.authorId === currentUserId),
      ),
    [agentList, currentUserId],
  );

  // Virtual DM row logic
  const providerConfigured = providerStatus
    ? !!(providerStatus as { configured?: boolean }).configured
    : false;
  // Show virtual DM only when: no DM binding exists globally, first page, no search/workspace filter
  const showVirtualDmRow =
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

  const handleAssignAgent = (bindingId: string, agentId: string | null) => {
    updateMutation.mutate({ id: bindingId, agentId });
  };

  const handleDmAssignAgent = (agentId: string | null) => {
    dmMutation.mutate({ provider: providerConfig.provider, agentId });
  };

  const handleBulkAssign = async (agentId: string | null) => {
    if (selectedIds.size === 0) return;
    const hasVirtualDm = selectedIds.has(VIRTUAL_DM_ID);
    const realIds = Array.from(selectedIds).filter(
      (id) => id !== VIRTUAL_DM_ID,
    );

    const promises: Promise<unknown>[] = [];
    if (realIds.length > 0) {
      promises.push(bulkMutation.mutateAsync({ ids: realIds, agentId }));
    }
    if (hasVirtualDm) {
      promises.push(
        dmMutation.mutateAsync({ provider: providerConfig.provider, agentId }),
      );
    }
    await Promise.all(promises);
    clearSelection();
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
    <section className="flex flex-col gap-4">
      <div>
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold relative">
            Channels
            {isFetching && (
              <LoadingSpinner className="h-3 w-3 animate-spin text-muted-foreground absolute right-[-20px] top-[7px]" />
            )}
          </h2>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          New channels appear after adding the bot to a channel and the first
          interaction with it.
          <br />
          Then, assign a default agent to each channel you want {appName} bot to
          reply in. Use the Assign button below or{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-xs">
            {providerConfig.slashCommand}
          </code>{" "}
          in {providerConfig.providerLabel}.{" "}
        </p>
      </div>

      {isLoading && !bindingsResponse ? (
        <ChannelTableSkeleton />
      ) : hasAnyChannels ? (
        <>
          {/* Search + bulk assign */}
          <div className="flex items-center gap-3">
            <SearchInput
              placeholder="Search channels..."
              paramName="search"
              className="relative max-w-md flex-1"
              debounceMs={300}
              onSearchChange={handleSearchChange}
            />
            <div className="ml-auto">
              <BulkAssignButton
                agents={channelAgentList}
                selectedCount={selectedIds.size}
                isUpdating={bulkMutation.isPending}
                onAssign={handleBulkAssign}
              />
            </div>
          </div>

          {/* Status filter pills */}
          <div className="flex gap-1 flex-wrap">
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 text-xs rounded-full gap-1.5",
                statusFromUrl === "all" && "bg-primary/10 text-primary",
              )}
              onClick={() => handleStatusChange("all")}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
              All{counts ? ` (${totalCount})` : ""}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 text-xs rounded-full gap-1.5",
                statusFromUrl === "configured"
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground",
              )}
              onClick={() => handleStatusChange("configured")}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Configured{counts ? ` (${counts.configured})` : ""}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 text-xs rounded-full gap-1.5",
                statusFromUrl === "unassigned"
                  ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground",
              )}
              onClick={() => handleStatusChange("unassigned")}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              Unassigned{counts ? ` (${counts.unassigned})` : ""}
            </Button>

            {/* Workspace filter */}
            {hasMultipleWorkspaces && (
              <>
                <span className="border-l border-border mx-1 self-stretch" />
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-7 text-xs rounded-full",
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
                      "h-7 text-xs rounded-full",
                      workspaceIdFromUrl === ws.id && "bg-muted",
                    )}
                    onClick={() => handleWorkspaceChange(ws.id)}
                  >
                    {ws.name}
                  </Button>
                ))}
              </>
            )}
          </div>

          {/* Table */}
          <div className="overflow-hidden rounded-md border">
            <Table>
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
                  <TableHead>Default Agent</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[80px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              {showFilteredEmptyState ? (
                <TableBody>
                  <TableRow>
                    <TableCell colSpan={5} className="h-48">
                      <div className="flex flex-col items-center justify-center gap-4 text-center">
                        <div className="bg-muted flex h-12 w-12 items-center justify-center rounded-full">
                          <Search className="text-muted-foreground h-5 w-5" />
                        </div>
                        <div className="space-y-1">
                          <p className="font-medium">
                            No channels match your filters.
                          </p>
                          <p className="text-muted-foreground text-sm">
                            Try adjusting your search.
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={clearFilters}
                        >
                          Clear filters
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                </TableBody>
              ) : (
                <TableBody>
                  <ChannelRows
                    bindings={bindings}
                    channelAgentList={channelAgentList}
                    dmAgentList={dmAgentList}
                    providerConfig={providerConfig}
                    providerStatus={providerStatus}
                    onAssignAgent={handleAssignAgent}
                    isUpdating={updateMutation.isPending}
                    selectedIds={selectedIds}
                    onToggleSelected={toggleSelected}
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
        </>
      ) : (
        <ChannelsEmptyState
          onRefresh={() => refreshMutation.mutate(providerConfig.provider)}
          isRefreshing={refreshMutation.isPending}
          provider={providerConfig.provider}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Channel rows (extracted to keep main component clean)
// ---------------------------------------------------------------------------

function ChannelRows({
  bindings,
  channelAgentList,
  dmAgentList,
  providerConfig,
  providerStatus,
  onAssignAgent,
  isUpdating,
  selectedIds,
  onToggleSelected,
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
  }>;
  channelAgentList: Agent[];
  dmAgentList: Agent[];
  providerConfig: ProviderConfig;
  providerStatus: {
    dmInfo?: { botUserId?: string; teamId?: string; appId?: string } | null;
  } | null;
  onAssignAgent: (bindingId: string, agentId: string | null) => void;
  isUpdating: boolean;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  showVirtualDmRow: boolean;
  dmDeepLink: string | null;
  onDmAssignAgent: (agentId: string | null) => void;
  isDmUpdating: boolean;
}) {
  const { data: session } = useSession();
  const user = session?.user;

  return (
    <>
      {showVirtualDmRow && (
        <TableRow>
          <TableCell>
            <Checkbox
              checked={selectedIds.has(VIRTUAL_DM_ID)}
              onCheckedChange={() => onToggleSelected(VIRTUAL_DM_ID)}
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
              agents={dmAgentList}
              assignedAgent={undefined}
              isUpdating={isDmUpdating}
              onAssign={onDmAssignAgent}
            />
          </TableCell>
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
            colSpan={5}
            className="h-16 text-center text-sm text-muted-foreground"
          >
            No matching channels
          </TableCell>
        </TableRow>
      )}
      {bindings.map((binding) => {
        const pickerAgents = binding.isDm ? dmAgentList : channelAgentList;
        const assignedAgent = binding.agentId
          ? pickerAgents.find((a) => a.id === binding.agentId)
          : undefined;
        const deepLink = binding.isDm
          ? providerStatus
            ? providerConfig.getDmDeepLink?.(providerStatus)
            : null
          : providerConfig.buildDeepLink(binding);

        return (
          <TableRow key={binding.id}>
            <TableCell>
              <Checkbox
                checked={selectedIds.has(binding.id)}
                onCheckedChange={() => onToggleSelected(binding.id)}
                aria-label={`Select ${binding.channelName ?? binding.channelId}`}
              />
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-1.5">
                {binding.isDm ? (
                  <span className="text-sm font-medium">
                    Direct Message ({user?.email})
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
                agents={pickerAgents}
                assignedAgent={assignedAgent}
                isUpdating={isUpdating}
                onAssign={(agentId) => onAssignAgent(binding.id, agentId)}
              />
            </TableCell>
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
    <div className="text-muted-foreground/50 flex flex-col items-center">
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
  selectedCount,
  isUpdating,
  onAssign,
}: {
  agents: Agent[];
  selectedCount: number;
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
              <CommandEmpty>No agents found.</CommandEmpty>
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
                {agents.map((agent) => (
                  <CommandItem
                    key={agent.id}
                    value={agent.name}
                    onSelect={() => {
                      onAssign(agent.id);
                      setOpen(false);
                    }}
                  >
                    <Bot className="mr-2 h-4 w-4" />
                    <span className="truncate">{agent.name}</span>
                    <AgentBadge type={agent.scope} />
                  </CommandItem>
                ))}
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
// Agent picker popover
// ---------------------------------------------------------------------------

function AgentPicker({
  agents,
  assignedAgent,
  isUpdating,
  onAssign,
}: {
  agents: Agent[];
  assignedAgent: Agent | undefined;
  isUpdating: boolean;
  onAssign: (agentId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      {assignedAgent ? (
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs min-w-[180px]"
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
            <CommandEmpty>No agents found.</CommandEmpty>
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
              {agents.map((agent) => (
                <CommandItem
                  key={agent.id}
                  value={agent.name}
                  onSelect={() => {
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
                </CommandItem>
              ))}
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

function ChannelTableSkeleton() {
  return (
    <div className="overflow-hidden rounded-md border">
      <Table>
        <TableHeader className="bg-muted border-b-2 border-border">
          <TableRow>
            <TableHead className="w-[40px]" />
            <TableHead>Channel</TableHead>
            <TableHead>Default Agent</TableHead>
            <TableHead>Status</TableHead>
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
