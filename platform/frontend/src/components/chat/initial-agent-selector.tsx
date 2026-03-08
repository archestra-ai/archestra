"use client";

import type { archestraApiTypes } from "@shared";
import {
  ArrowLeft,
  Bot,
  Check,
  ExternalLink,
  Info,
  Loader2,
  Plus,
  Search,
  User,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentBadge } from "@/components/agent-badge";
import { AgentIcon } from "@/components/agent-icon";
import { McpCatalogIcon, ToolChecklist } from "@/components/agent-tools-editor";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { TokenSelect } from "@/components/token-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  useRemoveAgentDelegation,
  useSyncAgentDelegations,
  useUnassignTool,
} from "@/lib/agent-tools.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  useCatalogTools,
  useInternalMcpCatalog,
} from "@/lib/internal-mcp-catalog.query";
import { useMcpServersGroupedByCatalog } from "@/lib/mcp-server.query";
import { cn } from "@/lib/utils";

type ScopeFilter = "my" | "others" | "team" | "org";
type DialogView =
  | "settings"
  | "change"
  | "add-tool"
  | "configure-tool"
  | "add-delegation";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

interface InitialAgentSelectorProps {
  currentAgentId: string | null;
  onAgentChange: (agentId: string) => void;
}

export function InitialAgentSelector({
  currentAgentId,
  onAgentChange,
}: InitialAgentSelectorProps) {
  const { data: allAgents = [] } = useInternalAgents();
  const { data: session } = authClient.useSession();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<DialogView>("settings");
  const [search, setSearch] = useState("");
  const [scopeFilters, setScopeFilters] = useState<Set<ScopeFilter>>(
    () => new Set<ScopeFilter>(["my", "team", "org"]),
  );
  const [selectedCatalog, setSelectedCatalog] = useState<CatalogItem | null>(
    null,
  );

  const userId = session?.user?.id;

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
    const scopeOrder: Record<string, number> = { personal: 0, team: 1, org: 2 };
    return [...result].sort((a, b) => {
      const sa = (a as unknown as Record<string, unknown>).scope as string;
      const sb = (b as unknown as Record<string, unknown>).scope as string;
      return (scopeOrder[sa] ?? 3) - (scopeOrder[sb] ?? 3);
    });
  }, [allAgents, search, scopeFilters, userId]);

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

  const handleAgentSelect = (agentId: string) => {
    onAgentChange(agentId);
    setView("settings");
    setSearch("");
    setScopeFilters(new Set(["my", "team", "org"]));
  };

  const resetToSettings = useCallback(() => {
    setView("settings");
    setSearch("");
    setScopeFilters(new Set(["my", "team", "org"]));
    setSelectedCatalog(null);
  }, []);

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) resetToSettings();
  };

  const handleSelectCatalog = (catalog: CatalogItem) => {
    setSelectedCatalog(catalog);
    setView("configure-tool");
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
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
          />
        </PromptInputButton>
      </DialogTrigger>
      <DialogContent
        className="max-w-3xl h-[600px] p-0 gap-0 overflow-hidden flex flex-col"
        onCloseAutoFocus={(e) => e.preventDefault()}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          {view === "settings" && "Agent Settings"}
          {view === "change" && "Select Agent"}
          {view === "add-tool" && "Add Tools"}
          {view === "configure-tool" && "Configure Tools"}
          {view === "add-delegation" && "Call an Agent"}
        </DialogTitle>

        {view === "settings" && (
          <AgentSettingsView
            agent={currentAgent}
            onChangeAgent={() => setView("change")}
            onAddTool={() => setView("add-tool")}
            onEditTool={handleSelectCatalog}
          />
        )}

        {view === "change" && (
          <div className="flex flex-col h-full">
            <DialogHeader
              title="Select Agent"
              onBack={resetToSettings}
              extra={
                <div className="flex items-center gap-1">
                  {(
                    [
                      { value: "my", label: "My Personal" },
                      { value: "team", label: "Team" },
                      { value: "org", label: "Organization" },
                      { value: "others", label: "Others' Personal" },
                    ] as const
                  ).map((option) => (
                    <Button
                      key={option.value}
                      variant={
                        scopeFilters.has(option.value) ? "secondary" : "ghost"
                      }
                      size="sm"
                      className="text-xs h-7 px-2.5"
                      onClick={() => {
                        setScopeFilters((prev) => {
                          const next = new Set(prev);
                          if (next.has(option.value)) {
                            next.delete(option.value);
                          } else {
                            next.add(option.value);
                          }
                          return next;
                        });
                      }}
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
              }
            />
            <div className="px-4 pt-4 shrink-0">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search agents..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                  autoFocus
                />
              </div>
            </div>
            <div className="px-4 pt-4 pb-4 flex-1 min-h-0 overflow-y-auto">
              {filteredAgents.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No agents found.
                </p>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  {filteredAgents.map((agent) => (
                    <AgentCard
                      key={agent.id}
                      agent={agent}
                      isSelected={currentAgentId === agent.id}
                      onSelect={() => handleAgentSelect(agent.id)}
                      currentUserId={userId}
                    />
                  ))}
                  <a
                    href="/agents?create=true"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-center transition-colors hover:bg-accent cursor-pointer text-muted-foreground"
                  >
                    <ExternalLink className="size-5" />
                    <span className="text-xs font-medium">Create Agent</span>
                  </a>
                </div>
              )}
            </div>
          </div>
        )}

        {view === "add-tool" && currentAgent && (
          <AddToolView
            onBack={resetToSettings}
            onSelectCatalog={handleSelectCatalog}
            onAddDelegation={() => setView("add-delegation")}
          />
        )}

        {view === "add-delegation" && currentAgent && (
          <AddDelegationView
            agentId={currentAgent.id}
            onBack={() => setView("add-tool")}
            onDone={resetToSettings}
          />
        )}

        {view === "configure-tool" && currentAgent && selectedCatalog && (
          <ConfigureToolView
            agentId={currentAgent.id}
            catalog={selectedCatalog}
            onBack={() => setView("add-tool")}
            onDone={resetToSettings}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// Reusable dialog header with back button and close
function DialogHeader({
  title,
  onBack,
  extra,
}: {
  title: string;
  onBack: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-3 shrink-0">
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2 gap-1.5"
        onClick={onBack}
      >
        <ArrowLeft className="size-4" />
        Back
      </Button>
      <span className="text-sm font-medium">{title}</span>
      <div className="flex-1" />
      {extra}
      <DialogClose className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
        <XIcon className="size-4" />
        <span className="sr-only">Close</span>
      </DialogClose>
    </div>
  );
}

// ============================================================================
// Agent Settings View
// ============================================================================

function AgentSettingsView({
  agent,
  onChangeAgent,
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
  onChangeAgent: () => void;
  onAddTool: () => void;
  onEditTool: (catalog: CatalogItem) => void;
}) {
  const updateProfile = useUpdateProfile();
  const [instructions, setInstructions] = useState(agent?.systemPrompt ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      <div className="p-6 text-center text-muted-foreground">
        No agent selected
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <AgentIcon icon={agent.icon as string | null} size={24} />
          </div>
          <div>
            <div className="font-semibold text-sm">{agent.name}</div>
            {agent.description && (
              <div className="text-xs text-muted-foreground line-clamp-1">
                {agent.description}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isSaving && (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          )}
          <Button variant="outline" size="sm" onClick={onChangeAgent}>
            Change
          </Button>
          <DialogClose className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>
      </div>

      <div className="p-4 space-y-4 flex-1 min-h-0 overflow-y-auto">
        {((agent as unknown as Record<string, unknown>).scope === "org" ||
          (agent as unknown as Record<string, unknown>).scope === "team") && (
          <Alert variant="info" className="border-0 py-2 text-xs">
            <Info className="size-3.5" />
            <AlertDescription className="text-xs">
              You are editing a shared agent
            </AlertDescription>
          </Alert>
        )}
        <div>
          <Label className="mb-1.5">Instructions</Label>
          <Textarea
            value={instructions}
            onChange={(e) => handleInstructionsChange(e.target.value)}
            className="resize-none text-sm min-h-[80px] max-h-[200px]"
            placeholder="Tell the agent what to do..."
          />
        </div>

        <div>
          <Label className="mb-1.5">Tools and subagents</Label>
          <AssignedToolsGrid
            agentId={agent.id}
            onAddTool={onAddTool}
            onEditTool={onEditTool}
          />
        </div>
      </div>
    </div>
  );
}

// Shows assigned MCP servers as cards + an "Add" card
function AssignedToolsGrid({
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
  const removeDelegation = useRemoveAgentDelegation();
  const unassignTool = useUnassignTool();
  const invalidateAllQueries = useInvalidateToolAssignmentQueries();

  const delegatedAgents = useMemo(() => {
    const targetIds = new Set(delegations.map((d) => d.id));
    return allAgents.filter((a) => targetIds.has(a.id));
  }, [allAgents, delegations]);

  // Group assigned tools by catalogId
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
    <div className="grid grid-cols-3 gap-2">
      {delegatedAgents.map((agent) => (
        <div
          key={`delegation-${agent.id}`}
          className="group relative flex flex-col items-center gap-1.5 rounded-lg border border-primary bg-primary/5 p-3 text-center"
        >
          <button
            type="button"
            className="absolute top-1.5 right-1.5 hidden group-hover:flex h-5 w-5 items-center justify-center rounded-full bg-muted hover:bg-destructive hover:text-destructive-foreground transition-colors z-10"
            onClick={() =>
              removeDelegation.mutate({
                agentId,
                targetAgentId: agent.id,
              })
            }
            title={`Remove ${agent.name}`}
          >
            <XIcon className="size-3" />
          </button>
          <div className="flex flex-col items-center gap-1.5 w-full">
            <AgentIcon
              icon={
                (agent as unknown as Record<string, unknown>).icon as
                  | string
                  | null
              }
              size={24}
            />
            <span className="text-xs font-medium truncate w-full">
              {agent.name}
            </span>
            <AgentToolAvatars agentId={agent.id} />
          </div>
        </div>
      ))}
      {assignedCatalogs.map((catalog) => {
        const info = assignedByCatalog.get(catalog.id);
        return (
          <div
            key={catalog.id}
            className="group relative flex flex-col items-center gap-1.5 rounded-lg border border-primary bg-primary/5 p-3 text-center cursor-pointer transition-colors hover:bg-primary/10"
          >
            <button
              type="button"
              className="absolute top-1.5 right-1.5 hidden group-hover:flex h-5 w-5 items-center justify-center rounded-full bg-muted hover:bg-destructive hover:text-destructive-foreground transition-colors z-10"
              onClick={(e) => {
                e.stopPropagation();
                handleRemove(catalog.id);
              }}
              title={`Remove ${catalog.name}`}
            >
              <XIcon className="size-3" />
            </button>
            <button
              type="button"
              className="flex flex-col items-center gap-1.5 w-full"
              onClick={() => onEditTool(catalog)}
            >
              <McpCatalogIcon
                icon={catalog.icon}
                catalogId={catalog.id}
                size={24}
              />
              <span className="text-xs font-medium truncate w-full">
                {catalog.name}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {info?.count ?? 0} {(info?.count ?? 0) === 1 ? "tool" : "tools"}
              </span>
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onAddTool}
        className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed p-3 text-center transition-colors hover:bg-accent cursor-pointer text-muted-foreground"
      >
        <Plus className="size-5" />
        <span className="text-xs font-medium">Add</span>
      </button>
    </div>
  );
}

// ============================================================================
// Add Tool View - Pick an MCP server
// ============================================================================

function AddToolView({
  onBack,
  onSelectCatalog,
  onAddDelegation,
}: {
  onBack: () => void;
  onSelectCatalog: (catalog: CatalogItem) => void;
  onAddDelegation: () => void;
}) {
  const { data: catalogItems = [], isPending } = useInternalMcpCatalog();
  const allCredentials = useMcpServersGroupedByCatalog();
  const [search, setSearch] = useState("");

  const filteredCatalogs = useMemo(() => {
    if (!search) return catalogItems;
    const lower = search.toLowerCase();
    return catalogItems.filter(
      (c) =>
        c.name.toLowerCase().includes(lower) ||
        c.description?.toLowerCase().includes(lower),
    );
  }, [catalogItems, search]);

  return (
    <div className="flex flex-col h-full">
      <DialogHeader title="Add Tools" onBack={onBack} />
      <div className="px-4 pt-4 shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search MCP servers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            autoFocus
          />
        </div>
      </div>
      <div className="px-4 pt-4 pb-4 flex-1 min-h-0 overflow-y-auto">
        {isPending ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading...
          </div>
        ) : filteredCatalogs.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No MCP servers found.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {!search && (
              <button
                type="button"
                onClick={onAddDelegation}
                className="flex flex-col items-center gap-2 rounded-lg border p-4 text-center transition-colors cursor-pointer hover:bg-accent"
              >
                <Bot className="size-7 text-muted-foreground" />
                <span className="text-sm font-medium truncate w-full">
                  Call an Agent
                </span>
                <p className="text-xs text-muted-foreground line-clamp-2 w-full">
                  Delegate tasks to another agent
                </p>
              </button>
            )}
            {filteredCatalogs.map((catalog) => {
              const hasCredentials =
                catalog.serverType === "builtin" ||
                (allCredentials?.[catalog.id]?.length ?? 0) > 0;
              return (
                <button
                  key={catalog.id}
                  type="button"
                  disabled={!hasCredentials}
                  onClick={() => onSelectCatalog(catalog)}
                  className={cn(
                    "flex flex-col items-center gap-2 rounded-lg border p-4 text-center transition-colors cursor-pointer hover:bg-accent",
                    !hasCredentials && "opacity-40 cursor-not-allowed",
                  )}
                >
                  <McpCatalogIcon
                    icon={catalog.icon}
                    catalogId={catalog.id}
                    size={28}
                  />
                  <span className="text-sm font-medium truncate w-full">
                    {catalog.name}
                  </span>
                  {catalog.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2 w-full">
                      {catalog.description}
                    </p>
                  )}
                  {!hasCredentials && (
                    <span className="text-[10px] text-muted-foreground">
                      Not installed
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Configure Tool View - Select credential & tools for a catalog
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

  // Get currently assigned tool IDs and agent-tool IDs for this catalog
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

  // Initialize selection from assigned tools, or select all for new catalog
  useEffect(() => {
    if (initializedRef.current || allTools.length === 0) return;
    initializedRef.current = true;
    if (assignedToolIds.size > 0) {
      setSelectedToolIds(new Set(assignedToolIds));
    } else {
      setSelectedToolIds(new Set(allTools.map((t) => t.id)));
    }
  }, [allTools, assignedToolIds]);

  // Auto-set default credential once loaded
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

  return (
    <div className="flex flex-col h-full">
      <DialogHeader title={catalog.name} onBack={onBack} />

      <div className="flex flex-col flex-1 min-h-0">
        {showCredentialSelector && (
          <div className="px-4 pt-4 pb-2 space-y-1.5 shrink-0">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading tools...
          </div>
        ) : allTools.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground text-center">
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
            className="w-full"
            onClick={handleSave}
            disabled={(!hasChanges && isEditing) || isSaving}
          >
            {isSaving ? <Loader2 className="size-4 animate-spin mr-2" /> : null}
            {isEditing
              ? `Save (${selectedToolIds.size} tool${selectedToolIds.size !== 1 ? "s" : ""})`
              : `Add ${selectedToolIds.size} tool${selectedToolIds.size !== 1 ? "s" : ""}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Add Delegation View - Pick agents to delegate to
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
    let result = allAgents.filter((a) => a.id !== agentId);
    result = result.filter((a) => {
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
    const scopeOrder: Record<string, number> = { personal: 0, team: 1, org: 2 };
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
    <div className="flex flex-col h-full">
      <DialogHeader
        title="Call an Agent"
        onBack={onBack}
        extra={
          <div className="flex items-center gap-1">
            {(
              [
                { value: "my", label: "My Personal" },
                { value: "team", label: "Team" },
                { value: "org", label: "Organization" },
                { value: "others", label: "Others' Personal" },
              ] as const
            ).map((option) => (
              <Button
                key={option.value}
                variant={scopeFilters.has(option.value) ? "secondary" : "ghost"}
                size="sm"
                className="text-xs h-7 px-2.5"
                onClick={() => {
                  setScopeFilters((prev) => {
                    const next = new Set(prev);
                    if (next.has(option.value)) {
                      next.delete(option.value);
                    } else {
                      next.add(option.value);
                    }
                    return next;
                  });
                }}
              >
                {option.label}
              </Button>
            ))}
          </div>
        }
      />
      <div className="px-4 pt-4 shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search agents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            autoFocus
          />
        </div>
      </div>
      <div className="px-4 pt-2 shrink-0">
        <Alert variant="info" className="border-0 py-2 text-xs">
          <Info className="size-3.5" />
          <AlertDescription className="text-xs">
            Adding a subagent makes its tools and capabilities available to all
            users of this agent during conversations
          </AlertDescription>
        </Alert>
      </div>
      <div className="px-4 pt-2 pb-4 flex-1 min-h-0 overflow-y-auto">
        {filteredAgents.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No agents found.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {filteredAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => handleToggle(agent.id)}
                className={cn(
                  "flex h-full min-h-[120px] flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors hover:bg-accent cursor-pointer",
                  delegatedIds.has(agent.id) && "border-primary bg-accent",
                )}
              >
                <div className="flex w-full items-center gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                    <AgentIcon
                      icon={
                        (agent as unknown as Record<string, unknown>).icon as
                          | string
                          | null
                      }
                      size={16}
                    />
                  </div>
                  <span className="text-sm font-medium truncate flex-1">
                    {agent.name}
                  </span>
                  {delegatedIds.has(agent.id) && (
                    <Check className="h-4 w-4 shrink-0 text-primary" />
                  )}
                </div>
                {agent.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2 w-full">
                    {agent.description}
                  </p>
                )}
                <div className="flex items-center gap-2 w-full mt-auto">
                  <AgentBadge
                    type={
                      (agent as unknown as Record<string, unknown>).scope as
                        | "personal"
                        | "team"
                        | "org"
                    }
                    className="text-[10px] px-1.5 py-0"
                  />
                  <div className="flex-1" />
                  <AgentToolAvatars agentId={agent.id} />
                </div>
              </button>
            ))}
            <a
              href="/agents?create=true"
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-center transition-colors hover:bg-accent cursor-pointer text-muted-foreground"
            >
              <ExternalLink className="size-5" />
              <span className="text-xs font-medium">Create Agent</span>
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Agent Card (for change agent view)
// ============================================================================

function AgentCard({
  agent,
  isSelected,
  onSelect,
  currentUserId,
}: {
  agent: {
    id: string;
    name: string;
    description?: string | null;
    scope: string;
  };
  isSelected: boolean;
  onSelect: () => void;
  currentUserId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex h-full min-h-[120px] flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors hover:bg-accent cursor-pointer",
        isSelected && "border-primary bg-accent",
      )}
    >
      <div className="flex w-full items-center gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <AgentIcon
            icon={
              (agent as unknown as Record<string, unknown>).icon as
                | string
                | null
            }
            size={16}
          />
        </div>
        <span className="text-sm font-medium truncate flex-1">
          {agent.name}
        </span>
        {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
      </div>
      {agent.description && (
        <p className="text-xs text-muted-foreground line-clamp-2 w-full">
          {agent.description}
        </p>
      )}
      <div className="flex items-center gap-2 w-full mt-auto">
        <AgentBadge
          type={agent.scope as "personal" | "team" | "org"}
          className="text-[10px] px-1.5 py-0"
        />
        {agent.scope === "personal" &&
          (agent as unknown as Record<string, unknown>).authorId !==
            currentUserId &&
          Boolean((agent as unknown as Record<string, unknown>).authorName) && (
            <Badge
              variant="secondary"
              className="text-[10px] gap-1 px-1.5 py-0"
            >
              <User className="h-2.5 w-2.5" />
              {
                (agent as unknown as Record<string, unknown>)
                  .authorName as string
              }
            </Badge>
          )}
        <div className="flex-1" />
        <AgentToolAvatars agentId={agent.id} />
      </div>
    </button>
  );
}

function AgentToolAvatars({ agentId }: { agentId: string }) {
  const { data: catalogItems = [] } = useInternalMcpCatalog();
  const { data: allAgents = [] } = useInternalAgents();
  const { data: assignedToolsData } = useAllProfileTools({
    filters: { agentId },
    skipPagination: true,
    enabled: !!agentId,
  });
  const { data: delegations = [] } = useAgentDelegations(agentId);

  const catalogs = useMemo(() => {
    const catalogIds = new Set<string>();
    for (const at of assignedToolsData?.data ?? []) {
      if (at.tool.catalogId) catalogIds.add(at.tool.catalogId);
    }
    return catalogItems.filter((c) => catalogIds.has(c.id));
  }, [assignedToolsData, catalogItems]);

  const subagents = useMemo(() => {
    const targetIds = new Set(delegations.map((d) => d.id));
    return allAgents.filter((a) => targetIds.has(a.id));
  }, [allAgents, delegations]);

  if (catalogs.length === 0 && subagents.length === 0) return null;

  return <ToolServerAvatarGroup catalogs={catalogs} subagents={subagents} />;
}

const MAX_VISIBLE_AVATARS = 3;

type SubagentItem = {
  id: string;
  name: string;
  icon?: string | null;
};

function ToolServerAvatarGroup({
  catalogs,
  subagents = [],
}: {
  catalogs: CatalogItem[];
  subagents?: SubagentItem[];
}) {
  const totalCount = catalogs.length + subagents.length;
  if (totalCount === 0) {
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

  // Build a unified list of avatar items
  const allItems: Array<
    | { type: "catalog"; item: CatalogItem }
    | { type: "subagent"; item: SubagentItem }
  > = [
    ...subagents.map((a) => ({ type: "subagent" as const, item: a })),
    ...catalogs.map((c) => ({ type: "catalog" as const, item: c })),
  ];

  const visible = allItems.slice(0, MAX_VISIBLE_AVATARS);
  const remaining = totalCount - MAX_VISIBLE_AVATARS;

  const hiddenItems = allItems.slice(MAX_VISIBLE_AVATARS);
  const hiddenText =
    hiddenItems.length <= 5
      ? hiddenItems.map((i) => i.item.name).join(", ")
      : `${hiddenItems
          .slice(0, 5)
          .map((i) => i.item.name)
          .join(", ")} and ${hiddenItems.length - 5} more`;

  return (
    <div className="flex -space-x-1.5 items-center ml-1">
      {visible.map((entry) =>
        entry.type === "catalog" ? (
          <Tooltip key={entry.item.id}>
            <TooltipTrigger asChild>
              <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted ring-1 ring-background overflow-hidden">
                <McpCatalogIcon
                  icon={entry.item.icon}
                  catalogId={entry.item.id}
                  size={12}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">{entry.item.name}</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip key={entry.item.id}>
            <TooltipTrigger asChild>
              <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted ring-1 ring-background overflow-hidden">
                <AgentIcon icon={entry.item.icon as string | null} size={12} />
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">{entry.item.name}</TooltipContent>
          </Tooltip>
        ),
      )}
      {remaining > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted ring-1 ring-background text-[9px] font-medium text-muted-foreground">
              +{remaining}
            </div>
          </TooltipTrigger>
          <TooltipContent side="top">{hiddenText}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
