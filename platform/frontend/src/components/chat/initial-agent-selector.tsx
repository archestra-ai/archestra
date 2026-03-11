"use client";

import {
  type archestraApiTypes,
  E2eTestId,
  isBuiltInCatalogId,
  type SupportedProvider,
} from "@shared";
import {
  BookOpen,
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
  PaperclipIcon,
  Plus,
  Search,
  Settings,
  Users,
  Wrench,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { LocalServerInstallDialog } from "@/app/mcp/registry/_parts/local-server-install-dialog";
import { NoAuthInstallDialog } from "@/app/mcp/registry/_parts/no-auth-install-dialog";
import { RemoteServerInstallDialog } from "@/app/mcp/registry/_parts/remote-server-install-dialog";
import { AgentBadge } from "@/components/agent-badge";
import { AgentIcon } from "@/components/agent-icon";
import { McpCatalogIcon } from "@/components/agent-tools-editor";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { ChatApiKeySelector } from "@/components/chat/chat-api-key-selector";
import {
  ModelSelector,
  providerToLogoProvider,
} from "@/components/chat/model-selector";
import { OAuthConfirmationDialog } from "@/components/oauth-confirmation-dialog";
import { TokenSelect } from "@/components/token-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { OverlappedIcons } from "@/components/ui/overlapped-icons";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useInternalAgents, useUpdateProfile } from "@/lib/agent.query";
import { useInvalidateToolAssignmentQueries } from "@/lib/agent-tools.hook";
import {
  useAgentDelegations,
  useAllProfileTools,
  useAssignTool,
  useSyncAgentDelegations,
  useUnassignTool,
} from "@/lib/agent-tools.query";
import { useHasPermissions } from "@/lib/auth.query";
import { useModelsByProvider } from "@/lib/chat-models.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useConnectors } from "@/lib/connector.query";
import {
  useCatalogTools,
  useInternalMcpCatalog,
} from "@/lib/internal-mcp-catalog.query";
import { useKnowledgeBases } from "@/lib/knowledge-base.query";
import { useMcpInstallOrchestrator } from "@/lib/mcp-install-orchestrator.hook";
import {
  useMcpServers,
  useMcpServersGroupedByCatalog,
} from "@/lib/mcp-server.query";
import { cn } from "@/lib/utils";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

interface InitialAgentSelectorProps {
  currentAgentId: string | null;
  onAgentChange: (agentId: string) => void;
  // Model selector props
  selectedModel?: string;
  onModelChange?: (model: string) => void;
  // API key selector props
  conversationId?: string;
  currentConversationChatApiKeyId?: string | null;
  currentProvider?: SupportedProvider;
  initialApiKeyId?: string | null;
  onApiKeyChange?: (apiKeyId: string) => void;
  onProviderChange?: (provider: SupportedProvider, apiKeyId: string) => void;
  messageCount?: number;
  isModelsLoading?: boolean;
  agentLlmApiKeyId?: string | null;
  // Attach
  onAttach?: () => void;
  attachDisabled?: boolean;
  attachDisabledReason?: string;
}

export function InitialAgentSelector({
  currentAgentId,
  onAgentChange,
  selectedModel,
  onModelChange,
  conversationId,
  currentConversationChatApiKeyId,
  currentProvider,
  initialApiKeyId,
  onApiKeyChange,
  onProviderChange,
  messageCount,
  isModelsLoading,
  agentLlmApiKeyId,
  onAttach,
  attachDisabled,
  attachDisabledReason,
}: InitialAgentSelectorProps) {
  const { data: allAgents = [] } = useInternalAgents();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const { data: isAdmin } = useHasPermissions({ agent: ["admin"] });
  const { data: canUpdateOrganization } = useHasPermissions({
    organization: ["update"],
  });

  const [agentSearch, setAgentSearch] = useState("");
  const [scopeFilters, setScopeFilters] = useState({
    my: true,
    shared: true,
    others: false,
  });

  // Install orchestrator lifted here so dialogs survive dropdown close
  const installer = useMcpInstallOrchestrator();

  // Keep dropdown open while an install dialog is active
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const isInstallDialogOpen =
    installer.isDialogOpened("remote-install") ||
    installer.isDialogOpened("oauth") ||
    installer.isDialogOpened("no-auth") ||
    installer.isDialogOpened("local-install");

  const handleDropdownOpenChange = (open: boolean) => {
    if (!open && isInstallDialogOpen) return;
    setDropdownOpen(open);
  };

  const currentAgent = useMemo(
    () =>
      allAgents.find((a) => a.id === currentAgentId) ?? allAgents[0] ?? null,
    [allAgents, currentAgentId],
  );

  const { data: knowledgeBasesData } = useKnowledgeBases();
  const { data: connectorsData } = useConnectors();
  const allKnowledgeBases = knowledgeBasesData?.data ?? [];
  const allConnectors = connectorsData?.data ?? [];
  const knowledgeBaseIds = currentAgent?.knowledgeBaseIds ?? [];
  const connectorIds = currentAgent?.connectorIds ?? [];

  const matchedKbs = useMemo(
    () => allKnowledgeBases.filter((k) => knowledgeBaseIds.includes(k.id)),
    [allKnowledgeBases, knowledgeBaseIds],
  );
  const matchedConnectors = useMemo(
    () => allConnectors.filter((c) => connectorIds.includes(c.id)),
    [allConnectors, connectorIds],
  );

  const agentConnectorTypes = useMemo(() => {
    const kbConnectorTypes = matchedKbs.flatMap(
      (kb) => kb.connectors?.map((c) => c.connectorType) ?? [],
    );
    const directConnectorTypes = matchedConnectors.map((c) => c.connectorType);
    return [...new Set([...kbConnectorTypes, ...directConnectorTypes])];
  }, [matchedKbs, matchedConnectors]);

  const effectiveAgentId = currentAgent?.id ?? currentAgentId;

  const { data: catalogItems = [] } = useInternalMcpCatalog();
  const { data: assignedToolsData } = useAllProfileTools({
    filters: { agentId: effectiveAgentId ?? undefined },
    skipPagination: true,
    enabled: !!effectiveAgentId,
  });

  const assignedCatalogs = useMemo(() => {
    const ids = new Set<string>();
    for (const at of assignedToolsData?.data ?? []) {
      if (at.tool.catalogId) ids.add(at.tool.catalogId);
    }
    return catalogItems.filter((c) => ids.has(c.id));
  }, [assignedToolsData, catalogItems]);

  const { data: triggerDelegations = [] } = useAgentDelegations(
    effectiveAgentId ?? undefined,
  );
  const triggerSubagents = useMemo(() => {
    const targetIds = new Set(triggerDelegations.map((d) => d.id));
    return allAgents.filter((a) => targetIds.has(a.id));
  }, [allAgents, triggerDelegations]);

  // Filter agents for the switch list
  const aq = agentSearch.toLowerCase().trim();
  const otherAgents = allAgents.filter((a) => a.id !== currentAgent?.id);
  const filteredAgents = useMemo(() => {
    return otherAgents.filter((a) => {
      const scope = (a as unknown as Record<string, unknown>).scope as string;
      const authorId = (a as unknown as Record<string, unknown>)
        .authorId as string;
      const isMyScope = scope === "personal" && authorId === userId;
      const isShared = scope === "team" || scope === "org";
      const isOthers = scope === "personal" && authorId !== userId;
      const matchScope =
        (scopeFilters.my && isMyScope) ||
        (scopeFilters.shared && isShared) ||
        (scopeFilters.others && isOthers);
      const matchSearch = !aq || a.name.toLowerCase().includes(aq);
      return matchScope && matchSearch;
    });
  }, [otherAgents, scopeFilters, aq, userId]);

  const toggleScope = (key: keyof typeof scopeFilters) => {
    setScopeFilters((p) => ({ ...p, [key]: !p[key] }));
  };

  const handleAgentSelect = (agentId: string) => {
    onAgentChange(agentId);
    setAgentSearch("");
  };

  // Resolve model info for the trigger (same logic as ModelSelector)
  const { modelsByProvider } = useModelsByProvider({
    apiKeyId: conversationId
      ? currentConversationChatApiKeyId
      : initialApiKeyId,
  });

  const selectedModelInfo = useMemo(() => {
    if (!selectedModel) return null;
    for (const [provider, models] of Object.entries(modelsByProvider)) {
      const model = models.find((m) => m.id === selectedModel);
      if (model) {
        const logo =
          providerToLogoProvider[
            provider as keyof typeof providerToLogoProvider
          ];
        return { displayName: model.displayName, logo };
      }
    }
    return { displayName: selectedModel, logo: null };
  }, [selectedModel, modelsByProvider]);

  const scopeTabs = [
    { key: "my" as const, label: "My" },
    { key: "shared" as const, label: "Shared" },
    { key: "others" as const, label: "Others" },
  ];

  return (
    <>
      <DropdownMenu open={dropdownOpen} onOpenChange={handleDropdownOpenChange}>
        <DropdownMenuTrigger asChild>
          <PromptInputButton
            role="combobox"
            data-agent-selector
            className="max-w-[300px] min-w-0"
          >
            <AgentIcon
              icon={
                (currentAgent as unknown as Record<string, unknown>)?.icon as
                  | string
                  | null
              }
              size={16}
            />
            <span className="truncate flex-1 text-left">
              {currentAgent?.name ?? "Select agent"}
            </span>
            <ToolServerAvatarGroup
              catalogs={assignedCatalogs}
              subagents={triggerSubagents}
              connectorTypes={agentConnectorTypes}
              showAddButton
            />
            {selectedModelInfo?.logo && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="ml-1 shrink-0">
                    <ModelSelectorLogo provider={selectedModelInfo.logo} />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {selectedModelInfo.displayName}
                </TooltipContent>
              </Tooltip>
            )}
          </PromptInputButton>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-64"
        >
          {/* Attach file */}
          {onAttach && !attachDisabled && (
            <DropdownMenuItem
              onClick={onAttach}
              data-testid={E2eTestId.ChatFileUploadButton}
            >
              <PaperclipIcon className="size-4" />
              Attach image or file
            </DropdownMenuItem>
          )}
          {onAttach && attachDisabled && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span data-testid={E2eTestId.ChatDisabledFileUploadButton}>
                  <DropdownMenuItem disabled>
                    <PaperclipIcon className="size-4" />
                    Attach image or file
                  </DropdownMenuItem>
                </span>
              </TooltipTrigger>
              <TooltipContent side="right">
                {canUpdateOrganization ? (
                  <span>
                    File uploads are disabled.{" "}
                    <a
                      href="/settings/security"
                      className="underline hover:no-underline"
                      aria-label="Enable file uploads in security settings"
                    >
                      Enable in settings
                    </a>
                  </span>
                ) : (
                  attachDisabledReason
                )}
              </TooltipContent>
            </Tooltip>
          )}

          {/* Current agent config submenu */}
          {currentAgent && (
            <DropdownMenuSub open={isInstallDialogOpen ? true : undefined}>
              <DropdownMenuSubTrigger>
                <AgentIcon
                  icon={
                    (currentAgent as unknown as Record<string, unknown>)
                      ?.icon as string | null
                  }
                  size={16}
                />
                <span className="truncate">{currentAgent.name}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent className="w-56">
                  <InstructionsSubMenu agent={currentAgent} />
                  <ToolsSubMenu
                    agentId={currentAgent.id}
                    onInstall={installer.triggerInstallByCatalogId}
                    forceOpen={isInstallDialogOpen}
                  />
                  <SubagentsSubMenu agentId={currentAgent.id} />
                  <KnowledgeSubMenu
                    knowledgeBases={matchedKbs}
                    connectors={matchedConnectors}
                  />

                  {/* Model & API Key (admin only) */}
                  {isAdmin &&
                  ((selectedModel && onModelChange) ||
                    conversationId ||
                    onApiKeyChange) ? (
                    <>
                      <DropdownMenuSeparator />
                      <div className="px-2 py-1.5">
                        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                          Model & API Key
                        </span>
                        {selectedModel && onModelChange && (
                          <div className="mt-1">
                            <ModelSelector
                              selectedModel={selectedModel}
                              onModelChange={onModelChange}
                              variant="outline"
                              apiKeyId={
                                conversationId
                                  ? currentConversationChatApiKeyId
                                  : initialApiKeyId
                              }
                            />
                          </div>
                        )}
                        {(conversationId || onApiKeyChange) && (
                          <div className="mt-1">
                            <ChatApiKeySelector
                              variant="outline"
                              conversationId={conversationId}
                              currentProvider={currentProvider}
                              currentConversationChatApiKeyId={
                                conversationId
                                  ? (currentConversationChatApiKeyId ?? null)
                                  : (initialApiKeyId ?? null)
                              }
                              messageCount={messageCount}
                              onApiKeyChange={onApiKeyChange}
                              onProviderChange={onProviderChange}
                              isModelsLoading={isModelsLoading}
                              agentLlmApiKeyId={agentLlmApiKeyId}
                            />
                          </div>
                        )}
                      </div>
                    </>
                  ) : null}

                  <DropdownMenuSeparator />

                  <DropdownMenuItem asChild>
                    <a
                      href={`/agents?edit=${currentAgent.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Settings className="size-4" />
                      Full configuration
                      <ExternalLink className="size-3 ml-auto text-muted-foreground" />
                    </a>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          )}

          <DropdownMenuSeparator />

          {/* Scope filter toggles */}
          <div className="flex gap-1 px-2 py-1">
            {scopeTabs.map((s) => {
              const active = scopeFilters[s.key];
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleScope(s.key);
                  }}
                  className={cn(
                    "px-2.5 py-1 rounded-md text-[11px] font-medium transition-all border",
                    active
                      ? "bg-primary/10 text-primary border-primary/20"
                      : "text-muted-foreground border-border opacity-60",
                  )}
                >
                  {s.label}
                </button>
              );
            })}
          </div>

          {/* Search agents */}
          <div className="px-2 py-1">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none" />
              <Input
                value={agentSearch}
                onChange={(e) => setAgentSearch(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Switch agent..."
                className="h-7 pl-7 text-xs"
              />
            </div>
          </div>

          {/* Agent list */}
          <div className="max-h-[180px] overflow-y-auto">
            {filteredAgents.length === 0 ? (
              <div className="py-4 text-center text-xs text-muted-foreground">
                No agents found
              </div>
            ) : (
              filteredAgents.map((a) => (
                <DropdownMenuItem
                  key={a.id}
                  onSelect={(e) => e.preventDefault()}
                  onClick={() => handleAgentSelect(a.id)}
                >
                  <AgentIcon
                    icon={
                      (a as unknown as Record<string, unknown>).icon as
                        | string
                        | null
                    }
                    size={14}
                  />
                  <span className="flex-1 truncate">{a.name}</span>
                  <AgentBadge
                    type={
                      (a as unknown as Record<string, unknown>).scope as
                        | "personal"
                        | "team"
                        | "org"
                    }
                    className="text-[10px] px-1.5 py-0"
                  />
                </DropdownMenuItem>
              ))
            )}
          </div>

          <DropdownMenuSeparator />

          <DropdownMenuItem asChild>
            <a
              href="/agents?create=true"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Plus className="size-4" />
              Create Agent
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Install dialogs — rendered at top level so they survive dropdown close */}
      <RemoteServerInstallDialog
        isOpen={installer.isDialogOpened("remote-install")}
        onClose={installer.closeRemoteInstall}
        onConfirm={installer.handleRemoteServerInstallConfirm}
        catalogItem={installer.selectedCatalogItem}
        isInstalling={installer.isInstalling}
        isReauth={installer.isReauth}
      />
      <OAuthConfirmationDialog
        open={installer.isDialogOpened("oauth")}
        onOpenChange={(open) => {
          if (!open) installer.closeOAuth();
        }}
        serverName={installer.selectedCatalogItem?.name || ""}
        onConfirm={installer.handleOAuthConfirm}
        onCancel={installer.closeOAuth}
        catalogId={installer.selectedCatalogItem?.id}
      />
      <NoAuthInstallDialog
        isOpen={installer.isDialogOpened("no-auth")}
        onClose={installer.closeNoAuth}
        onInstall={installer.handleNoAuthConfirm}
        catalogItem={installer.noAuthCatalogItem}
        isInstalling={installer.isInstalling}
      />
      {installer.localServerCatalogItem && (
        <LocalServerInstallDialog
          isOpen={installer.isDialogOpened("local-install")}
          onClose={installer.closeLocalInstall}
          onConfirm={installer.handleLocalServerInstallConfirm}
          catalogItem={installer.localServerCatalogItem}
          isInstalling={installer.isInstalling}
          isReauth={installer.isReauth}
        />
      )}
    </>
  );
}

// ============================================================================
// Instructions SubMenu
// ============================================================================

function InstructionsSubMenu({
  agent,
}: {
  agent: {
    id: string;
    systemPrompt?: string | null;
  };
}) {
  const updateProfile = useUpdateProfile();
  const [instructions, setInstructions] = useState(agent.systemPrompt ?? "");
  const [savedInstructions, setSavedInstructions] = useState(
    agent.systemPrompt ?? "",
  );
  const [isSaving, setIsSaving] = useState(false);
  const isDirty = instructions !== savedInstructions;

  // biome-ignore lint/correctness/useExhaustiveDependencies: agent.id ensures reset when switching agents
  useEffect(() => {
    setInstructions(agent.systemPrompt ?? "");
    setSavedInstructions(agent.systemPrompt ?? "");
  }, [agent.id, agent.systemPrompt]);

  const handleSave = () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setIsSaving(true);
    updateProfile.mutateAsync(
      {
        id: agent.id,
        data: { systemPrompt: instructions.trim() || null },
      },
      {
        onSettled: () => {
          setIsSaving(false);
          setSavedInstructions(instructions);
        },
      },
    );
  };

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Instructions</DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-72 p-3">
          <DropdownMenuLabel>Agent Instructions</DropdownMenuLabel>
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Tell the agent what to do..."
            rows={5}
            className={cn(
              "mt-1.5 text-xs resize-y",
              isDirty && "border-primary/40",
            )}
          />
          <div className="flex items-center justify-between mt-2">
            <span
              className={cn(
                "text-[10.5px]",
                isDirty ? "text-primary" : "text-muted-foreground",
              )}
            >
              {isSaving
                ? "Saving..."
                : isDirty
                  ? "Unsaved changes"
                  : "Applies to every message."}
            </span>
            {isDirty && (
              <div className="flex gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[11px] text-muted-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (document.activeElement instanceof HTMLElement) {
                      document.activeElement.blur();
                    }
                    setInstructions(savedInstructions);
                  }}
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  className="h-6 text-[11px]"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSave();
                  }}
                  disabled={isSaving}
                >
                  Save
                </Button>
              </div>
            )}
          </div>
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

// ============================================================================
// Tools SubMenu — swaps between server list and inline tool detail
// ============================================================================

function ToolsSubMenu({
  agentId,
  onInstall,
  forceOpen,
}: {
  agentId: string;
  onInstall: (catalogId: string) => void;
  forceOpen?: boolean;
}) {
  const { data: catalogItems = [] } = useInternalMcpCatalog();
  const { data: assignedToolsData } = useAllProfileTools({
    filters: { agentId },
    skipPagination: true,
    enabled: !!agentId,
  });
  const unassignTool = useUnassignTool();
  const invalidateAllQueries = useInvalidateToolAssignmentQueries();
  const allCredentials = useMcpServersGroupedByCatalog();
  const [serverSearch, setServerSearch] = useState("");

  // Inline detail state — when set, the submenu shows tool checklist
  const [detailCatalog, setDetailCatalog] = useState<CatalogItem | null>(null);

  const hasInstallingServers = useMemo(() => {
    if (!allCredentials) return false;
    return Object.values(allCredentials).some((servers) =>
      servers.some(
        (s) =>
          s.localInstallationStatus === "pending" ||
          s.localInstallationStatus === "discovering-tools",
      ),
    );
  }, [allCredentials]);

  useMcpServers({ hasInstallingServers });

  const assignedByCatalog = useMemo(() => {
    const map = new Map<string, { count: number; toolIds: string[] }>();
    for (const at of assignedToolsData?.data ?? []) {
      const catalogId = at.tool.catalogId;
      if (!catalogId) continue;
      const existing = map.get(catalogId) ?? { count: 0, toolIds: [] };
      existing.count++;
      existing.toolIds.push(at.tool.id);
      map.set(catalogId, existing);
    }
    return map;
  }, [assignedToolsData]);

  const assignedCatalogs = useMemo(
    () => catalogItems.filter((c) => assignedByCatalog.has(c.id)),
    [catalogItems, assignedByCatalog],
  );

  const assignedCatalogIds = useMemo(
    () => new Set(assignedCatalogs.map((c) => c.id)),
    [assignedCatalogs],
  );

  const sq = serverSearch.toLowerCase().trim();
  const connectedFiltered = sq
    ? assignedCatalogs.filter((c) => c.name.toLowerCase().includes(sq))
    : assignedCatalogs;

  const availableCatalogs = useMemo(() => {
    let items = catalogItems.filter((c) => !assignedCatalogIds.has(c.id));
    if (sq) {
      items = items.filter((c) => c.name.toLowerCase().includes(sq));
    }
    return items;
  }, [catalogItems, assignedCatalogIds, sq]);

  const handleRemove = async (catalogId: string) => {
    const entry = assignedByCatalog.get(catalogId);
    if (!entry) return;
    await Promise.all(
      entry.toolIds.map((id) =>
        unassignTool.mutateAsync({
          agentId,
          toolId: id,
          skipInvalidation: true,
        }),
      ),
    );
    invalidateAllQueries(agentId);
  };

  return (
    <DropdownMenuSub open={forceOpen ? true : undefined}>
      <DropdownMenuSubTrigger>
        <Wrench className="size-4" />
        <span className="flex-1">Tools</span>
        <span className="text-[10px] text-muted-foreground">
          {assignedByCatalog.size}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className={detailCatalog ? "w-72 p-0" : "w-60"}>
          {detailCatalog ? (
            /* ── Tool detail view ── */
            <InlineToolDetail
              agentId={agentId}
              catalog={detailCatalog}
              onBack={() => setDetailCatalog(null)}
              onDone={() => setDetailCatalog(null)}
            />
          ) : (
            /* ── Server list view ── */
            <>
              <div className="px-2 py-1">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none" />
                  <Input
                    value={serverSearch}
                    onChange={(e) => setServerSearch(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder="Search tools..."
                    className="h-7 pl-7 text-xs"
                  />
                </div>
              </div>
              <DropdownMenuSeparator />

              <div className="max-h-[300px] overflow-y-auto">
                {/* Connected servers */}
                {connectedFiltered.length > 0 && (
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Connected</DropdownMenuLabel>
                    {connectedFiltered.map((catalog) => {
                      const info = assignedByCatalog.get(catalog.id);
                      return (
                        <DropdownMenuItem
                          key={catalog.id}
                          className="group"
                          onSelect={(e) => e.preventDefault()}
                          onClick={() => setDetailCatalog(catalog)}
                        >
                          <McpCatalogIcon
                            icon={catalog.icon}
                            catalogId={catalog.id}
                            size={14}
                          />
                          <span className="flex-1 truncate">
                            {catalog.name}
                          </span>
                          <span className="text-[10px] text-muted-foreground group-hover:opacity-0 transition-opacity">
                            {info?.count ?? 0} tools
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemove(catalog.id);
                            }}
                            className="absolute right-8 opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/15 hover:text-destructive text-muted-foreground transition-all"
                          >
                            <XIcon className="size-3" />
                          </button>
                          <ChevronDown className="size-3 -rotate-90 text-muted-foreground" />
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuGroup>
                )}

                {/* Available servers */}
                {availableCatalogs.length > 0 && (
                  <DropdownMenuGroup>
                    {connectedFiltered.length > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel>Available</DropdownMenuLabel>
                    {availableCatalogs.map((catalog) => {
                      const servers = allCredentials?.[catalog.id] ?? [];
                      const hasCredentials =
                        catalog.serverType === "builtin" || servers.length > 0;
                      const isServerInstalling = servers.some(
                        (s) =>
                          s.localInstallationStatus === "pending" ||
                          s.localInstallationStatus === "discovering-tools",
                      );
                      const isReady = hasCredentials && !isServerInstalling;
                      return (
                        <DropdownMenuItem
                          key={catalog.id}
                          disabled={isServerInstalling}
                          onSelect={(e) => {
                            if (isReady) e.preventDefault();
                          }}
                          onClick={() =>
                            isReady
                              ? setDetailCatalog(catalog)
                              : onInstall(catalog.id)
                          }
                        >
                          <McpCatalogIcon
                            icon={catalog.icon}
                            catalogId={catalog.id}
                            size={14}
                          />
                          <span className="flex-1 truncate">
                            {catalog.name}
                          </span>
                          {isServerInstalling ? (
                            <Loader2 className="size-3 animate-spin text-muted-foreground" />
                          ) : isReady ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                              Add
                            </span>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-[10px] px-1.5 py-0"
                            >
                              Install
                            </Badge>
                          )}
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuGroup>
                )}

                {connectedFiltered.length === 0 &&
                  availableCatalogs.length === 0 && (
                    <div className="py-4 text-center text-xs text-muted-foreground">
                      No tools found
                    </div>
                  )}
              </div>

              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a
                  href="/mcp/registry"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Plus className="size-3.5" />
                  Add New Server
                </a>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

// ============================================================================
// Inline Tool Detail — renders inside the Tools submenu dropdown
// ============================================================================

function InlineToolDetail({
  agentId,
  catalog,
  onBack,
  onDone,
}: {
  agentId: string;
  catalog: CatalogItem;
  onBack: () => void;
  onDone: () => void;
}) {
  const { data: allTools = [], isLoading } = useCatalogTools(catalog.id);
  const allCredentials = useMcpServersGroupedByCatalog({
    catalogId: catalog.id,
  });
  const mcpServers = allCredentials?.[catalog.id] ?? [];
  const { data: assignedToolsData } = useAllProfileTools({
    filters: { agentId },
    skipPagination: true,
    enabled: !!agentId,
  });
  const assignTool = useAssignTool();
  const unassignTool = useUnassignTool();
  const invalidateAllQueries = useInvalidateToolAssignmentQueries();

  const assignedToolIds = useMemo(() => {
    const ids = new Set<string>();
    for (const at of assignedToolsData?.data ?? []) {
      if (at.tool.catalogId === catalog.id) {
        ids.add(at.tool.id);
      }
    }
    return ids;
  }, [assignedToolsData, catalog.id]);

  const initializedRef = useRef(false);
  const [selectedToolIds, setSelectedToolIds] = useState<Set<string>>(
    new Set(),
  );
  const [credential, setCredential] = useState<string | null>(
    mcpServers[0]?.id ?? null,
  );
  const [toolSearch, setToolSearch] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (initializedRef.current || allTools.length === 0) return;
    initializedRef.current = true;
    if (assignedToolIds.size > 0) {
      setSelectedToolIds(new Set(assignedToolIds));
    } else {
      setSelectedToolIds(new Set(allTools.map((t) => t.id)));
    }
  }, [allTools, assignedToolIds]);

  useEffect(() => {
    if (!credential && mcpServers.length > 0) {
      setCredential(mcpServers[0].id);
    }
  }, [credential, mcpServers]);

  const isBuiltin = catalog.serverType === "builtin";
  const showCredentialSelector = !isBuiltin && mcpServers.length > 0;

  const selectedCount = allTools.filter((t) =>
    selectedToolIds.has(t.id),
  ).length;
  const totalCount = allTools.length;

  const tq = toolSearch.toLowerCase().trim();
  const filteredTools = tq
    ? allTools.filter(
        (t) =>
          t.name.toLowerCase().includes(tq) ||
          t.description?.toLowerCase().includes(tq),
      )
    : allTools;

  const toggleTool = (toolId: string) => {
    const newSet = new Set(selectedToolIds);
    if (newSet.has(toolId)) {
      newSet.delete(toolId);
    } else {
      newSet.add(toolId);
    }
    setSelectedToolIds(newSet);
  };

  const selectAll = () => {
    const newSet = new Set(selectedToolIds);
    for (const t of filteredTools) newSet.add(t.id);
    setSelectedToolIds(newSet);
  };

  const deselectAll = () => {
    const newSet = new Set(selectedToolIds);
    for (const t of filteredTools) newSet.delete(t.id);
    setSelectedToolIds(newSet);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const isLocal = catalog.serverType === "local";
      const toAdd = [...selectedToolIds].filter(
        (id) => !assignedToolIds.has(id),
      );
      const toRemove = [...assignedToolIds].filter(
        (id) => !selectedToolIds.has(id),
      );

      await Promise.all([
        ...toAdd.map((toolId) =>
          assignTool.mutateAsync({
            agentId,
            toolId,
            credentialSourceMcpServerId:
              !isLocal && !isBuiltin ? (credential ?? undefined) : undefined,
            executionSourceMcpServerId: isLocal
              ? (credential ?? undefined)
              : undefined,
            skipInvalidation: true,
          }),
        ),
        ...toRemove.map((toolId) =>
          unassignTool.mutateAsync({
            agentId,
            toolId,
            skipInvalidation: true,
          }),
        ),
      ]);
      if (toAdd.length > 0 || toRemove.length > 0) {
        invalidateAllQueries(agentId);
      }
      onDone();
    } finally {
      setIsSaving(false);
    }
  };

  const hasChanges = useMemo(() => {
    if (selectedToolIds.size !== assignedToolIds.size) return true;
    for (const id of selectedToolIds) {
      if (!assignedToolIds.has(id)) return true;
    }
    return false;
  }, [selectedToolIds, assignedToolIds]);

  const isEditing = assignedToolIds.size > 0;
  const newToolCount = useMemo(() => {
    return [...selectedToolIds].filter((id) => !assignedToolIds.has(id)).length;
  }, [selectedToolIds, assignedToolIds]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: prevents dropdown from closing when interacting with tool detail
    <div
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {/* Back + title */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b">
        <button
          type="button"
          onClick={onBack}
          className="p-1 rounded hover:bg-accent text-muted-foreground"
        >
          <ChevronDown className="size-3.5 rotate-90" />
        </button>
        <McpCatalogIcon icon={catalog.icon} catalogId={catalog.id} size={16} />
        <span className="text-sm font-medium truncate">{catalog.name}</span>
      </div>

      {/* Credential selector */}
      {showCredentialSelector && (
        <div className="px-3 py-1.5 border-b">
          <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            Connect on behalf of
          </div>
          <TokenSelect
            catalogId={catalog.id}
            value={credential}
            onValueChange={setCredential}
            shouldSetDefaultValue={false}
          />
        </div>
      )}

      {/* Select count + select/deselect all */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[11px] text-muted-foreground">
          {selectedCount} of {totalCount} selected
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={selectAll}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            Select All
          </button>
          <button
            type="button"
            onClick={deselectAll}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            Deselect All
          </button>
        </div>
      </div>

      {/* Search tools */}
      {totalCount > 5 && (
        <div className="px-2 pb-1">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none" />
            <Input
              value={toolSearch}
              onChange={(e) => setToolSearch(e.target.value)}
              placeholder="Search tools..."
              className="h-7 pl-7 text-xs"
            />
          </div>
        </div>
      )}

      <DropdownMenuSeparator />

      {/* Tool list */}
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Loading...
        </div>
      ) : (
        <div className="max-h-[220px] overflow-y-auto">
          {filteredTools.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              No tools found
            </div>
          ) : (
            filteredTools.map((tool) => {
              const checked = selectedToolIds.has(tool.id);
              return (
                <DropdownMenuCheckboxItem
                  key={tool.id}
                  checked={checked}
                  onCheckedChange={() => toggleTool(tool.id)}
                  onSelect={(e) => e.preventDefault()}
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium">{tool.name}</span>
                    {tool.description && (
                      <span className="text-[11px] text-muted-foreground leading-tight line-clamp-1">
                        {tool.description}
                      </span>
                    )}
                  </div>
                </DropdownMenuCheckboxItem>
              );
            })
          )}
        </div>
      )}

      {/* Save button */}
      <div className="p-2 border-t">
        <Button
          size="sm"
          className="w-full"
          onClick={handleSave}
          disabled={
            (!hasChanges && isEditing) ||
            (!isEditing && newToolCount === 0) ||
            isSaving
          }
        >
          {isSaving ? <Loader2 className="size-3 animate-spin mr-1" /> : null}
          {isEditing
            ? `Save (${selectedCount} tool${selectedCount !== 1 ? "s" : ""})`
            : newToolCount === 0
              ? "Add"
              : `Add ${newToolCount} tool${newToolCount !== 1 ? "s" : ""}`}
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Subagents SubMenu
// ============================================================================

function SubagentsSubMenu({ agentId }: { agentId: string }) {
  const { data: allAgents = [] } = useInternalAgents();
  const { data: session } = authClient.useSession();
  const { data: delegations = [] } = useAgentDelegations(agentId);
  const syncDelegations = useSyncAgentDelegations();
  const [q, setQ] = useState("");
  const [scopeFilters, setScopeFilters] = useState({
    my: true,
    shared: true,
    others: false,
  });
  const userId = session?.user?.id;

  const delegatedIds = useMemo(
    () => new Set(delegations.map((d) => d.id)),
    [delegations],
  );

  const query = q.toLowerCase().trim();
  const attachedAgents = useMemo(
    () => allAgents.filter((a) => delegatedIds.has(a.id)),
    [allAgents, delegatedIds],
  );

  const filterByScope = (agents: typeof allAgents) => {
    return agents.filter((a) => {
      const scope = (a as unknown as Record<string, unknown>).scope as string;
      const authorId = (a as unknown as Record<string, unknown>)
        .authorId as string;
      const isMyScope = scope === "personal" && authorId === userId;
      const isShared = scope === "team" || scope === "org";
      const isOthers = scope === "personal" && authorId !== userId;
      const matchScope =
        (scopeFilters.my && isMyScope) ||
        (scopeFilters.shared && isShared) ||
        (scopeFilters.others && isOthers);
      const matchSearch = !query || a.name.toLowerCase().includes(query);
      return matchScope && matchSearch;
    });
  };

  const availableAgents = useMemo(
    () => allAgents.filter((a) => !delegatedIds.has(a.id) && a.id !== agentId),
    [allAgents, delegatedIds, agentId],
  );

  const filteredAttached = filterByScope(attachedAgents);
  const filteredAvailable = filterByScope(availableAgents);

  const toggleScope = (key: keyof typeof scopeFilters) => {
    setScopeFilters((p) => ({ ...p, [key]: !p[key] }));
  };

  const scopeTabs = [
    { key: "my" as const, label: "My" },
    { key: "shared" as const, label: "Shared" },
    { key: "others" as const, label: "Others" },
  ];

  const handleToggle = (targetAgentId: string) => {
    const newIds = new Set(delegatedIds);
    if (newIds.has(targetAgentId)) {
      newIds.delete(targetAgentId);
    } else {
      newIds.add(targetAgentId);
    }
    syncDelegations.mutate({ agentId, targetAgentIds: [...newIds] });
  };

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Users className="size-4" />
        <span className="flex-1">Subagents</span>
        <span className="text-[10px] text-muted-foreground">
          {delegatedIds.size}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-56">
          {/* Scope filter toggles */}
          <div className="flex gap-1 px-2 py-1">
            {scopeTabs.map((s) => {
              const active = scopeFilters[s.key];
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleScope(s.key);
                  }}
                  className={cn(
                    "px-2.5 py-1 rounded-md text-[11px] font-medium transition-all border",
                    active
                      ? "bg-primary/10 text-primary border-primary/20"
                      : "text-muted-foreground border-border opacity-60",
                  )}
                >
                  {s.label}
                </button>
              );
            })}
          </div>

          {/* Search */}
          <div className="px-2 py-1">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Search agents..."
                className="h-7 pl-7 text-xs"
              />
            </div>
          </div>
          <DropdownMenuSeparator />

          <div className="max-h-[280px] overflow-y-auto">
            {filteredAttached.length > 0 && (
              <DropdownMenuGroup>
                <DropdownMenuLabel>Attached</DropdownMenuLabel>
                {filteredAttached.map((a) => (
                  <DropdownMenuItem
                    key={a.id}
                    onSelect={(e) => e.preventDefault()}
                    onClick={() => handleToggle(a.id)}
                  >
                    <AgentIcon
                      icon={
                        (a as unknown as Record<string, unknown>).icon as
                          | string
                          | null
                      }
                      size={14}
                    />
                    <span className="flex-1 truncate">{a.name}</span>
                    <AgentBadge
                      type={
                        (a as unknown as Record<string, unknown>).scope as
                          | "personal"
                          | "team"
                          | "org"
                      }
                      className="text-[10px] px-1.5 py-0"
                    />
                    <Check className="size-3.5 text-primary" />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            )}

            {filteredAvailable.length > 0 && (
              <DropdownMenuGroup>
                {filteredAttached.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel>Available</DropdownMenuLabel>
                {filteredAvailable.map((a) => (
                  <DropdownMenuItem
                    key={a.id}
                    onSelect={(e) => e.preventDefault()}
                    onClick={() => handleToggle(a.id)}
                  >
                    <AgentIcon
                      icon={
                        (a as unknown as Record<string, unknown>).icon as
                          | string
                          | null
                      }
                      size={14}
                    />
                    <span className="flex-1 truncate">{a.name}</span>
                    <AgentBadge
                      type={
                        (a as unknown as Record<string, unknown>).scope as
                          | "personal"
                          | "team"
                          | "org"
                      }
                      className="text-[10px] px-1.5 py-0"
                    />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            )}

            {filteredAttached.length === 0 &&
              filteredAvailable.length === 0 && (
                <div className="py-4 text-center text-xs text-muted-foreground">
                  No agents found
                </div>
              )}
          </div>

          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <a
              href="/agents?create=true"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Plus className="size-3.5" />
              New Agent
            </a>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

// ============================================================================
// Knowledge Sources SubMenu
// ============================================================================

function KnowledgeSubMenu({
  knowledgeBases,
  connectors,
}: {
  knowledgeBases: archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"];
  connectors: archestraApiTypes.GetConnectorsResponses["200"]["data"];
}) {
  const hasAny = knowledgeBases.length > 0 || connectors.length > 0;

  if (!hasAny) return null;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <BookOpen className="size-4" />
        Knowledge Sources
        <span className="ml-auto text-[10px] text-muted-foreground">
          {knowledgeBases.length + connectors.length}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-56">
          <DropdownMenuLabel>Attached Sources</DropdownMenuLabel>
          {knowledgeBases.map((kb) => {
            const connectorTypes = [
              ...new Set((kb.connectors ?? []).map((c) => c.connectorType)),
            ];
            return (
              <DropdownMenuItem key={kb.id} className="cursor-default">
                {connectorTypes.length > 0 ? (
                  <ConnectorTypeIcon
                    type={connectorTypes[0]}
                    className="size-3.5"
                  />
                ) : (
                  <BookOpen className="size-3.5" />
                )}
                <span className="flex-1 truncate">{kb.name}</span>
                {connectorTypes.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    {connectorTypes[0]}
                  </span>
                )}
              </DropdownMenuItem>
            );
          })}
          {connectors.map((connector) => (
            <DropdownMenuItem key={connector.id} className="cursor-default">
              <ConnectorTypeIcon
                type={connector.connectorType}
                className="size-3.5"
              />
              <span className="flex-1 truncate">{connector.name}</span>
              <span className="text-[10px] text-muted-foreground">
                {connector.connectorType}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

// ============================================================================
// Avatar Components
// ============================================================================

const MAX_VISIBLE_AVATARS = 3;

type SubagentItem = {
  id: string;
  name: string;
  icon?: string | null;
};

function ToolServerAvatarGroup({
  catalogs,
  subagents = [],
  connectorTypes = [],
  showAddButton = false,
}: {
  catalogs: CatalogItem[];
  subagents?: SubagentItem[];
  connectorTypes?: string[];
  showAddButton?: boolean;
}) {
  const hasNonBuiltInTools =
    subagents.length > 0 || catalogs.some((c) => !isBuiltInCatalogId(c.id));
  const totalCount = catalogs.length + subagents.length + connectorTypes.length;

  if (totalCount === 0) {
    if (!showAddButton) return null;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted ml-1">
            <Plus className="size-3 text-muted-foreground" />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">Add tools</TooltipContent>
      </Tooltip>
    );
  }

  const icons = [
    ...subagents.map((a) => ({
      key: a.id,
      icon: <AgentIcon icon={a.icon as string | null} size={12} />,
      tooltip: a.name,
    })),
    ...catalogs.map((c) => ({
      key: c.id,
      icon: <McpCatalogIcon icon={c.icon} catalogId={c.id} size={12} />,
      tooltip: c.name,
    })),
    ...connectorTypes.map((type) => ({
      key: `connector-${type}`,
      icon: <ConnectorTypeIcon type={type} className="h-3 w-3" />,
      tooltip: type,
    })),
  ];

  const hiddenItems = icons.slice(MAX_VISIBLE_AVATARS);
  const overflowTooltip =
    hiddenItems.length <= 5
      ? hiddenItems.map((i) => i.tooltip).join(", ")
      : `${hiddenItems
          .slice(0, 5)
          .map((i) => i.tooltip)
          .join(", ")} and ${hiddenItems.length - 5} more`;

  return (
    <div className="flex items-center ml-1">
      <OverlappedIcons
        icons={icons}
        maxVisible={MAX_VISIBLE_AVATARS}
        overflowTooltip={overflowTooltip}
      />
      {showAddButton && !hasNonBuiltInTools && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted ring-1 ring-background ml-0.5">
              <Plus className="size-3 text-muted-foreground" />
            </div>
          </TooltipTrigger>
          <TooltipContent side="top">Add tools</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
