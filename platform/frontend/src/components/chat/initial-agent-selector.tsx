"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
} from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  ExternalLink,
  Infinity as InfinityIcon,
  Plus,
  RotateCw,
  Search,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { AgentIcon } from "@/components/agent-icon";
import {
  agentListHref,
  agentNewHref,
} from "@/components/agent-pages/agent-page-config";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { McpInstallDialogs } from "@/components/chat/mcp-install-dialogs";
import { RuntimeCapableIndicator } from "@/components/chat/runtime-capable-indicator";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import { OverlappedIcons } from "@/components/ui/overlapped-icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  useAgentCredentialReadinessPages,
  useChatAgentPages,
  useChatAgentReferences,
  useChatAgents,
  useCreateProfile,
  usePinnedAgentIds,
  useProfile,
  useUpdateProfile,
} from "@/lib/agent.query";
import {
  useAgentDelegations,
  useAllProfileTools,
} from "@/lib/agent-tools.query";
import {
  useHasPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
import {
  indexReadinessByAgent,
  listServerNames,
  resolveAgentConnectionGate,
} from "@/lib/chat/agent-connection-gate";
import { useFeature } from "@/lib/config/config.query";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useListboxNavigation } from "@/lib/hooks/use-listbox-navigation";
import {
  useConnectors,
  useConnectorsByIds,
} from "@/lib/knowledge/connector.query";
import {
  useKnowledgeBases,
  useKnowledgeBasesByIds,
} from "@/lib/knowledge/knowledge-base.query";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import { useMcpInstallOrchestrator } from "@/lib/mcp/mcp-install-orchestrator.hook";
import {
  fetchInternalMcpCatalogItem,
  type McpCatalogDirectoryItem,
  useMcpCatalogDirectory,
} from "@/lib/mcp/mcp-registry.query";
import { useShellReady } from "@/lib/shell-deferral";
import { mergeById } from "@/lib/utils/merge-by-id";
import { cn } from "@/lib/utils/tailwind";
import {
  AddToolsView,
  AgentSettingsSkeleton,
  AgentSettingsView,
  ChooseToolsView,
  ConnectView,
  InstallingView,
  KnowledgeView,
  type QuickEditNotice,
  SubagentsView,
} from "./agent-quick-edit/lazy-views";
import {
  filterAndSortInitialAgents,
  groupInitialAgents,
} from "./initial-agent-selector.utils";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

type DialogView =
  | "settings"
  | "add-tools"
  | "choose-tools"
  | "connect"
  | "installing"
  | "subagents"
  | "knowledge";

interface InitialAgentSelectorProps {
  currentAgentId: string | null;
  onAgentChange: (agentId: string) => void;
}

export const InitialAgentSelector = memo(function InitialAgentSelector({
  currentAgentId,
  onAgentChange,
}: InitialAgentSelectorProps) {
  const [open, setOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const listRef = useRef<HTMLDivElement>(null);
  const page = useChatAgentPages({
    search: debouncedSearch,
    enabled: open,
  });
  const loadMore = () => {
    if (search === debouncedSearch && page.hasNextPage && !page.isFetching) {
      void page.fetchNextPage({ cancelRefetch: false });
    }
  };
  const { data: bootstrapAgents = [], isPending: isRosterPending } =
    useChatAgents({
      ids: [currentAgentId],
    });
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [cloningAgentId, setCloningAgentId] = useState<string | null>(null);
  const afterFirstPaint = useAfterFirstPaint();
  const installOrchestrator = useMcpInstallOrchestrator({ enabled: open });
  // Connecting is per server, so several missing ones are walked one at a time:
  // each install refreshes readiness, and the row re-offers whatever is left.
  const connectMissing = useCallback(
    (catalogIds: string[]) => {
      const next = catalogIds[0];
      if (next) installOrchestrator.triggerInstallByCatalogId(next);
    },
    [installOrchestrator],
  );
  const { data: session } = useSession();
  const runtimeEnabled = useFeature("agentRuntime") === true;
  const userId = session?.user?.id;
  const { data: scopedGrants } = useScopedCapabilities();
  const createProfile = useCreateProfile();
  const cloningStartedForRef = useRef<string | null>(null);

  // Loaded once the page's first requests settle, not on open, so the Pinned
  // group is there the moment the picker opens instead of popping in once the
  // request lands, without queueing in front of what the composer needs.
  const shellReady = useShellReady();
  const { data: pinnedIds } = usePinnedAgentIds({
    enabled: open || shellReady,
  });
  const { data: pinnedAgents = [] } = useChatAgentReferences(
    pinnedIds ?? [],
    open || shellReady,
  );
  const allAgents = useMemo(
    () => [
      ...new Map(
        [
          ...bootstrapAgents,
          ...pinnedAgents,
          ...(search === debouncedSearch
            ? (page.data?.pages.flatMap((result) => result?.data ?? []) ?? [])
            : []),
        ].map((agent) => [agent.id, agent]),
      ).values(),
    ],
    [bootstrapAgents, pinnedAgents, page.data, search, debouncedSearch],
  );
  const filteredAgents = useMemo(
    () =>
      filterAndSortInitialAgents({
        allAgents,
        currentAgentId,
        search,
        userId,
      }),
    [allAgents, search, currentAgentId, userId],
  );
  const { data: credentialReadiness } = useAgentCredentialReadinessPages({
    enabled: open || summaryOpen,
    batches: open
      ? [
          [...bootstrapAgents, ...pinnedAgents].map((agent) => agent.id),
          ...(page.data?.pages.map(
            (result) => result?.data.map((agent) => agent.id) ?? [],
          ) ?? []),
        ]
      : [[currentAgentId].filter((id): id is string => !!id)],
  });
  const readinessByAgent = useMemo(
    () => indexReadinessByAgent(credentialReadiness),
    [credentialReadiness],
  );
  const groupIdPrefix = useId();
  const toolSummaryId = useId();
  const agentGroups = useMemo(
    () => groupInitialAgents({ agents: filteredAgents, userId, pinnedIds }),
    [filteredAgents, userId, pinnedIds],
  );
  // Arrow keys walk the rows in the order they are drawn, group by group.
  const keyboardNavigableAgentIds = useMemo(
    () =>
      agentGroups
        .flatMap((group) => group.agents)
        .filter(
          (agent) =>
            resolveAgentConnectionGate(readinessByAgent.get(agent.id)).kind !==
            "block",
        )
        .map((agent) => agent.id),
    [agentGroups, readinessByAgent],
  );

  const currentAgentSummary = useMemo(
    () =>
      allAgents.find((a) => a.id === currentAgentId) ??
      (currentAgentId
        ? null
        : (allAgents.find((a) => !a.builtIn && a.scope === "personal") ??
          allAgents.find((a) => !a.builtIn) ??
          null)),
    [allAgents, currentAgentId],
  );
  // The roster omits large embedded icons and editing-only fields. Hydrate one
  // record after the composer's first paint, so the response never competes
  // with the first useful render; the trigger holds placeholders until then.
  const { data: currentAgentDetail } = useProfile(
    currentAgentSummary?.id ?? undefined,
    { enabled: open || afterFirstPaint },
  );
  const currentAgent = currentAgentDetail;
  const displayAgent = currentAgentDetail ?? currentAgentSummary;
  const displayAgentName = displayAgent?.name ?? "Select agent";
  // The composer renders before the chat knows its agent; until the roster
  // answers, the chip holds a placeholder rather than asking for a choice.
  const isAgentResolving = !displayAgent && isRosterPending;
  const effectiveAgentId = displayAgent?.id ?? currentAgentId;
  // The trigger's server and knowledge icons: wanted on screen, not for
  // typing, so they wait for the page's first requests too.
  const shouldLoadAgentManagementDetails =
    open || !!editingAgentId || shellReady;
  const installer = useMcpInstallOrchestrator({
    enabled: open || !!editingAgentId,
  });

  const canEditAgent = useCallback(
    (agentId: string) =>
      scopedGrants?.some(
        (grant) =>
          grant.resource === "agent" &&
          grant.action === "update" &&
          (grant.scope === "*" || grant.scope === agentId),
      ) === true,
    [scopedGrants],
  );
  const canEditCurrentAgent = !!currentAgent && canEditAgent(currentAgent.id);

  const { data: canReadMcpRegistry } = useHasPermissions({
    mcpRegistry: ["read"],
  });
  const { data: canReadKnowledgeBase } = useHasPermissions({
    knowledgeSource: ["read"],
  });
  // Names and icons only: the registry's directory, not the full catalog.
  const { data: catalogItems = [], isSuccess: catalogLoaded } =
    useMcpCatalogDirectory({
      enabled: shouldLoadAgentManagementDetails && !!canReadMcpRegistry,
    });
  const { catalogName: builtInCatalogName } = useArchestraMcpIdentity();
  // The agent detail already lists its tools' catalogs, so the server icons
  // need no separate tool-assignment request (which carries every tool's full
  // schema and can run to megabytes).
  const assignedServers = useMemo(() => {
    const toolCounts = new Map<string, number>();
    for (const tool of currentAgentDetail?.tools ?? []) {
      if (tool.catalogId) {
        toolCounts.set(
          tool.catalogId,
          (toolCounts.get(tool.catalogId) ?? 0) + 1,
        );
      }
    }
    return catalogItems
      .filter((catalog) => toolCounts.has(catalog.id))
      .map((catalog) => ({
        catalog,
        name:
          catalog.id === ARCHESTRA_MCP_CATALOG_ID
            ? builtInCatalogName
            : catalog.name,
        toolCount: toolCounts.get(catalog.id) ?? 0,
      }));
  }, [currentAgentDetail, catalogItems, builtInCatalogName]);

  // Loaded with the composer, not deferred to the picker opening: the trigger
  // shows these icons from the start, and a short id list is cheap.
  const { data: triggerDelegations = [], isSuccess: delegationsLoaded } =
    useAgentDelegations(effectiveAgentId ?? undefined);
  const { data: triggerSubagents = [] } = useChatAgentReferences(
    triggerDelegations.map((agent) => agent.id),
  );

  // The trigger reads exactly this agent's knowledge sources by id.
  const currentKnowledgeBaseIds = currentAgent?.knowledgeBaseIds ?? [];
  const currentConnectorIds = currentAgent?.connectorIds ?? [];
  const knowledgeLookupEnabled =
    shouldLoadAgentManagementDetails && !!canReadKnowledgeBase;
  const {
    data: currentKnowledgeBases,
    isSuccess: currentKnowledgeBasesLoaded,
  } = useKnowledgeBasesByIds(currentKnowledgeBaseIds, {
    enabled: knowledgeLookupEnabled,
  });
  const { data: currentConnectors, isSuccess: currentConnectorsLoaded } =
    useConnectorsByIds(currentConnectorIds, {
      enabled: knowledgeLookupEnabled,
    });
  const knowledgeBasesLoaded =
    currentKnowledgeBaseIds.length === 0 || currentKnowledgeBasesLoaded;
  const connectorsLoaded =
    currentConnectorIds.length === 0 || currentConnectorsLoaded;
  const knowledgeSources = useMemo(
    () => [
      ...(currentKnowledgeBases ?? []).map((kb) => ({
        id: kb.id,
        name: kb.name,
        kind: "knowledge base",
        connectorType: kb.connectors?.[0]?.connectorType,
      })),
      ...(currentConnectors ?? []).map((connector) => ({
        id: connector.id,
        name: connector.name,
        kind: "connector",
        connectorType: connector.connectorType,
      })),
    ],
    [currentKnowledgeBases, currentConnectors],
  );

  // The icons are "known" once this agent's own data has arrived; until then
  // the slot shows placeholders, never the previous agent's icons.
  const triggerIconsLoaded =
    !!currentAgentDetail &&
    currentAgentDetail.id === effectiveAgentId &&
    delegationsLoaded &&
    (catalogLoaded || canReadMcpRegistry === false) &&
    ((knowledgeBasesLoaded && connectorsLoaded) ||
      canReadKnowledgeBase === false);
  const missingCatalogIds = useMemo(() => {
    const gate = resolveAgentConnectionGate(
      readinessByAgent.get(effectiveAgentId ?? ""),
    );
    return new Set(gate.kind === "ok" ? [] : gate.catalogIds);
  }, [readinessByAgent, effectiveAgentId]);

  const handleAgentSelect = (agentId: string) => {
    onAgentChange(agentId);
    setOpen(false);
    setSearch("");
  };

  const navigation = useListboxNavigation({
    open,
    onOpenChange: setOpen,
    values: keyboardNavigableAgentIds,
    selectedValue: keyboardNavigableAgentIds.includes(currentAgentId ?? "")
      ? currentAgentId
      : keyboardNavigableAgentIds[0],
    onSelect: handleAgentSelect,
  });

  // ---- Quick-edit dialog state ---------------------------------------------
  const queryClient = useQueryClient();
  const [dialogView, setDialogView] = useState<DialogView>("settings");
  const [chooseToolsFrom, setChooseToolsFrom] = useState<
    "settings" | "add-tools"
  >("settings");
  const [selectedCatalog, setSelectedCatalog] = useState<CatalogItem | null>(
    null,
  );
  const [addWhenConnected, setAddWhenConnected] = useState(true);
  const [highlightCatalogId, setHighlightCatalogId] = useState<string | null>(
    null,
  );
  const [notice, setNotice] = useState<QuickEditNotice | null>(null);
  const [instructionsDraft, setInstructionsDraft] = useState<string | null>(
    null,
  );
  const [instructionsJustSaved, setInstructionsJustSaved] = useState(false);
  const [closeGuardOpen, setCloseGuardOpen] = useState(false);
  const updateProfile = useUpdateProfile();

  const { data: editingAgent } = useProfile(editingAgentId ?? undefined);
  // Quick-edit pickers: load once the menu or dialog opens, merged with the
  // edited agent's own sources so ones past the first page still show.
  const knowledgePickerEnabled =
    (open || !!editingAgentId) && !!canReadKnowledgeBase;
  const { data: knowledgeBasesPage, isPending: knowledgeBasesPagePending } =
    useKnowledgeBases({ enabled: knowledgePickerEnabled });
  const { data: connectorsPage, isPending: connectorsPagePending } =
    useConnectors({ enabled: knowledgePickerEnabled });
  const { data: editingKnowledgeBases } = useKnowledgeBasesByIds(
    editingAgent?.knowledgeBaseIds ?? [],
    { enabled: knowledgePickerEnabled },
  );
  const { data: editingConnectors } = useConnectorsByIds(
    editingAgent?.connectorIds ?? [],
    { enabled: knowledgePickerEnabled },
  );
  const allKnowledgeBases = useMemo(
    () => mergeById(knowledgeBasesPage, editingKnowledgeBases),
    [knowledgeBasesPage, editingKnowledgeBases],
  );
  const allConnectors = useMemo(
    () => mergeById(connectorsPage, editingConnectors),
    [connectorsPage, editingConnectors],
  );
  const knowledgePickerLoading =
    knowledgePickerEnabled &&
    (knowledgeBasesPagePending || connectorsPagePending);
  // The settings view also needs the agent's tools and subagents. Fetch them
  // with the agent, not after it renders, and start all three when the pointer
  // or focus reaches a row's edit button, ahead of the click.
  const [warmAgentId, setWarmAgentId] = useState<string | null>(null);
  const quickEditAgentId = editingAgentId ?? warmAgentId ?? undefined;
  useProfile(quickEditAgentId);
  useAllProfileTools({
    filters: { agentId: quickEditAgentId },
    skipPagination: true,
    includeToolDetails: false,
    enabled: !!quickEditAgentId,
  });
  useAgentDelegations(quickEditAgentId);
  const { data: cloningAgent } = useProfile(cloningAgentId ?? undefined);
  const editingSummary = allAgents.find((a) => a.id === editingAgentId);

  const savedInstructions = editingAgent?.systemPrompt ?? null;
  const instructionsDirty =
    instructionsDraft !== null &&
    (instructionsDraft.trim() || null) !== savedInstructions;

  const openQuickEdit = useCallback(
    (agentId: string, view: DialogView = "settings") => {
      setOpen(false);
      setEditingAgentId(agentId);
      setDialogView(view);
      setSelectedCatalog(null);
      setHighlightCatalogId(null);
      setNotice(null);
      setInstructionsDraft(null);
      setInstructionsJustSaved(false);
      setAddWhenConnected(true);
    },
    [],
  );

  const closeQuickEdit = () => {
    setCloseGuardOpen(false);
    setEditingAgentId(null);
    setDialogView("settings");
    setSelectedCatalog(null);
    setInstructionsDraft(null);
  };

  const saveInstructions = (options?: { thenClose?: boolean }) => {
    if (!editingAgent || instructionsDraft === null) return;
    updateProfile.mutate(
      {
        id: editingAgent.id,
        data: { systemPrompt: instructionsDraft.trim() || null },
      },
      {
        onSuccess: () => {
          setInstructionsDraft(null);
          setInstructionsJustSaved(true);
          if (options?.thenClose) closeQuickEdit();
        },
      },
    );
  };

  // The highlight marks only the change just made: any other return to the
  // settings clears it.
  const showSettings = (options?: { highlight?: string }) => {
    setDialogView("settings");
    setSelectedCatalog(null);
    setHighlightCatalogId(options?.highlight ?? null);
    if (options?.highlight) setNotice(null);
  };

  // Lists hand over a directory row; the views behind it need the item's
  // configuration, so it is loaded by id first.
  const chooseTools = async (
    catalog: { id: string },
    from: "settings" | "add-tools",
  ) => {
    const item = await fetchInternalMcpCatalogItem(queryClient, catalog.id);
    if (!item) return;
    setSelectedCatalog(item);
    setChooseToolsFrom(from);
    setDialogView("choose-tools");
  };

  const reportFailure = (failure: QuickEditNotice) => {
    setNotice(failure);
    setDialogView("settings");
  };

  useEffect(() => {
    if (!cloningAgent || cloningStartedForRef.current === cloningAgent.id) {
      return;
    }

    cloningStartedForRef.current = cloningAgent.id;
    setCloningAgentId(null);
    createProfile.mutate(
      {
        name: `Copy ${cloningAgent.name}`,
        agentType: "agent",
        description: cloningAgent.description,
        systemPrompt: cloningAgent.systemPrompt,
        icon: cloningAgent.icon,
      },
      {
        onSuccess: (newAgent) => {
          if (newAgent?.id) {
            onAgentChange(newAgent.id);
            openQuickEdit(newAgent.id);
          }
        },
      },
    );
  }, [cloningAgent, createProfile, onAgentChange, openQuickEdit]);

  return (
    <>
      {/* One hover surface for the agent button and the Add tools circle
          after it, so the circle never cuts through the button's edge. */}
      <div className="flex min-w-0 max-w-[340px] items-center rounded-md transition-colors hover:bg-accent dark:hover:bg-accent/50">
        <Popover
          open={open}
          onOpenChange={(newOpen) => {
            setOpen(newOpen);
            if (!newOpen) {
              setSearch("");
            }
          }}
        >
          <PopoverTrigger asChild>
            <PromptInputButton
              role="combobox"
              aria-expanded={open}
              aria-label={isAgentResolving ? "Loading agent" : displayAgentName}
              aria-busy={isAgentResolving || undefined}
              aria-describedby={toolSummaryId}
              data-agent-selector
              onKeyDown={navigation.onTriggerKeyDown}
              className="min-w-0 hover:bg-transparent dark:hover:bg-transparent"
            >
              <AgentIcon icon={displayAgent?.icon} size={16} />
              {isAgentResolving ? (
                <span
                  className="h-3 w-20 flex-1 animate-pulse rounded bg-muted motion-reduce:animate-none"
                  aria-hidden="true"
                  data-testid="agent-name-placeholder"
                />
              ) : (
                <span className="truncate flex-1 text-left">
                  {displayAgentName}
                </span>
              )}
              {/* In Auto mode the agent reaches everything dynamically, so
                  per-server icons would mean nothing. Either way the chip or
                  the icons are part of the agent's own button rather than a
                  second control. */}
              {currentAgent?.accessAllTools ? (
                <AllToolsIcons
                  descriptionId={toolSummaryId}
                  agentName={displayAgentName}
                />
              ) : !triggerIconsLoaded ? (
                // Same footprint as the "All tools" circles, which most
                // agents land on, so the controls beside it do not shift.
                <span
                  className="flex shrink-0 items-center -space-x-1.5"
                  aria-hidden="true"
                  data-testid="agent-tools-placeholder"
                >
                  {ALL_TOOLS_ICONS.map(({ key }) => (
                    <span
                      key={key}
                      className="size-5 shrink-0 animate-pulse rounded-full bg-muted ring-1 ring-background"
                    />
                  ))}
                </span>
              ) : (
                <AgentToolIcons
                  descriptionId={toolSummaryId}
                  agentName={displayAgentName}
                  subagents={triggerSubagents}
                  servers={assignedServers}
                  knowledgeSources={knowledgeSources}
                  missingCatalogIds={missingCatalogIds}
                  canEdit={canEditCurrentAgent}
                  onOpenChange={setSummaryOpen}
                />
              )}
              {/* No runtime mark here: the composer's runtime row below
                  already says this agent starts a dedicated runtime. */}
            </PromptInputButton>
          </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            className="w-[calc(100vw-1.5rem)] rounded-xl p-0 sm:w-[360px]"
          >
            <div className="px-2.5 pt-2.5 pb-1">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="Search agents"
                  aria-label="Search agents"
                  {...navigation.inputProps}
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    if (listRef.current) listRef.current.scrollTop = 0;
                  }}
                  className={cn(
                    "h-8 rounded-lg border-transparent bg-muted/50 pl-8 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0",
                    page.isError && "pr-9",
                  )}
                  autoFocus
                />
                {page.isError && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Retry loading agents"
                        className="absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                        disabled={page.isFetching || search !== debouncedSearch}
                        onClick={() => {
                          if (!page.isFetchNextPageError) {
                            void page.refetch();
                          } else {
                            loadMore();
                          }
                        }}
                      >
                        <RotateCw
                          aria-hidden
                          className={cn(
                            "size-3.5",
                            page.isFetching &&
                              "animate-spin motion-reduce:animate-none",
                          )}
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <span>
                        {page.isFetching
                          ? "Loading agents…"
                          : "Retry loading agents"}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
            <div
              {...navigation.listboxProps}
              ref={listRef}
              onScroll={(event) => {
                const { scrollTop, scrollHeight, clientHeight } =
                  event.currentTarget;
                if (
                  scrollHeight - scrollTop - clientHeight < 48 &&
                  !page.isError
                ) {
                  loadMore();
                }
              }}
              aria-busy={page.isFetching}
              role="listbox"
              aria-label="Agents"
              className="max-h-[320px] overflow-y-auto px-1.5 pb-1.5"
            >
              {filteredAgents.length === 0 ? (
                <div className="flex flex-col items-center gap-2.5 px-4 py-6 text-center">
                  <p className="text-sm text-muted-foreground">
                    {page.isPending || search !== debouncedSearch
                      ? "Loading agents…"
                      : page.isError
                        ? "Could not load agents"
                        : `No agents match "${search}"`}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => {
                        setSearch("");
                        if (listRef.current) listRef.current.scrollTop = 0;
                      }}
                    >
                      Clear search
                    </Button>
                    <Button asChild variant="outline" size="xs">
                      <Link href={agentNewHref("agent")}>New agent</Link>
                    </Button>
                  </div>
                </div>
              ) : (
                agentGroups.map((group, groupIndex) => (
                  // biome-ignore lint/a11y/useSemanticElements: a listbox groups its options with role="group"; a fieldset is for form controls
                  <div
                    key={group.label}
                    role="group"
                    aria-labelledby={`${groupIdPrefix}-${groupIndex}`}
                  >
                    <div
                      id={`${groupIdPrefix}-${groupIndex}`}
                      className="px-2.5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      {group.label}
                    </div>
                    {group.agents.map((agent) => (
                      <AgentPickerRow
                        key={agent.id}
                        agent={agent}
                        isSelected={currentAgentId === agent.id}
                        isHighlighted={navigation.activeValue === agent.id}
                        canEdit={canEditAgent(agent.id)}
                        runtimeEnabled={runtimeEnabled}
                        gate={resolveAgentConnectionGate(
                          readinessByAgent.get(agent.id),
                        )}
                        optionProps={navigation.getOptionProps(agent.id)}
                        onSelect={() => handleAgentSelect(agent.id)}
                        onEdit={() => openQuickEdit(agent.id)}
                        onWarm={() => setWarmAgentId(agent.id)}
                        onDuplicate={() => {
                          setOpen(false);
                          cloningStartedForRef.current = null;
                          setCloningAgentId(agent.id);
                        }}
                        onConnect={(catalogIds) => {
                          setOpen(false);
                          connectMissing(catalogIds);
                        }}
                      />
                    ))}
                  </div>
                ))
              )}
            </div>
            <div className="flex items-center justify-between border-t px-1.5 py-1.5">
              <Button asChild variant="ghost" size="sm">
                <Link href={agentNewHref("agent")}>
                  <Plus />
                  New agent
                </Link>
              </Button>
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
              >
                <Link href={agentListHref("agent")}>
                  All agents
                  <ExternalLink />
                </Link>
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* Outside the popover on purpose: connecting closes the list, and a
          dialog mounted inside it would be torn down with it. */}
      <McpInstallDialogs orchestrator={installOrchestrator} />

      <Dialog
        open={!!editingAgentId}
        onOpenChange={(isOpen) => {
          if (isOpen) return;
          if (instructionsDirty) setCloseGuardOpen(true);
          else closeQuickEdit();
        }}
      >
        <DialogContent
          className="max-w-3xl h-[700px] p-0 gap-0 overflow-hidden flex flex-col"
          onCloseAutoFocus={(e) => e.preventDefault()}
          // Toasts (Undo) render outside the dialog; using one must not
          // count as clicking away from it.
          onInteractOutside={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest("[data-sonner-toaster]")
            ) {
              event.preventDefault();
            }
          }}
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">
            {editingAgent?.name ?? editingSummary?.name ?? "Agent"} settings
          </DialogTitle>

          {!editingAgent ? (
            <AgentSettingsSkeleton
              name={editingSummary?.name}
              icon={editingSummary?.icon}
            />
          ) : dialogView === "settings" ? (
            <AgentSettingsView
              agent={editingAgent}
              instructions={
                instructionsDraft ?? editingAgent.systemPrompt ?? ""
              }
              onInstructionsChange={(value) => {
                setInstructionsDraft(value);
                setInstructionsJustSaved(false);
              }}
              instructionsDirty={instructionsDirty}
              onSaveInstructions={() => saveInstructions()}
              onDiscardInstructions={() => setInstructionsDraft(null)}
              isSavingInstructions={updateProfile.isPending}
              instructionsJustSaved={instructionsJustSaved}
              notice={notice}
              onDismissNotice={() => setNotice(null)}
              highlightCatalogId={highlightCatalogId}
              allKnowledgeBases={allKnowledgeBases}
              allConnectors={allConnectors}
              onAddTools={() => setDialogView("add-tools")}
              onChooseTools={(catalog) => chooseTools(catalog, "settings")}
              onEditSubagents={() => setDialogView("subagents")}
              onEditKnowledge={() => setDialogView("knowledge")}
            />
          ) : dialogView === "add-tools" ? (
            <AddToolsView
              agentId={editingAgent.id}
              agentName={editingAgent.name}
              installer={installer}
              onBack={() => showSettings()}
              onChooseTools={(catalog) => chooseTools(catalog, "add-tools")}
              onConnect={(catalog) => {
                setSelectedCatalog(catalog);
                setAddWhenConnected(true);
                setDialogView("connect");
              }}
              onAdded={(catalogId) => showSettings({ highlight: catalogId })}
              onFailed={reportFailure}
            />
          ) : dialogView === "choose-tools" && selectedCatalog ? (
            <ChooseToolsView
              agentId={editingAgent.id}
              agentName={editingAgent.name}
              catalog={selectedCatalog}
              backLabel={
                chooseToolsFrom === "add-tools"
                  ? "Add tools"
                  : editingAgent.name
              }
              onBack={() =>
                chooseToolsFrom === "add-tools"
                  ? setDialogView("add-tools")
                  : showSettings()
              }
              onDone={(catalogId) => showSettings({ highlight: catalogId })}
            />
          ) : dialogView === "connect" && selectedCatalog ? (
            <ConnectView
              catalog={selectedCatalog}
              agentName={editingAgent.name}
              installer={installer}
              addWhenConnected={addWhenConnected}
              onAddWhenConnectedChange={setAddWhenConnected}
              onCancel={() => setDialogView("add-tools")}
              onConnected={() => setDialogView("installing")}
            />
          ) : dialogView === "installing" && selectedCatalog ? (
            <InstallingView
              catalog={selectedCatalog}
              agentId={editingAgent.id}
              agentName={editingAgent.name}
              addWhenConnected={addWhenConnected}
              onBack={() => setDialogView("add-tools")}
              onChooseTools={(catalog) => chooseTools(catalog, "add-tools")}
              onAdded={(catalogId) => showSettings({ highlight: catalogId })}
              onFailed={reportFailure}
            />
          ) : dialogView === "subagents" ? (
            <SubagentsView
              agentId={editingAgent.id}
              agentName={editingAgent.name}
              onBack={() => showSettings()}
            />
          ) : dialogView === "knowledge" ? (
            <KnowledgeView
              agent={editingAgent}
              allKnowledgeBases={allKnowledgeBases}
              allConnectors={allConnectors}
              isLoading={knowledgePickerLoading}
              onBack={() => showSettings()}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={closeGuardOpen} onOpenChange={setCloseGuardOpen}>
        <DialogContent className="max-w-md" role="alertdialog">
          <DialogHeader>
            <DialogTitle>Save your instructions?</DialogTitle>
            <DialogDescription>
              {editingAgent?.scope === "personal"
                ? `You edited ${editingAgent.name}'s instructions but didn't save.`
                : `You edited ${editingAgent?.name ?? "this agent"}'s instructions but didn't save. Everyone using this agent gets the saved version.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="text-destructive"
              onClick={closeQuickEdit}
            >
              Discard
            </Button>
            <Button variant="outline" onClick={() => setCloseGuardOpen(false)}>
              Keep editing
            </Button>
            <Button
              onClick={() => saveInstructions({ thenClose: true })}
              disabled={updateProfile.isPending}
            >
              Save and close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Connect runs inline inside the dialog; everything else (and OAuth,
          which leaves the page) keeps the registry's own modals. */}
      {dialogView !== "connect" && (
        <McpInstallDialogs orchestrator={installer} />
      )}
    </>
  );
});

// ============================================================================
// Internal: picker row
// ============================================================================

type PickerAgent = archestraApiTypes.GetChatAgentRosterResponses["200"][number];

function AgentPickerRow({
  agent,
  isSelected,
  isHighlighted,
  canEdit,
  runtimeEnabled,
  gate,
  optionProps,
  onSelect,
  onEdit,
  onWarm,
  onDuplicate,
  onConnect,
}: {
  agent: PickerAgent;
  isSelected: boolean;
  isHighlighted: boolean;
  canEdit: boolean;
  runtimeEnabled: boolean;
  gate: ReturnType<typeof resolveAgentConnectionGate>;
  optionProps: ReturnType<
    ReturnType<typeof useListboxNavigation>["getOptionProps"]
  >;
  onSelect: () => void;
  onEdit: () => void;
  onWarm: () => void;
  onDuplicate: () => void;
  onConnect: (catalogIds: string[]) => void;
}) {
  const isBlocked = gate.kind === "block";
  const connectLabel =
    gate.kind === "ok"
      ? ""
      : gate.catalogIds.length === 1
        ? `Connect ${gate.serverNames[0]}`
        : `Connect ${gate.catalogIds.length} servers`;

  return (
    <div
      className={cn(
        "rounded-lg px-2 py-1.5 transition-colors",
        !isBlocked && "hover:bg-accent",
        // The highlight is a fill, like the setup menu; a ring here reads as a
        // second selection state.
        isHighlighted && "bg-accent",
      )}
    >
      <div className="flex w-full items-center gap-2">
        <UnstyledButton
          {...optionProps}
          role="option"
          type="button"
          aria-selected={isSelected}
          disabled={isBlocked}
          onClick={onSelect}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2.5 text-left",
            isBlocked ? "cursor-not-allowed opacity-60" : "cursor-pointer",
          )}
        >
          <div
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
              isSelected ? "bg-primary/10 ring-1 ring-primary/20" : "bg-muted",
            )}
          >
            <AgentIcon icon={agent.icon} size={14} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium">{agent.name}</span>
              {runtimeEnabled && agent.runtime && (
                <RuntimeCapableIndicator runtime={agent.runtime} />
              )}
              {/* Greying alone reads as "styled differently"; the word is
                  what says the row cannot be picked. */}
              {isBlocked && (
                <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                  Unavailable
                </span>
              )}
            </div>
            {agent.description && !isBlocked && gate.kind === "ok" && (
              <div className="truncate text-xs text-muted-foreground">
                {agent.description}
              </div>
            )}
            {gate.kind !== "ok" && (
              // Wraps rather than truncating: the whole point of the line is
              // the reason, and a truncated one hides the server to connect.
              <div
                className={cn(
                  "line-clamp-2 text-xs",
                  isBlocked
                    ? "text-muted-foreground"
                    : "text-amber-700 dark:text-amber-500",
                )}
              >
                {isBlocked
                  ? `Needs your connection to ${listServerNames(gate.serverNames)}`
                  : `${listServerNames(gate.serverNames)} tools won't work until you connect`}
              </div>
            )}
          </div>
          {isSelected && (
            <Check
              className="h-3.5 w-3.5 shrink-0 text-primary"
              aria-label="Selected"
            />
          )}
        </UnstyledButton>
        {gate.kind === "warn" ? (
          <Button
            variant="outline"
            size="xs"
            onClick={(e) => {
              e.stopPropagation();
              onConnect(gate.catalogIds);
            }}
          >
            Connect
          </Button>
        ) : gate.kind === "ok" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label={
                  canEdit
                    ? `Edit ${agent.name}`
                    : `Duplicate ${agent.name} to edit a copy`
                }
                onPointerEnter={canEdit ? onWarm : undefined}
                onFocus={canEdit ? onWarm : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  if (canEdit) onEdit();
                  else onDuplicate();
                }}
              >
                {canEdit ? <SlidersHorizontal /> : <Copy />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {canEdit ? "Edit" : "Duplicate to edit a copy"}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {/* Its own line, aligned with the text column: the one action that
          unblocks the row, without stealing the width the name needs. */}
      {isBlocked && (
        <div className="mt-1.5 pl-[38px]">
          <Button
            size="xs"
            className="w-full justify-center"
            onClick={(e) => {
              e.stopPropagation();
              onConnect(gate.catalogIds);
            }}
          >
            <span>{connectLabel}</span>
          </Button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Internal: the tool icons beside the agent name
// ============================================================================

const MAX_VISIBLE_AVATARS = 3;

type SummaryServer = {
  catalog: Pick<McpCatalogDirectoryItem, "id" | "icon">;
  name: string;
  toolCount: number;
};
type SummaryKnowledge = {
  id: string;
  name: string;
  kind: string;
  connectorType?: string;
};

/**
 * The icon group inside the agent's button, after its name. Hovering lists
 * what the agent can use; clicking is the button's own click (the picker).
 * `descriptionId` labels the summary the button points at, so screen readers
 * hear it without a hover.
 */
/**
 * The same stacked circles as a fixed tool list, standing in for "every tool"
 * so an Auto-mode agent's button reads like any other agent's.
 */
function AllToolsIcons({
  descriptionId,
  agentName,
}: {
  descriptionId: string;
  agentName: string;
}) {
  return (
    <>
      <span id={descriptionId} className="sr-only">
        {`${agentName} uses all tools`}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex shrink-0 items-center" aria-hidden="true">
            <OverlappedIcons
              icons={ALL_TOOLS_ICONS}
              maxVisible={ALL_TOOLS_ICONS.length}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">All tools</TooltipContent>
      </Tooltip>
    </>
  );
}

const ALL_TOOLS_ICONS = [
  {
    key: "tools",
    icon: <Wrench className="size-3 text-muted-foreground" />,
  },
  {
    key: "all",
    icon: <InfinityIcon className="size-3 text-muted-foreground" />,
  },
];

function AgentToolIcons({
  descriptionId,
  agentName,
  subagents,
  servers,
  knowledgeSources,
  missingCatalogIds,
  canEdit,
  onOpenChange,
}: {
  descriptionId: string;
  agentName: string;
  subagents: { id: string; name: string; icon?: string | null }[];
  servers: SummaryServer[];
  knowledgeSources: SummaryKnowledge[];
  missingCatalogIds: Set<string>;
  canEdit: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const icons = [
    ...subagents.map((agent) => ({
      key: agent.id,
      icon: <AgentIcon icon={agent.icon ?? null} size={12} />,
    })),
    ...servers.map((server) => ({
      key: server.catalog.id,
      icon: (
        <McpCatalogIcon
          icon={server.catalog.icon}
          catalogId={server.catalog.id}
          size={12}
        />
      ),
    })),
    ...knowledgeSources
      .filter((source) => source.connectorType)
      .map((source) => ({
        key: `knowledge-${source.id}`,
        icon: (
          <ConnectorTypeIcon
            type={source.connectorType as string}
            className="h-3 w-3"
          />
        ),
      })),
  ];

  if (icons.length === 0) return null;

  const summaryLabel = [
    subagents.length > 0 && countLabel(subagents.length, "subagent"),
    servers.length > 0 && countLabel(servers.length, "tool server"),
    knowledgeSources.length > 0 &&
      countLabel(knowledgeSources.length, "knowledge source"),
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <>
      <span id={descriptionId} className="sr-only">
        {`${agentName} uses ${summaryLabel}`}
      </span>
      <HoverCard openDelay={300} closeDelay={100} onOpenChange={onOpenChange}>
        <HoverCardTrigger asChild>
          <span className="flex shrink-0 items-center" aria-hidden="true">
            <OverlappedIcons
              icons={icons}
              maxVisible={MAX_VISIBLE_AVATARS}
              overflowTooltip=""
              itemClassName={CIRCLE_LIFT}
            />
          </span>
        </HoverCardTrigger>
        {/* Capped to the room above the composer: a long list otherwise runs
            off the top of a short window (Safari shows it clipped). */}
        <HoverCardContent
          side="top"
          align="start"
          collisionPadding={8}
          className="w-max min-w-48 max-w-80 max-h-(--radix-hover-card-content-available-height) overflow-y-auto p-3"
        >
          {subagents.length > 0 && (
            <SummaryGroup title="Subagents">
              {subagents.map((agent) => (
                <SummaryItem
                  key={agent.id}
                  icon={<AgentIcon icon={agent.icon ?? null} size={14} />}
                  name={agent.name}
                  meta="agent"
                />
              ))}
            </SummaryGroup>
          )}
          {servers.length > 0 && (
            <SummaryGroup title="Tools">
              {servers.map((server) => (
                <SummaryItem
                  key={server.catalog.id}
                  icon={
                    <McpCatalogIcon
                      icon={server.catalog.icon}
                      catalogId={server.catalog.id}
                      size={14}
                    />
                  }
                  name={server.name}
                  warning={
                    missingCatalogIds.has(server.catalog.id)
                      ? "You haven't connected yet"
                      : undefined
                  }
                  meta={countLabel(server.toolCount, "tool")}
                />
              ))}
            </SummaryGroup>
          )}
          {knowledgeSources.length > 0 && (
            <SummaryGroup title="Knowledge">
              {knowledgeSources.map((source) => (
                <SummaryItem
                  key={source.id}
                  icon={
                    source.connectorType ? (
                      <ConnectorTypeIcon
                        type={source.connectorType}
                        className="size-3.5"
                      />
                    ) : null
                  }
                  name={source.name}
                  meta={source.kind}
                />
              ))}
            </SummaryGroup>
          )}
          {!canEdit && (
            <div className="mt-2 border-t pt-2 text-xs text-muted-foreground">
              Only people who can edit this agent can change its tools
            </div>
          )}
        </HoverCardContent>
      </HoverCard>
    </>
  );
}

function SummaryGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-2 last-of-type:mb-0">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}

function SummaryItem({
  icon,
  name,
  meta,
  warning,
}: {
  icon: ReactNode;
  name: string;
  meta: string;
  warning?: string;
}) {
  return (
    <li className="flex items-start gap-2.5 py-0.5">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded bg-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        {warning && (
          <span className="block text-xs text-amber-700 dark:text-amber-500">
            {warning}
          </span>
        )}
      </span>
      <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
        {meta}
      </span>
    </li>
  );
}

function countLabel(count: number, noun: string) {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** True from the first effect after mount: work that must not race first paint. */
function useAfterFirstPaint() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 0);
    return () => clearTimeout(timer);
  }, []);
  return ready;
}

// A hovered circle rises a hair above its neighbours, marking it as live.
const CIRCLE_LIFT =
  "relative hover:z-10 motion-safe:transition-transform motion-safe:duration-150 motion-safe:hover:-translate-y-[1.5px]";
