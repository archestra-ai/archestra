"use client";

import type { archestraApiTypes } from "@shared";
import { ArrowLeft, Check, Loader2, Plus, Search, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentBadge } from "@/components/agent-badge";
import { AgentIcon } from "@/components/agent-icon";
import { McpCatalogIcon, ToolChecklist } from "@/components/agent-tools-editor";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { TokenSelect } from "@/components/token-select";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useInternalAgents, useUpdateProfile } from "@/lib/agent.query";
import { useInvalidateToolAssignmentQueries } from "@/lib/agent-tools.hook";
import {
  useAllProfileTools,
  useAssignTool,
  useUnassignTool,
} from "@/lib/agent-tools.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  useCatalogTools,
  useInternalMcpCatalog,
} from "@/lib/internal-mcp-catalog.query";
import { useMcpServersGroupedByCatalog } from "@/lib/mcp-server.query";
import { cn } from "@/lib/utils";

type ScopeFilter = "all" | "personal" | "team" | "org";
type DialogView = "settings" | "change" | "add-tool" | "configure-tool";

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
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [selectedCatalog, setSelectedCatalog] = useState<CatalogItem | null>(
    null,
  );

  const agents = useMemo(() => {
    const userId = session?.user?.id;
    return allAgents.filter(
      (a) =>
        (a as unknown as Record<string, unknown>).scope !== "personal" ||
        (a as unknown as Record<string, unknown>).authorId === userId,
    );
  }, [allAgents, session?.user?.id]);

  const filteredAgents = useMemo(() => {
    let result = agents;
    if (scopeFilter !== "all") {
      result = result.filter(
        (a) => (a as unknown as Record<string, unknown>).scope === scopeFilter,
      );
    }
    if (search) {
      const lower = search.toLowerCase();
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(lower) ||
          a.description?.toLowerCase().includes(lower),
      );
    }
    return result;
  }, [agents, search, scopeFilter]);

  const currentAgent = useMemo(
    () => agents.find((a) => a.id === currentAgentId) ?? agents[0] ?? null,
    [agents, currentAgentId],
  );

  const handleAgentSelect = (agentId: string) => {
    onAgentChange(agentId);
    setView("settings");
    setSearch("");
    setScopeFilter("all");
  };

  const resetToSettings = useCallback(() => {
    setView("settings");
    setSearch("");
    setScopeFilter("all");
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
                <Select
                  value={scopeFilter}
                  onValueChange={(v) => setScopeFilter(v as ScopeFilter)}
                >
                  <SelectTrigger className="w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" side="bottom" align="start">
                    <SelectItem value="all">All types</SelectItem>
                    <SelectItem value="personal">Personal</SelectItem>
                    <SelectItem value="team">Team</SelectItem>
                    <SelectItem value="org">Organization</SelectItem>
                  </SelectContent>
                </Select>
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
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {view === "add-tool" && currentAgent && (
          <AddToolView
            onBack={resetToSettings}
            onSelectCatalog={handleSelectCatalog}
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
            <div className="text-xs text-muted-foreground">AI Agent</div>
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
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
            Instructions
          </div>
          <Textarea
            value={instructions}
            onChange={(e) => handleInstructionsChange(e.target.value)}
            className="resize-none text-sm min-h-[80px] max-h-[200px]"
            placeholder="Tell the agent what to do..."
          />
        </div>

        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
            Tools
          </div>
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
  const unassignTool = useUnassignTool();
  const invalidateAllQueries = useInvalidateToolAssignmentQueries();

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
                {info?.count ?? 0} tools
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
}: {
  onBack: () => void;
  onSelectCatalog: (catalog: CatalogItem) => void;
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
// Agent Card (for change agent view)
// ============================================================================

function AgentCard({
  agent,
  isSelected,
  onSelect,
}: {
  agent: {
    id: string;
    name: string;
    description?: string | null;
    scope: string;
  };
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex h-full flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors hover:bg-accent cursor-pointer",
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
      </div>
    </button>
  );
}
