"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
  isBuiltInCatalogId,
} from "@archestra/shared";
import {
  Check,
  Copy,
  ExternalLink,
  Plus,
  Search,
  SlidersHorizontal,
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
import { Badge } from "@/components/ui/badge";
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
  useAgentCredentialReadiness,
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
import { useListboxNavigation } from "@/lib/hooks/use-listbox-navigation";
import { useConnectors } from "@/lib/knowledge/connector.query";
import { useKnowledgeBases } from "@/lib/knowledge/knowledge-base.query";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpInstallOrchestrator } from "@/lib/mcp/mcp-install-orchestrator.hook";
import { cn } from "@/lib/utils/tailwind";
import {
  AddToolsView,
  ConnectView,
  InstallingView,
} from "./agent-quick-edit/add-tools-view";
import { ChooseToolsView } from "./agent-quick-edit/choose-tools-view";
import { KnowledgeView } from "./agent-quick-edit/knowledge-view";
import {
  AgentSettingsSkeleton,
  AgentSettingsView,
  type QuickEditNotice,
} from "./agent-quick-edit/settings-view";
import { SubagentsView } from "./agent-quick-edit/subagents-view";
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
  const { data: allAgents = [] } = useChatAgents();
  const [open, setOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [cloningAgentId, setCloningAgentId] = useState<string | null>(null);
  const afterFirstPaint = useAfterFirstPaint();
  const { data: credentialReadiness } = useAgentCredentialReadiness({
    enabled: open || summaryOpen,
  });
  const readinessByAgent = useMemo(
    () => indexReadinessByAgent(credentialReadiness),
    [credentialReadiness],
  );
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
  // Loaded after first paint, not on open, so the Pinned group is there the
  // moment the picker opens instead of popping in once the request lands.
  const { data: pinnedIds } = usePinnedAgentIds({
    enabled: open || afterFirstPaint,
  });
  const groupIdPrefix = useId();
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
      allAgents.find((a) => !a.builtIn && a.scope === "personal") ??
      allAgents.find((a) => !a.builtIn) ??
      null,
    [allAgents, currentAgentId],
  );
  // The roster omits large embedded icons and editing-only fields. Hydrate one
  // record after the composer's first paint, so the response never competes
  // with the first useful render; the trigger holds placeholders until then.
  const { data: currentAgentDetail } = useProfile(
    currentAgentSummary?.id ?? undefined,
    { enabled: open || afterFirstPaint },
  );
  const currentAgent = currentAgentDetail ?? currentAgentSummary;
  const displayAgentName = currentAgent?.name ?? "Select agent";
  const effectiveAgentId = currentAgent?.id ?? currentAgentId;
  const shouldLoadAgentManagementDetails =
    open || !!editingAgentId || afterFirstPaint;
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
  const { data: catalogItems = [], isSuccess: catalogLoaded } =
    useInternalMcpCatalog({
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
  const triggerSubagents = useMemo(() => {
    const targetIds = new Set(triggerDelegations.map((d) => d.id));
    return allAgents.filter((a) => targetIds.has(a.id));
  }, [allAgents, triggerDelegations]);

  const { data: knowledgeBasesData, isSuccess: knowledgeBasesLoaded } =
    useKnowledgeBases({
      enabled: shouldLoadAgentManagementDetails && !!canReadKnowledgeBase,
    });
  const { data: connectorsData, isSuccess: connectorsLoaded } = useConnectors({
    enabled: shouldLoadAgentManagementDetails && !!canReadKnowledgeBase,
  });
  const allKnowledgeBases = knowledgeBasesData ?? [];
  const allConnectors = connectorsData ?? [];
  const knowledgeSources = useMemo(() => {
    const knowledgeBaseIds = currentAgent?.knowledgeBaseIds ?? [];
    const connectorIds = currentAgent?.connectorIds ?? [];
    return [
      ...(knowledgeBasesData ?? [])
        .filter((kb) => knowledgeBaseIds.includes(kb.id))
        .map((kb) => ({
          id: kb.id,
          name: kb.name,
          kind: "knowledge base",
          connectorType: kb.connectors?.[0]?.connectorType,
        })),
      ...(connectorsData ?? [])
        .filter((connector) => connectorIds.includes(connector.id))
        .map((connector) => ({
          id: connector.id,
          name: connector.name,
          kind: "connector",
          connectorType: connector.connectorType,
        })),
    ];
  }, [currentAgent, knowledgeBasesData, connectorsData]);

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
  // The settings view also needs the agent's tools and subagents. Fetch them
  // with the agent, not after it renders, and start all three when the pointer
  // or focus reaches a row's edit button, ahead of the click.
  const [warmAgentId, setWarmAgentId] = useState<string | null>(null);
  const quickEditAgentId = editingAgentId ?? warmAgentId ?? undefined;
  useProfile(quickEditAgentId);
  useAllProfileTools({
    filters: { agentId: quickEditAgentId },
    skipPagination: true,
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

  const chooseTools = (
    catalog: CatalogItem,
    from: "settings" | "add-tools",
  ) => {
    setSelectedCatalog(catalog);
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
      <div className="flex min-w-0 max-w-[340px] items-center">
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
              aria-label={displayAgentName}
              data-agent-selector
              onKeyDown={navigation.onTriggerKeyDown}
              className="min-w-0"
            >
              <AgentIcon icon={currentAgent?.icon} size={16} />
              <span className="truncate flex-1 text-left">
                {displayAgentName}
              </span>
              {/* In Auto mode the agent reaches everything dynamically, so
                  per-server icons would mean nothing; the chip is part of
                  the agent's own button rather than a second control. */}
              {currentAgent?.accessAllTools && (
                <Badge variant="secondary" className="shrink-0">
                  All tools
                </Badge>
              )}
              {runtimeEnabled && currentAgent?.runtime && (
                <RuntimeCapableIndicator runtime={currentAgent.runtime} />
              )}
            </PromptInputButton>
          </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="start"
            sideOffset={8}
            className="w-[360px] p-0 rounded-xl"
          >
            <div className="p-2.5">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="Search agents"
                  aria-label="Search agents"
                  {...navigation.inputProps}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 pl-8 text-sm rounded-lg bg-muted/50"
                  autoFocus
                />
              </div>
            </div>
            <div
              {...navigation.listboxProps}
              role="listbox"
              aria-label="Agents"
              className="max-h-[320px] overflow-y-auto px-1.5 pb-1.5"
            >
              {filteredAgents.length === 0 ? (
                <div className="flex flex-col items-center gap-2.5 px-4 py-6 text-center">
                  <p className="text-sm text-muted-foreground">
                    No agents match "{search}"
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => setSearch("")}
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

        {currentAgent?.accessAllTools ? null : !triggerIconsLoaded ? (
          <span
            className="ml-1 flex min-w-14 items-center"
            aria-hidden="true"
            data-testid="agent-tools-placeholder"
          >
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                className="-ml-1.5 size-5 rounded-full border-2 border-background bg-muted first:ml-0 animate-pulse"
              />
            ))}
          </span>
        ) : (
          <AgentToolSummary
            agentName={displayAgentName}
            subagents={triggerSubagents}
            servers={assignedServers}
            knowledgeSources={knowledgeSources}
            missingCatalogIds={missingCatalogIds}
            canEdit={canEditCurrentAgent}
            onOpenChange={setSummaryOpen}
            onOpenTools={() =>
              currentAgent
                ? canEditCurrentAgent
                  ? openQuickEdit(currentAgent.id)
                  : setOpen(true)
                : undefined
            }
            onAddTools={() =>
              currentAgent && openQuickEdit(currentAgent.id, "add-tools")
            }
          />
        )}
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

type PickerAgent = archestraApiTypes.GetAllAgentsResponses["200"][number];

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
        isHighlighted && "bg-accent ring-2 ring-inset ring-primary",
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

type SummaryServer = { catalog: CatalogItem; name: string; toolCount: number };
type SummaryKnowledge = {
  id: string;
  name: string;
  kind: string;
  connectorType?: string;
};

/**
 * The icon group beside the agent's name. Hovering lists what the agent can
 * use; clicking opens its settings (or the picker, for an agent the user
 * cannot edit). It is its own button rather than part of the name's, so each
 * has its own focus ring and label.
 */
function AgentToolSummary({
  agentName,
  subagents,
  servers,
  knowledgeSources,
  missingCatalogIds,
  canEdit,
  onOpenChange,
  onOpenTools,
  onAddTools,
}: {
  agentName: string;
  subagents: { id: string; name: string; icon?: string | null }[];
  servers: SummaryServer[];
  knowledgeSources: SummaryKnowledge[];
  missingCatalogIds: Set<string>;
  canEdit: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenTools: () => void;
  onAddTools: () => void;
}) {
  const hasNonBuiltInTools =
    subagents.length > 0 ||
    servers.some((server) => !isBuiltInCatalogId(server.catalog.id));
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

  const addButton = canEdit && !hasNonBuiltInTools && (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Add tools"
          onClick={onAddTools}
          className="-ml-1 rounded-full bg-muted hover:bg-muted/80 size-5"
        >
          <Plus className="size-3 text-muted-foreground" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">Add tools</TooltipContent>
    </Tooltip>
  );

  if (icons.length === 0) {
    return addButton ? <span className="ml-1 flex">{addButton}</span> : null;
  }

  const summaryLabel = [
    subagents.length > 0 && countLabel(subagents.length, "subagent"),
    servers.length > 0 && countLabel(servers.length, "tool server"),
    knowledgeSources.length > 0 &&
      countLabel(knowledgeSources.length, "knowledge source"),
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <span className="ml-1 flex items-center">
      <HoverCard openDelay={300} closeDelay={100} onOpenChange={onOpenChange}>
        <HoverCardTrigger asChild>
          <UnstyledButton
            type="button"
            onClick={onOpenTools}
            aria-label={`${agentName} uses ${summaryLabel}. ${canEdit ? "Edit tools" : "Open agent picker"}`}
            className="flex items-center rounded-full px-1 py-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <OverlappedIcons
              icons={icons}
              maxVisible={MAX_VISIBLE_AVATARS}
              overflowTooltip=""
            />
          </UnstyledButton>
        </HoverCardTrigger>
        <HoverCardContent side="top" align="start" className="w-80 p-3">
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
          <div className="mt-2 border-t pt-2 text-xs text-muted-foreground">
            {canEdit
              ? "Click to edit tools"
              : "Only people who can edit this agent can change its tools"}
          </div>
        </HoverCardContent>
      </HoverCard>
      {addButton}
    </span>
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
