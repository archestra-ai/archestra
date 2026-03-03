"use client";

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
import { useCallback, useMemo, useState } from "react";
import { DebouncedInput } from "@/components/debounced-input";
import Divider from "@/components/divider";
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
import { cn } from "@/lib/utils";
import { ChannelsEmptyState } from "./channels-empty-state";
import type { ProviderConfig } from "./types";

interface Agent {
  id: string;
  name: string;
}

type SortField = "channel" | "agent";
type SortDir = "asc" | "desc";

const VIRTUAL_DM_ID = "__virtual-dm__";
const STORAGE_PREFIX = "triggers:collapse:";

function useCollapsed(key: string, defaultValue: boolean) {
  const storageKey = STORAGE_PREFIX + key;
  const [collapsed, setCollapsedState] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) return stored === "1";
    } catch {
      // SSR or unavailable
    }
    return defaultValue;
  });

  const setCollapsed = useCallback(
    (value: boolean) => {
      setCollapsedState(value);
      try {
        localStorage.setItem(storageKey, value ? "1" : "0");
      } catch {
        // ignore
      }
    },
    [storageKey],
  );

  return [collapsed, setCollapsed] as const;
}

export function ChannelsSection({
  providerConfig,
}: {
  providerConfig: ProviderConfig;
}) {
  const { data: bindings, isLoading } = useChatOpsBindings();
  const { data: agents } = useProfiles({ filters: { agentType: "agent" } });
  const { data: chatOpsProviders } = useChatOpsStatus();
  const updateMutation = useUpdateChatOpsBinding();
  const bulkMutation = useBulkUpdateChatOpsBindings();
  const dmMutation = useCreateChatOpsDmBinding();
  const refreshMutation = useRefreshChatOpsChannelDiscovery();

  const [selectedWorkspace, setSelectedWorkspaceRaw] = useState<string | null>(
    null,
  );
  const [searchQuery, setSearchQueryRaw] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
  const setSelectedWorkspace = useCallback(
    (ws: string | null) => {
      setSelectedWorkspaceRaw(ws);
      clearSelection();
    },
    [clearSelection],
  );
  const setSearchQuery = useCallback(
    (q: string) => {
      setSearchQueryRaw(q);
      clearSelection();
    },
    [clearSelection],
  );

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

  const providerBindings = useMemo(
    () => bindings?.filter((b) => b.provider === providerConfig.provider) ?? [],
    [bindings, providerConfig.provider],
  );

  // Collect unique workspaces
  const workspaces = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of providerBindings) {
      if (b.workspaceId && b.workspaceName) {
        map.set(b.workspaceId, b.workspaceName);
      }
    }
    return Array.from(map, ([id, name]) => ({ id, name }));
  }, [providerBindings]);

  const hasMultipleWorkspaces = workspaces.length > 1;

  // Agent list for picker + lookup map for sorting
  const agentList = useMemo(
    () => (agents ?? []).map((a) => ({ id: a.id, name: a.name })),
    [agents],
  );
  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agentList) m.set(a.id, a.name);
    return m;
  }, [agentList]);

  // Filter by workspace
  const workspaceBindings = useMemo(() => {
    if (hasMultipleWorkspaces && selectedWorkspace) {
      return providerBindings.filter(
        (b) => b.isDm || b.workspaceId === selectedWorkspace,
      );
    }
    return providerBindings;
  }, [providerBindings, hasMultipleWorkspaces, selectedWorkspace]);

  // Counters from unfiltered (workspace-filtered + sorted) data — not affected by search
  const configuredCount = useMemo(
    () => workspaceBindings.filter((b) => b.agentId).length,
    [workspaceBindings],
  );
  const notConfiguredCount = useMemo(
    () => workspaceBindings.filter((b) => !b.agentId).length,
    [workspaceBindings],
  );

  // Apply search filter (does NOT affect counters)
  const lowerSearch = searchQuery.toLowerCase();
  const filteredBindings = useMemo(() => {
    if (!lowerSearch) return workspaceBindings;
    return workspaceBindings.filter((b) => {
      const name = b.isDm
        ? "direct message"
        : (b.channelName ?? b.channelId).toLowerCase();
      return name.includes(lowerSearch);
    });
  }, [workspaceBindings, lowerSearch]);

  // Split filtered results into configured / not configured
  const configured = useMemo(
    () => filteredBindings.filter((b) => b.agentId),
    [filteredBindings],
  );
  const notConfigured = useMemo(
    () => filteredBindings.filter((b) => !b.agentId),
    [filteredBindings],
  );

  // Show a virtual DM row when the provider is configured but no DM binding exists yet
  const hasDmBinding = providerBindings.some((b) => b.isDm);
  const providerConfigured = providerStatus
    ? !!(providerStatus as { configured?: boolean }).configured
    : false;
  const showVirtualDmRow =
    !hasDmBinding &&
    providerConfigured &&
    (!lowerSearch || "direct message".includes(lowerSearch));
  const dmDeepLink = providerStatus
    ? (providerConfig.getDmDeepLink?.(providerStatus) ?? null)
    : null;

  // Count virtual DM row in not-configured if shown
  const virtualDmCount = showVirtualDmRow ? 1 : 0;

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

  const hasAnyChannels = workspaceBindings.length > 0 || showVirtualDmRow;

  return (
    <section className="flex flex-col gap-4">
      <div>
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Channels</h2>
          {!isLoading && hasAnyChannels && (
            <div className="flex items-end gap-3 text-xs text-muted-foreground ml-1">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
                Total: {configuredCount + notConfiguredCount + virtualDmCount}
              </span>
              |
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 opacity-90">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Configured: {configuredCount}
              </span>
              |
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400 opacity-90">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                Unassigned: {notConfiguredCount + virtualDmCount}
              </span>
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          New channels appear after adding the bot to a channel and the first
          interaction with it.
          <br />
          Then, assign a default agent to each channel you want Archestra bot to
          reply in. Use the Assign button below or{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-xs">
            {providerConfig.slashCommand}
          </code>{" "}
          in {providerConfig.providerLabel}.{" "}
        </p>
      </div>

      {isLoading ? (
        <ChannelTableLoading />
      ) : hasAnyChannels ? (
        <>
          <div className="flex items-center gap-3">
            <div className="relative max-w-md flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <DebouncedInput
                placeholder="Search channels..."
                initialValue={searchQuery}
                onChange={setSearchQuery}
                debounceMs={200}
                className="pl-9"
              />
            </div>
            <div className="ml-auto">
              <BulkAssignButton
                agents={agentList}
                selectedCount={selectedIds.size}
                isUpdating={bulkMutation.isPending}
                onAssign={handleBulkAssign}
              />
            </div>
          </div>

          {hasMultipleWorkspaces && (
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 text-xs rounded-full",
                  !selectedWorkspace && "bg-muted",
                )}
                onClick={() => setSelectedWorkspace(null)}
              >
                All
              </Button>
              {workspaces.map((ws) => (
                <Button
                  key={ws.id}
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-7 text-xs rounded-full",
                    selectedWorkspace === ws.id && "bg-muted",
                  )}
                  onClick={() => setSelectedWorkspace(ws.id)}
                >
                  {ws.name}
                </Button>
              ))}
            </div>
          )}

          {(configured.length > 0 || (configuredCount > 0 && lowerSearch)) && (
            <CollapsibleChannelTable
              variant="configured"
              storageKey={`${providerConfig.provider}:configured`}
              bindings={configured}
              agentList={agentList}
              providerConfig={providerConfig}
              providerStatus={providerStatus}
              onAssignAgent={handleAssignAgent}
              isUpdating={updateMutation.isPending}
              agentMap={agentMap}
              selectedIds={selectedIds}
              onToggleSelected={toggleSelected}
              onToggleAll={toggleAll}
            />
          )}

          {(notConfigured.length > 0 ||
            showVirtualDmRow ||
            (notConfiguredCount > 0 && lowerSearch)) && (
            <CollapsibleChannelTable
              variant="not-configured"
              storageKey={`${providerConfig.provider}:not-configured`}
              bindings={notConfigured}
              agentList={agentList}
              providerConfig={providerConfig}
              providerStatus={providerStatus}
              onAssignAgent={handleAssignAgent}
              isUpdating={updateMutation.isPending}
              virtualDm={
                showVirtualDmRow
                  ? {
                      deepLink: dmDeepLink,
                      onAssignAgent: handleDmAssignAgent,
                      isUpdating: dmMutation.isPending,
                    }
                  : undefined
              }
              agentMap={agentMap}
              selectedIds={selectedIds}
              onToggleSelected={toggleSelected}
              onToggleAll={toggleAll}
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
// Collapsible table section
// ---------------------------------------------------------------------------

interface BindingRow {
  id: string;
  channelId: string;
  channelName?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  isDm?: boolean;
  agentId?: string | null;
}

function CollapsibleChannelTable({
  variant,
  storageKey,
  bindings,
  agentList,
  providerConfig,
  providerStatus,
  onAssignAgent,
  isUpdating,
  virtualDm,
  agentMap,
  selectedIds,
  onToggleSelected,
  onToggleAll,
}: {
  variant: "configured" | "not-configured";
  storageKey: string;
  bindings: BindingRow[];
  agentList: Agent[];
  providerConfig: ProviderConfig;
  providerStatus: {
    dmInfo?: { botUserId?: string; teamId?: string; appId?: string } | null;
  } | null;
  onAssignAgent: (bindingId: string, agentId: string | null) => void;
  isUpdating: boolean;
  virtualDm?: {
    deepLink: string | null;
    onAssignAgent: (agentId: string | null) => void;
    isUpdating: boolean;
  };
  agentMap: Map<string, string>;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  onToggleAll: (ids: string[], checked: boolean) => void;
}) {
  const { data: session } = useSession();
  const user = session?.user;
  const [collapsed, setCollapsed] = useCollapsed(storageKey, false);
  const isConfigured = variant === "configured";

  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const handleToggleSort = useCallback(
    (field: SortField) => {
      if (sortField === field) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortField(field);
        setSortDir("asc");
      }
    },
    [sortField],
  );

  const sortedBindings = useMemo(() => {
    const items = [...bindings];
    return items.sort((a, b) => {
      if (a.isDm && !b.isDm) return -1;
      if (!a.isDm && b.isDm) return 1;
      if (sortField) {
        let cmp = 0;
        if (sortField === "channel") {
          cmp = (a.channelName ?? a.channelId).localeCompare(
            b.channelName ?? b.channelId,
          );
        } else {
          const agentA = a.agentId ? (agentMap.get(a.agentId) ?? "") : "";
          const agentB = b.agentId ? (agentMap.get(b.agentId) ?? "") : "";
          cmp = agentA.localeCompare(agentB);
        }
        return sortDir === "desc" ? -cmp : cmp;
      }
      return (a.channelName ?? a.channelId).localeCompare(
        b.channelName ?? b.channelId,
      );
    });
  }, [bindings, sortField, sortDir, agentMap]);

  const selectableIds = useMemo(() => {
    const ids = sortedBindings.map((b) => b.id);
    if (virtualDm) ids.push(VIRTUAL_DM_ID);
    return ids;
  }, [sortedBindings, virtualDm]);
  const allChecked =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selectedIds.has(id));
  const someChecked =
    !allChecked && selectableIds.some((id) => selectedIds.has(id));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 !px-0 !bg-transparent"
          onClick={() => setCollapsed(!collapsed)}
        >
          <span
            className={cn(
              "text-sm font-semibold",
              isConfigured
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-amber-600 dark:text-amber-400",
            )}
          >
            {isConfigured ? "Configured" : "Unassigned"}
          </span>
          {/* <span
            className={cn(
              "text-xs px-1.5 py-0.5 rounded-full font-medium w-5 h-5 flex items-center justify-center border border-border",
              isConfigured
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
            )}
          >
            {count}
          </span> */}
          {collapsed ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </Button>
      </div>

      {!collapsed && (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader className="bg-muted border-b-2 border-border">
              <TableRow>
                <TableHead className="w-[40px]">
                  <Checkbox
                    checked={
                      allChecked ? true : someChecked ? "indeterminate" : false
                    }
                    onCheckedChange={(checked) =>
                      onToggleAll(selectableIds, !!checked)
                    }
                    aria-label="Select all"
                  />
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    className="h-auto !p-0 font-medium hover:bg-transparent"
                    onClick={() => handleToggleSort("channel")}
                  >
                    Channel
                    <SortIcon
                      isSorted={sortField === "channel" ? sortDir : false}
                    />
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    className="h-auto !p-0 font-medium hover:bg-transparent"
                    onClick={() => handleToggleSort("agent")}
                  >
                    Default Agent
                    <SortIcon
                      isSorted={sortField === "agent" ? sortDir : false}
                    />
                  </Button>
                </TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[80px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {virtualDm && (
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
                      agents={agentList}
                      assignedAgent={undefined}
                      isUpdating={virtualDm.isUpdating}
                      onAssign={virtualDm.onAssignAgent}
                    />
                  </TableCell>
                  <TableCell>
                    <StatusBadge assigned={false} />
                  </TableCell>
                  <TableCell className="pr-2">
                    {virtualDm.deepLink && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 text-xs"
                        asChild
                      >
                        <a
                          href={virtualDm.deepLink}
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
              {sortedBindings.length === 0 && !virtualDm && (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="h-16 text-center text-sm text-muted-foreground"
                  >
                    No matching channels
                  </TableCell>
                </TableRow>
              )}
              {sortedBindings.map((binding) => {
                const assignedAgent = binding.agentId
                  ? agentList.find((a) => a.id === binding.agentId)
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
                        agents={agentList}
                        assignedAgent={assignedAgent}
                        isUpdating={isUpdating}
                        onAssign={(agentId) =>
                          onAssignAgent(binding.id, agentId)
                        }
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
            </TableBody>
          </Table>
        </div>
      )}
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
            className="h-7 gap-1.5 text-xs"
            disabled={isUpdating}
          >
            <Bot className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{assignedAgent.name}</span>
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
                  {assignedAgent?.id === agent.id && (
                    <CheckIcon className="ml-auto h-4 w-4" />
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

function ChannelTableLoading() {
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
