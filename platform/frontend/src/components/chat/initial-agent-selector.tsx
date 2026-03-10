"use client";

import { type archestraApiTypes, isBuiltInCatalogId } from "@shared";
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ExternalLink,
  Info,
  Loader2,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { LocalServerInstallDialog } from "@/app/mcp/registry/_parts/local-server-install-dialog";
import { NoAuthInstallDialog } from "@/app/mcp/registry/_parts/no-auth-install-dialog";
import { RemoteServerInstallDialog } from "@/app/mcp/registry/_parts/remote-server-install-dialog";
import { AgentBadge } from "@/components/agent-badge";
import { AgentIcon } from "@/components/agent-icon";
import { McpCatalogIcon, ToolChecklist } from "@/components/agent-tools-editor";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { OAuthConfirmationDialog } from "@/components/oauth-confirmation-dialog";
import { TokenSelect } from "@/components/token-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OverlappedIcons } from "@/components/ui/overlapped-icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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

type ScopeFilter = "my" | "others" | "team" | "org";
type PopoverView =
  | "list"
  | "settings"
  | "add-tool"
  | "configure-tool"
  | "add-delegation";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

interface InitialAgentSelectorProps {
  currentAgentId: string | null;
  onAgentChange: (agentId: string) => void;
}

function toggleSetValue<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

// ============================================================================
// Main Component
// ============================================================================

export function InitialAgentSelector({
  currentAgentId,
  onAgentChange,
}: InitialAgentSelectorProps) {
  const { data: allAgents = [] } = useInternalAgents();
  const { data: session } = authClient.useSession();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PopoverView>("list");
  const [search, setSearch] = useState("");
  const [scopeFilters, setScopeFilters] = useState<Set<ScopeFilter>>(
    () => new Set<ScopeFilter>(["my", "team", "org"]),
  );
  const [selectedCatalog, setSelectedCatalog] = useState<CatalogItem | null>(
    null,
  );

  const installer = useMcpInstallOrchestrator();
  const userId = session?.user?.id;

  const currentAgent = useMemo(
    () =>
      allAgents.find((a) => a.id === currentAgentId) ?? allAgents[0] ?? null,
    [allAgents, currentAgentId],
  );

  const effectiveAgentId = currentAgent?.id ?? currentAgentId;
  const { data: catalogItems = [] } = useInternalMcpCatalog();
  const { data: assignedToolsData } = useAllProfileTools({
    filters: { agentId: effectiveAgentId ?? undefined },
    skipPagination: true,
    enabled: !!effectiveAgentId,
  });

  const assignedCatalogs = useMemo(() => {
    const catalogIds = new Set<string>();
    for (const at of assignedToolsData?.data ?? []) {
      if (at.tool.catalogId) catalogIds.add(at.tool.catalogId);
    }
    return catalogItems.filter((c) => catalogIds.has(c.id));
  }, [assignedToolsData, catalogItems]);

  const { data: triggerDelegations = [] } = useAgentDelegations(
    effectiveAgentId ?? undefined,
  );
  const triggerSubagents = useMemo(() => {
    const targetIds = new Set(triggerDelegations.map((d) => d.id));
    return allAgents.filter((a) => targetIds.has(a.id));
  }, [allAgents, triggerDelegations]);

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

  const filteredAgents = useMemo(() => {
    let result = allAgents.filter((a) => {
      const scope = (a as unknown as Record<string, unknown>).scope as string;
      const authorId = (a as unknown as Record<string, unknown>)
        .authorId as string;
      if (scope === "personal") {
        if (authorId === userId) return scopeFilters.has("my");
        return scopeFilters.has("others");
      }
      return scopeFilters.has(scope as ScopeFilter);
    });

    if (search) {
      const lower = search.toLowerCase();
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(lower) ||
          a.description?.toLowerCase().includes(lower),
      );
    }

    const scopeOrder: Record<string, number> = {
      personal: 0,
      team: 1,
      org: 2,
    };
    return [...result].sort((a, b) => {
      const sa = (a as unknown as Record<string, unknown>).scope as string;
      const sb = (b as unknown as Record<string, unknown>).scope as string;
      return (scopeOrder[sa] ?? 3) - (scopeOrder[sb] ?? 3);
    });
  }, [allAgents, search, scopeFilters, userId]);

  const handleAgentSelect = (agentId: string) => {
    onAgentChange(agentId);
    setOpen(false);
  };

  const handleEditAgent = (agentId: string) => {
    onAgentChange(agentId);
    setView("settings");
    setSearch("");
    setScopeFilters(new Set(["my", "team", "org"]));
  };

  const resetToList = useCallback(() => {
    setView("list");
    setSearch("");
    setScopeFilters(new Set(["my", "team", "org"]));
    setSelectedCatalog(null);
  }, []);

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) resetToList();
  };

  const handleSelectCatalog = (catalog: CatalogItem) => {
    setSelectedCatalog(catalog);
    setView("configure-tool");
  };

  const hasOpenDialogs =
    installer.isDialogOpened("remote-install") ||
    installer.isDialogOpened("oauth") ||
    installer.isDialogOpened("no-auth") ||
    installer.isDialogOpened("local-install");

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <PromptInputButton
            role="combobox"
            aria-expanded={open}
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
            <ChevronDown className="size-3 text-muted-foreground shrink-0 ml-0.5" />
          </PromptInputButton>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[420px] p-0 overflow-hidden"
          onInteractOutside={(e) => {
            if (hasOpenDialogs) e.preventDefault();
          }}
          onFocusOutside={(e) => {
            if (hasOpenDialogs) e.preventDefault();
          }}
        >
          {view === "list" && (
            <AgentListView
              agents={filteredAgents}
              currentAgentId={currentAgentId}
              scopeFilters={scopeFilters}
              search={search}
              onScopeFiltersChange={setScopeFilters}
              onSearchChange={setSearch}
              onSelect={handleAgentSelect}
              onEdit={handleEditAgent}
            />
          )}

          {view === "settings" && (
            <AgentSettingsView
              agent={currentAgent}
              onBack={resetToList}
              onAddTool={() => setView("add-tool")}
              onEditTool={handleSelectCatalog}
            />
          )}

          {view === "add-tool" && currentAgent && (
            <AddToolView
              agentId={currentAgent.id}
              onBack={() => setView("settings")}
              onSelectCatalog={handleSelectCatalog}
              onAddDelegation={() => setView("add-delegation")}
              installer={installer}
            />
          )}

          {view === "add-delegation" && currentAgent && (
            <AddDelegationView
              agentId={currentAgent.id}
              onBack={() => setView("add-tool")}
              onDone={() => setView("settings")}
            />
          )}

          {view === "configure-tool" && currentAgent && selectedCatalog && (
            <ConfigureToolView
              agentId={currentAgent.id}
              catalog={selectedCatalog}
              onBack={() => setView("add-tool")}
              onDone={() => setView("settings")}
            />
          )}
        </PopoverContent>
      </Popover>

      {/* Install dialogs rendered outside popover */}
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
        onOpenChange={(isOpen) => {
          if (!isOpen) installer.closeOAuth();
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
// Agent List View (popover main view)
// ============================================================================

const SCOPE_OPTIONS: { value: ScopeFilter; label: string }[] = [
  { value: "my", label: "My Personal" },
  { value: "team", label: "Team" },
  { value: "org", label: "Organization" },
  { value: "others", label: "Others' Personal" },
];

function AgentListView({
  agents,
  currentAgentId,
  scopeFilters,
  search,
  onScopeFiltersChange,
  onSearchChange,
  onSelect,
  onEdit,
}: {
  agents: Array<{ id: string; name: string; description?: string | null }>;
  currentAgentId: string | null;
  scopeFilters: Set<ScopeFilter>;
  search: string;
  onScopeFiltersChange: (filters: Set<ScopeFilter>) => void;
  onSearchChange: (search: string) => void;
  onSelect: (agentId: string) => void;
  onEdit: (agentId: string) => void;
}) {
  return (
    <div className="flex flex-col">
      {/* Scope filters + Search */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <div className="flex gap-0.5 flex-wrap">
          {SCOPE_OPTIONS.map((option) => (
            <Button
              key={option.value}
              variant={scopeFilters.has(option.value) ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => {
                onScopeFiltersChange(
                  toggleSetValue(scopeFilters, option.value),
                );
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <div className="flex-1" />
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search..."
            className="h-7 w-[100px] pl-7 text-xs focus:w-[140px] transition-all duration-200"
          />
        </div>
      </div>

      <div className="mx-3 border-t" />

      {/* Agent list */}
      <div className="max-h-[280px] overflow-y-auto px-1.5 py-1">
        {agents.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">
            No agents found
          </p>
        ) : (
          agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              isSelected={agent.id === currentAgentId}
              onSelect={() => onSelect(agent.id)}
              onEdit={() => onEdit(agent.id)}
            />
          ))
        )}
      </div>

      <div className="mx-3 border-t" />

      {/* Create Agent */}
      <div className="px-1.5 py-1">
        <a
          href="/agents?create=true"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-2.5 py-2 rounded-md text-xs text-muted-foreground hover:bg-accent transition-colors"
        >
          <Plus className="size-3.5" />
          Create Agent
        </a>
      </div>
    </div>
  );
}

// ============================================================================
// Agent Row
// ============================================================================

function AgentRow({
  agent,
  isSelected,
  onSelect,
  onEdit,
}: {
  agent: { id: string; name: string; description?: string | null };
  isSelected: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex w-full items-center gap-2.5 px-2.5 py-2 rounded-md cursor-pointer transition-colors mb-0.5 text-left",
        isSelected
          ? "bg-accent border border-border"
          : "hover:bg-accent/50 border border-transparent",
      )}
    >
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md",
          isSelected ? "bg-primary/10" : "bg-muted",
        )}
      >
        <AgentIcon
          icon={
            (agent as unknown as Record<string, unknown>).icon as string | null
          }
          size={14}
        />
      </div>
      <span className="text-sm font-medium truncate flex-1">{agent.name}</span>
      {isSelected && <Check className="size-3.5 text-primary shrink-0" />}
      <span
        role="none"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            onEdit();
          }
        }}
        className="size-6 flex items-center justify-center rounded-md opacity-0 group-hover:opacity-100 hover:bg-muted transition-all shrink-0"
      >
        <Settings className="size-3 text-muted-foreground" />
      </span>
    </button>
  );
}

// ============================================================================
// Popover Header (reusable)
// ============================================================================

function PopoverHeader({
  title,
  onBack,
  icon,
  extra,
}: {
  title: string;
  onBack: () => void;
  icon?: React.ReactNode;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 border-b px-3 py-2.5 shrink-0">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={onBack}
      >
        <ArrowLeft className="size-4" />
      </Button>
      {icon}
      <span className="text-sm font-semibold truncate flex-1">{title}</span>
      {extra}
    </div>
  );
}

// ============================================================================
// Agent Settings View
// ============================================================================

function AgentSettingsView({
  agent,
  onBack,
  onAddTool,
  onEditTool,
}: {
  agent: {
    id: string;
    name: string;
    description?: string | null;
    systemPrompt?: string | null;
    icon?: string | null;
    scope?: string;
  } | null;
  onBack: () => void;
  onAddTool: () => void;
  onEditTool: (catalog: CatalogItem) => void;
}) {
  const updateProfile = useUpdateProfile();
  const { data: canReadAgents } = useHasPermissions({ agent: ["read"] });

  const [instructions, setInstructions] = useState(agent?.systemPrompt ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scope = (agent as unknown as Record<string, unknown>)?.scope as string;

  // biome-ignore lint/correctness/useExhaustiveDependencies: agent?.id ensures reset when switching agents
  useEffect(() => {
    setInstructions(agent?.systemPrompt ?? "");
  }, [agent?.id, agent?.systemPrompt]);

  const saveInstructions = useCallback(
    (value: string) => {
      if (!agent) return;
      setIsSaving(true);
      updateProfile.mutateAsync(
        {
          id: agent.id,
          data: { systemPrompt: value.trim() || null },
        },
        { onSettled: () => setIsSaving(false) },
      );
    },
    [agent, updateProfile],
  );

  const handleInstructionsChange = useCallback(
    (value: string) => {
      setInstructions(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => saveInstructions(value), 400);
    },
    [saveInstructions],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  if (!agent) {
    return (
      <div className="p-4 text-center text-muted-foreground text-sm">
        No agent selected
      </div>
    );
  }

  return (
    <div className="flex flex-col max-h-[450px]">
      <PopoverHeader
        title={agent.name}
        onBack={onBack}
        icon={
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
            <AgentIcon icon={agent.icon as string | null} size={14} />
          </div>
        }
        extra={
          <div className="flex items-center gap-1.5">
            {isSaving && (
              <Loader2 className="size-3 animate-spin text-muted-foreground" />
            )}
            <AgentBadge
              type={scope as "personal" | "team" | "org"}
              className="text-[10px] px-1.5 py-0"
            />
          </div>
        }
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {(scope === "org" || scope === "team") && (
          <Alert variant="info" className="mx-3 mt-3 border-0 py-1.5 text-xs">
            <Info className="size-3" />
            <AlertDescription className="text-[11px]">
              You are editing a shared agent
            </AlertDescription>
          </Alert>
        )}

        {/* Instructions */}
        <div className="px-3 pt-3 pb-2">
          <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 block">
            Instructions
          </Label>
          <Textarea
            value={instructions}
            onChange={(e) => handleInstructionsChange(e.target.value)}
            className="resize-none text-sm min-h-[70px] max-h-[140px]"
            placeholder="Tell the agent what to do..."
          />
        </div>

        <div className="mx-3 border-t" />

        {/* Tools & MCP Servers */}
        <div className="px-3 py-3">
          <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 block">
            Tools & MCP Servers
          </Label>
          <AssignedToolsBadges
            agentId={agent.id}
            onAddTool={onAddTool}
            onEditTool={onEditTool}
          />
        </div>
      </div>

      {canReadAgents && (
        <div className="border-t px-3 py-2.5 shrink-0">
          <a
            href={`/agents?edit=${agent.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
          >
            Full configuration <ExternalLink className="size-3" />
          </a>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Assigned Tools Badges (inline badges for settings view)
// ============================================================================

function AssignedToolsBadges({
  agentId,
  onAddTool,
  onEditTool,
}: {
  agentId: string;
  onAddTool: () => void;
  onEditTool: (catalog: CatalogItem) => void;
}) {
  const { data: catalogItems = [] } = useInternalMcpCatalog();
  const { data: assignedToolsData } = useAllProfileTools({
    filters: { agentId },
    skipPagination: true,
    enabled: !!agentId,
  });
  const { data: allAgents = [] } = useInternalAgents();
  const { data: delegations = [] } = useAgentDelegations(agentId);

  const delegatedAgents = useMemo(() => {
    const targetIds = new Set(delegations.map((d) => d.id));
    return allAgents.filter((a) => targetIds.has(a.id));
  }, [allAgents, delegations]);

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

  return (
    <div className="flex flex-wrap gap-1.5">
      {delegatedAgents.map((agent) => (
        <span
          key={`delegation-${agent.id}`}
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted border text-xs"
        >
          <AgentIcon
            icon={
              (agent as unknown as Record<string, unknown>).icon as
                | string
                | null
            }
            size={14}
          />
          <span className="truncate max-w-[100px]">{agent.name}</span>
        </span>
      ))}
      {assignedCatalogs.map((catalog) => {
        const info = assignedByCatalog.get(catalog.id);
        return (
          <button
            key={catalog.id}
            type="button"
            onClick={() => onEditTool(catalog)}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted border text-xs hover:bg-accent transition-colors cursor-pointer"
          >
            <McpCatalogIcon
              icon={catalog.icon}
              catalogId={catalog.id}
              size={14}
            />
            <span className="truncate max-w-[80px]">{catalog.name}</span>
            <span className="text-muted-foreground text-[10px]">
              {info?.count ?? 0}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={onAddTool}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-dashed text-xs text-muted-foreground hover:bg-accent transition-colors cursor-pointer"
      >
        <Plus className="size-3" /> Add
      </button>
    </div>
  );
}

// ============================================================================
// Add Tool View
// ============================================================================

function AddToolView({
  agentId,
  onBack,
  onSelectCatalog,
  onAddDelegation,
  installer,
}: {
  agentId: string;
  onBack: () => void;
  onSelectCatalog: (catalog: CatalogItem) => void;
  onAddDelegation: () => void;
  installer: ReturnType<typeof useMcpInstallOrchestrator>;
}) {
  const { data: catalogItems = [], isPending } = useInternalMcpCatalog();
  const allCredentials = useMcpServersGroupedByCatalog();
  const [search, setSearch] = useState("");

  const { data: assignedToolsData } = useAllProfileTools({
    filters: { agentId },
    skipPagination: true,
    enabled: !!agentId,
  });

  const assignedCatalogIds = useMemo(() => {
    const ids = new Set<string>();
    for (const at of assignedToolsData?.data ?? []) {
      if (at.tool.catalogId) ids.add(at.tool.catalogId);
    }
    return ids;
  }, [assignedToolsData]);

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

  const filteredCatalogs = useMemo(() => {
    let items = catalogItems;
    if (search) {
      const lower = search.toLowerCase();
      items = items.filter(
        (c) =>
          c.name.toLowerCase().includes(lower) ||
          c.description?.toLowerCase().includes(lower),
      );
    }
    return [...items].sort((a, b) => {
      const aAssigned = assignedCatalogIds.has(a.id) ? 1 : 0;
      const bAssigned = assignedCatalogIds.has(b.id) ? 1 : 0;
      return aAssigned - bAssigned;
    });
  }, [catalogItems, search, assignedCatalogIds]);

  return (
    <div className="flex flex-col max-h-[450px]">
      <PopoverHeader title="Add Tools" onBack={onBack} />

      <div className="px-3 pt-3 pb-2 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search MCP servers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-xs"
            autoFocus
          />
        </div>
      </div>

      <div className="px-3 pb-3 flex-1 min-h-0 overflow-y-auto">
        {isPending ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading...
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {!search && (
              <button
                type="button"
                onClick={onAddDelegation}
                className="flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-colors cursor-pointer hover:bg-accent"
              >
                <Bot className="size-6 text-muted-foreground" />
                <span className="text-xs font-medium">Call an Agent</span>
                <p className="text-[10px] text-muted-foreground line-clamp-2">
                  Delegate tasks to another agent
                </p>
              </button>
            )}
            {filteredCatalogs.map((catalog) => {
              const servers = allCredentials?.[catalog.id] ?? [];
              const hasCredentials =
                catalog.serverType === "builtin" || servers.length > 0;
              const isServerInstalling = servers.some(
                (s) =>
                  s.localInstallationStatus === "pending" ||
                  s.localInstallationStatus === "discovering-tools",
              );
              const isReady = hasCredentials && !isServerInstalling;
              const isAssigned = assignedCatalogIds.has(catalog.id);
              return (
                <button
                  key={catalog.id}
                  type="button"
                  disabled={isAssigned || isServerInstalling}
                  onClick={() =>
                    isAssigned
                      ? undefined
                      : isReady
                        ? onSelectCatalog(catalog)
                        : installer.triggerInstallByCatalogId(catalog.id)
                  }
                  className={cn(
                    "relative flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-colors",
                    isAssigned
                      ? "opacity-50 cursor-default"
                      : "cursor-pointer hover:bg-accent",
                    isServerInstalling && "opacity-60 cursor-wait",
                  )}
                >
                  {isAssigned && (
                    <div className="absolute top-2 right-2">
                      <Check className="size-3.5 text-primary" />
                    </div>
                  )}
                  <McpCatalogIcon
                    icon={catalog.icon}
                    catalogId={catalog.id}
                    size={24}
                  />
                  <span className="text-xs font-medium truncate w-full">
                    {catalog.name}
                  </span>
                  {catalog.description && (
                    <p className="text-[10px] text-muted-foreground line-clamp-2 w-full">
                      {catalog.description}
                    </p>
                  )}
                  {isServerInstalling && (
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      Installing...
                    </span>
                  )}
                  {!isAssigned && !hasCredentials && !isServerInstalling && (
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0"
                    >
                      Install
                    </Badge>
                  )}
                </button>
              );
            })}
            {!search && (
              <a
                href="/mcp/registry"
                target="_blank"
                rel="noopener noreferrer"
                className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed p-3 text-center transition-colors cursor-pointer hover:bg-accent text-muted-foreground"
              >
                <ExternalLink className="size-5" />
                <span className="text-xs font-medium">Add New Server</span>
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Configure Tool View
// ============================================================================

function ConfigureToolView({
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
    <div className="flex flex-col max-h-[450px]">
      <PopoverHeader title={catalog.name} onBack={onBack} />

      <div className="flex flex-col flex-1 min-h-0">
        {showCredentialSelector && (
          <div className="px-3 pt-3 pb-2 space-y-1 shrink-0">
            <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Connect on behalf of
            </Label>
            <TokenSelect
              catalogId={catalog.id}
              value={credential}
              onValueChange={setCredential}
              shouldSetDefaultValue={false}
            />
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading tools...
          </div>
        ) : allTools.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground text-center">
            No tools available.
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <ToolChecklist
              tools={allTools}
              selectedToolIds={selectedToolIds}
              onSelectionChange={setSelectedToolIds}
            />
          </div>
        )}

        <div className="p-3 border-t shrink-0">
          <Button
            className="w-full h-8 text-xs"
            onClick={handleSave}
            disabled={
              (!hasChanges && isEditing) ||
              (!isEditing && newToolCount === 0) ||
              isSaving
            }
          >
            {isSaving ? (
              <Loader2 className="size-3.5 animate-spin mr-1.5" />
            ) : null}
            {isEditing
              ? `Save (${selectedToolIds.size} tool${selectedToolIds.size !== 1 ? "s" : ""})`
              : newToolCount === 0
                ? "Add"
                : `Add ${newToolCount} tool${newToolCount !== 1 ? "s" : ""}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Add Delegation View
// ============================================================================

function AddDelegationView({
  agentId,
  onBack,
  onDone,
}: {
  agentId: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const { data: allAgents = [] } = useInternalAgents();
  const { data: session } = authClient.useSession();
  const { data: delegations = [] } = useAgentDelegations(agentId);
  const syncDelegations = useSyncAgentDelegations();
  const [scopeFilters, setScopeFilters] = useState<Set<ScopeFilter>>(
    () => new Set<ScopeFilter>(["my", "team", "org"]),
  );
  const [search, setSearch] = useState("");
  const currentUserId = session?.user?.id;

  const delegatedIds = useMemo(
    () => new Set(delegations.map((d) => d.id)),
    [delegations],
  );

  const filteredAgents = useMemo(() => {
    let result = allAgents.filter((a) => {
      if (a.id === agentId) return false;
      const scope = (a as unknown as Record<string, unknown>).scope as string;
      const authorId = (a as unknown as Record<string, unknown>)
        .authorId as string;
      if (scope === "personal") {
        if (authorId === currentUserId) return scopeFilters.has("my");
        return scopeFilters.has("others");
      }
      return scopeFilters.has(scope as ScopeFilter);
    });

    if (search) {
      const lower = search.toLowerCase();
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(lower) ||
          a.description?.toLowerCase().includes(lower),
      );
    }

    const scopeOrder: Record<string, number> = {
      personal: 0,
      team: 1,
      org: 2,
    };
    return [...result].sort((a, b) => {
      const sa = (a as unknown as Record<string, unknown>).scope as string;
      const sb = (b as unknown as Record<string, unknown>).scope as string;
      return (scopeOrder[sa] ?? 3) - (scopeOrder[sb] ?? 3);
    });
  }, [allAgents, agentId, search, scopeFilters, currentUserId]);

  const handleToggle = (targetAgentId: string) => {
    const isAdding = !delegatedIds.has(targetAgentId);
    const newIds = new Set(delegatedIds);
    if (isAdding) {
      newIds.add(targetAgentId);
    } else {
      newIds.delete(targetAgentId);
    }
    syncDelegations.mutate(
      { agentId, targetAgentIds: [...newIds] },
      {
        onSuccess: () => {
          if (isAdding) onDone();
        },
      },
    );
  };

  return (
    <div className="flex flex-col max-h-[450px]">
      <PopoverHeader title="Call an Agent" onBack={onBack} />

      {/* Scope filters + Search */}
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <div className="flex gap-0.5 flex-wrap">
          {SCOPE_OPTIONS.map((option) => (
            <Button
              key={option.value}
              variant={scopeFilters.has(option.value) ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() =>
                setScopeFilters(toggleSetValue(scopeFilters, option.value))
              }
            >
              {option.label}
            </Button>
          ))}
        </div>
        <div className="flex-1" />
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            className="h-7 w-[100px] pl-7 text-xs focus:w-[140px] transition-all duration-200"
            autoFocus
          />
        </div>
      </div>

      <div className="px-3 pb-2">
        <Alert variant="info" className="border-0 py-1.5 text-[11px]">
          <Info className="size-3" />
          <AlertDescription className="text-[11px]">
            Adding a subagent makes its tools available to all users of this
            agent
          </AlertDescription>
        </Alert>
      </div>

      <div className="px-3 pb-3 flex-1 min-h-0 overflow-y-auto">
        {filteredAgents.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">
            No agents found
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {filteredAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => handleToggle(agent.id)}
                className={cn(
                  "relative flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-colors cursor-pointer hover:bg-accent",
                  delegatedIds.has(agent.id) && "border-primary bg-accent",
                )}
              >
                {delegatedIds.has(agent.id) && (
                  <div className="absolute top-2 right-2">
                    <Check className="size-3.5 text-primary" />
                  </div>
                )}
                <AgentIcon
                  icon={
                    (agent as unknown as Record<string, unknown>).icon as
                      | string
                      | null
                  }
                  size={20}
                />
                <span className="text-xs font-medium truncate w-full">
                  {agent.name}
                </span>
                {agent.description && (
                  <p className="text-[10px] text-muted-foreground line-clamp-2 w-full">
                    {agent.description}
                  </p>
                )}
                <AgentBadge
                  type={
                    (agent as unknown as Record<string, unknown>).scope as
                      | "personal"
                      | "team"
                      | "org"
                  }
                  className="text-[10px] px-1.5 py-0"
                />
              </button>
            ))}
            <a
              href="/agents?create=true"
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed p-3 text-center transition-colors cursor-pointer hover:bg-accent text-muted-foreground"
            >
              <ExternalLink className="size-4" />
              <span className="text-xs font-medium">Create Agent</span>
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Helper Components
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
