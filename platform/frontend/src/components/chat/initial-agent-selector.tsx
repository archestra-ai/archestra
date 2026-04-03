"use client";

import {
  type AgentScope,
  type archestraApiTypes,
  isBuiltInCatalogId,
} from "@shared";
import { useQueries } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  Check,
  Database,
  ExternalLink,
  Info,
  Loader2,
  Plus,
  Search,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { LocalServerInstallDialog } from "@/app/mcp/registry/_parts/local-server-install-dialog";
import { NoAuthInstallDialog } from "@/app/mcp/registry/_parts/no-auth-install-dialog";
import { RemoteServerInstallDialog } from "@/app/mcp/registry/_parts/remote-server-install-dialog";
import { AgentBadge } from "@/components/agent-badge";
import { AgentIcon } from "@/components/agent-icon";
import { AgentIconPicker } from "@/components/agent-icon-picker";
import { ToolChecklist } from "@/components/agent-tools-editor";
import { sortCatalogItems } from "@/components/agent-tools-editor.utils";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { CatalogDocsLink } from "@/components/catalog-docs-link";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { OAuthConfirmationDialog } from "@/components/oauth-confirmation-dialog";
import { SystemPromptEditor } from "@/components/system-prompt-editor";
import { TokenSelect } from "@/components/token-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  useCreateProfile,
  useInternalAgents,
  useUpdateProfile,
} from "@/lib/agent.query";
import { useInvalidateToolAssignmentQueries } from "@/lib/agent-tools.hook";
import {
  useAgentDelegations,
  useAllProfileTools,
  useAssignTool,
  useRemoveAgentDelegation,
  useSyncAgentDelegations,
  useUnassignTool,
} from "@/lib/agent-tools.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useConnectors } from "@/lib/knowledge/connector.query";
import { useKnowledgeBases } from "@/lib/knowledge/knowledge-base.query";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import {
  fetchCatalogTools,
  useCatalogTools,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import {
  type McpInstallOrchestrator,
  useMcpInstallOrchestrator,
} from "@/lib/mcp/mcp-install-orchestrator.hook";
import {
  useMcpServers,
  useMcpServersGroupedByCatalog,
} from "@/lib/mcp/mcp-server.query";
import { cn } from "@/lib/utils";
import {
  filterAndSortInitialAgents,
  truncateAgentDescription,
} from "./initial-agent-selector.utils";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

interface InitialAgentSelectorProps {
  currentAgentId: string | null;
  currentAgentName?: string;
  onAgentChange: (agentId: string) => void;
}

export function InitialAgentSelector({
  currentAgentId,
  currentAgentName,
  onAgentChange,
}: InitialAgentSelectorProps) {
  const { data: allAgents = [] } = useInternalAgents();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const { data: isAgentAdmin } = useHasPermissions({ agent: ["admin"] });
  const createProfile = useCreateProfile();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [dialogView, setDialogView] = useState<
    | "settings"
    | "add-tool"
    | "configure-tool"
    | "add-delegation"
    | "edit-knowledge-sources"
  >("settings");
  const [selectedCatalog, setSelectedCatalog] = useState<CatalogItem | null>(
    null,
  );
  const [configureToolFrom, setConfigureToolFrom] = useState<
    "settings" | "add-tool"
  >("settings");
  const installer = useMcpInstallOrchestrator();

  const filteredAgents = useMemo(() => {
    return filterAndSortInitialAgents({
      allAgents,
      currentAgentId,
      search,
      userId,
    });
  }, [allAgents, search, currentAgentId, userId]);

  const currentAgent = useMemo(
    () =>
      allAgents.find((a) => a.id === currentAgentId) ?? allAgents[0] ?? null,
    [allAgents, currentAgentId],
  );
  const displayAgentName =
    currentAgent?.name ?? currentAgentName ?? "Select agent";

  const canEditCurrentAgent = useMemo(() => {
    if (!currentAgent) return false;
    if (isAgentAdmin) return true;
    const authorId = currentAgent.authorId;
    return authorId === userId;
  }, [currentAgent, isAgentAdmin, userId]);

  const effectiveAgentId = currentAgent?.id ?? currentAgentId;
  const { data: canReadMcpRegistry } = useHasPermissions({
    mcpRegistry: ["read"],
  });
  const { data: canReadToolPolicy } = useHasPermissions({
    toolPolicy: ["read"],
  });
  const { data: canReadKnowledgeBase } = useHasPermissions({
    knowledgeBase: ["read"],
  });
  const { data: catalogItems = [] } = useInternalMcpCatalog({
    enabled: !!canReadMcpRegistry,
  });
  const { data: assignedToolsData } = useAllProfileTools({
    filters: { agentId: effectiveAgentId ?? undefined },
    skipPagination: true,
    enabled: !!effectiveAgentId && !!canReadToolPolicy,
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

  // Knowledge base data for connector icons in avatar group
  const { data: knowledgeBasesData } = useKnowledgeBases({
    enabled: !!canReadKnowledgeBase,
  });
  const { data: connectorsData } = useConnectors({
    enabled: !!canReadKnowledgeBase,
  });

  const allKnowledgeBases = knowledgeBasesData ?? [];
  const allConnectors = connectorsData ?? [];
  const knowledgeBaseIds = currentAgent?.knowledgeBaseIds ?? [];
  const connectorIds = currentAgent?.connectorIds ?? [];

  // Match knowledge bases and connectors for the current agent
  const matchedKbs = useMemo(
    () => allKnowledgeBases.filter((k) => knowledgeBaseIds.includes(k.id)),
    [allKnowledgeBases, knowledgeBaseIds],
  );
  const matchedConnectors = useMemo(
    () => allConnectors.filter((c) => connectorIds.includes(c.id)),
    [allConnectors, connectorIds],
  );

  // Compute unique connector types from matched knowledge bases and connectors
  const agentConnectorTypes = useMemo(() => {
    const kbConnectorTypes = matchedKbs.flatMap(
      (kb) => kb.connectors?.map((c) => c.connectorType) ?? [],
    );
    const directConnectorTypes = matchedConnectors.map((c) => c.connectorType);

    return [...new Set([...kbConnectorTypes, ...directConnectorTypes])];
  }, [matchedKbs, matchedConnectors]);

  const handleAgentSelect = (agentId: string) => {
    onAgentChange(agentId);
    setOpen(false);
    setSearch("");
  };

  const editingAgent = useMemo(
    () => allAgents.find((a) => a.id === editingAgentId) ?? null,
    [allAgents, editingAgentId],
  );

  const editingKbs = useMemo(() => {
    const ids = editingAgent?.knowledgeBaseIds ?? [];
    return allKnowledgeBases.filter((k) => ids.includes(k.id));
  }, [allKnowledgeBases, editingAgent?.knowledgeBaseIds]);

  const editingConnectors = useMemo(() => {
    const ids = editingAgent?.connectorIds ?? [];
    return allConnectors.filter((c) => ids.includes(c.id));
  }, [allConnectors, editingAgent?.connectorIds]);

  const closeDialog = () => {
    setEditingAgentId(null);
    setDialogView("settings");
    setSelectedCatalog(null);
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(newOpen) => {
          setOpen(newOpen);
          if (!newOpen) setSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <PromptInputButton
            role="combobox"
            aria-expanded={open}
            data-agent-selector
            className="max-w-[300px] min-w-0"
          >
            <AgentIcon icon={currentAgent.icon} size={16} />
            <span className="truncate flex-1 text-left">
              {displayAgentName}
            </span>
            <ToolServerAvatarGroup
              catalogs={assignedCatalogs}
              subagents={triggerSubagents}
              connectorTypes={agentConnectorTypes}
              showAddButton={canEditCurrentAgent}
              onAdd={() => {
                if (currentAgentId) {
                  setEditingAgentId(currentAgentId);
                  setDialogView("add-tool");
                }
              }}
            />
          </PromptInputButton>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={8}
          className="w-64 p-0 rounded-xl"
        >
          <div className="p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8 text-sm rounded-lg border-0 bg-muted/50 focus-visible:ring-1"
                autoFocus
              />
            </div>
          </div>
          <div className="max-h-[300px] overflow-y-auto px-1.5 pb-1.5">
            {filteredAgents.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                No agents found
              </div>
            ) : (
              filteredAgents.map((agent) => {
                const isSelected = currentAgentId === agent.id;
                const canEdit = isAgentAdmin || agent.authorId === userId;
                return (
                  <div
                    key={agent.id}
                    className={cn(
                      "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-accent",
                      isSelected && "bg-accent",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => handleAgentSelect(agent.id)}
                      className="flex flex-1 items-center gap-2.5 text-left cursor-pointer min-w-0"
                    >
                      <div
                        className={cn(
                          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                          isSelected
                            ? "bg-primary/10 ring-1 ring-primary/20"
                            : "bg-muted",
                        )}
                      >
                        <AgentIcon icon={agent.icon} size={14} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {agent.name}
                        </div>
                        {agent.description && (
                          <div className="text-[11px] text-muted-foreground truncate">
                            {agent.description}
                          </div>
                        )}
                      </div>
                      {isSelected && (
                        <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                      )}
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[11px] hidden group-hover:flex shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (canEdit) {
                          setOpen(false);
                          setEditingAgentId(agent.id);
                        } else {
                          createProfile.mutate(
                            {
                              name: `Copy ${agent.name}`,
                              scope: "personal",
                              agentType: "agent",
                              description: agent.description,
                              systemPrompt: agent.systemPrompt,
                              icon: agent.icon,
                            },
                            {
                              onSuccess: (newAgent) => {
                                if (newAgent?.id) {
                                  onAgentChange(newAgent.id);
                                  setOpen(false);
                                  setEditingAgentId(newAgent.id);
                                }
                              },
                            },
                          );
                        }
                      }}
                    >
                      {canEdit ? "Edit" : "Clone"}
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>

      <Dialog
        open={!!editingAgentId}
        onOpenChange={(isOpen) => {
          if (!isOpen) closeDialog();
        }}
      >
        <DialogContent
          className="max-w-3xl h-[660px] p-0 gap-0 overflow-hidden flex flex-col"
          onCloseAutoFocus={(e) => e.preventDefault()}
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">Agent Settings</DialogTitle>

          {dialogView === "settings" && (
            <AgentSettingsView
              agent={editingAgent}
              onAddTool={() => setDialogView("add-tool")}
              onEditTool={(catalog) => {
                setSelectedCatalog(catalog);
                setConfigureToolFrom("settings");
                setDialogView("configure-tool");
              }}
              onEditKnowledgeSources={() =>
                setDialogView("edit-knowledge-sources")
              }
              matchedKnowledgeBases={editingKbs}
              matchedConnectors={editingConnectors}
            />
          )}

          {dialogView === "add-tool" && editingAgent && (
            <AddToolView
              agentId={editingAgent.id}
              agentName={editingAgent.name}
              onBack={() => setDialogView("settings")}
              onAddDelegation={() => setDialogView("add-delegation")}
              onSelectCatalog={(catalog) => {
                setSelectedCatalog(catalog);
                setConfigureToolFrom("add-tool");
                setDialogView("configure-tool");
              }}
              installer={installer}
            />
          )}

          {dialogView === "add-delegation" && editingAgent && (
            <AddDelegationView
              agentId={editingAgent.id}
              agentName={editingAgent.name}
              onBack={() => setDialogView("add-tool")}
              onDone={() => setDialogView("settings")}
            />
          )}

          {dialogView === "configure-tool" &&
            editingAgent &&
            selectedCatalog && (
              <ConfigureToolView
                agentId={editingAgent.id}
                agentName={editingAgent.name}
                catalog={selectedCatalog}
                onBack={() => setDialogView(configureToolFrom)}
                onDone={() => setDialogView("settings")}
              />
            )}

          {dialogView === "edit-knowledge-sources" && editingAgent && (
            <EditKnowledgeSourcesView
              agent={editingAgent}
              allKnowledgeBases={allKnowledgeBases}
              allConnectors={allConnectors}
              onBack={() => setDialogView("settings")}
            />
          )}
        </DialogContent>
      </Dialog>

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

// Reusable dialog header with back button and close
function DialogHeader({
  title,
  breadcrumbs,
  onBack,
  extra,
  description,
}: {
  title: string;
  breadcrumbs?: string[];
  onBack: () => void;
  extra?: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <div className="border-b px-4 py-3 shrink-0">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 gap-1.5 shrink-0 self-center"
            onClick={onBack}
          >
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <div className="min-w-0 flex-1 space-y-1">
            {breadcrumbs?.length ? (
              <div className="flex items-center gap-1.5 text-sm min-w-0">
                {breadcrumbs.map((crumb, i) => (
                  <span
                    key={crumb}
                    className="flex items-center gap-1.5 min-w-0"
                  >
                    {i === 0 ? (
                      <button
                        type="button"
                        onClick={onBack}
                        className="text-muted-foreground hover:text-foreground transition-colors truncate"
                      >
                        {crumb}
                      </button>
                    ) : (
                      <span className="text-muted-foreground truncate">
                        {crumb}
                      </span>
                    )}
                    <span className="text-muted-foreground">/</span>
                  </span>
                ))}
                <span className="font-medium truncate">{title}</span>
              </div>
            ) : (
              <span className="text-sm font-medium">{title}</span>
            )}
            {description ? (
              <div className="text-xs text-muted-foreground leading-relaxed">
                {description}
              </div>
            ) : null}
          </div>
        </div>
        {extra}
        <DialogClose className="ml-auto rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 shrink-0">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </DialogClose>
      </div>
    </div>
  );
}

// ============================================================================
// Agent Settings View
// ============================================================================

function AgentSettingsView({
  agent,
  onAddTool,
  onEditTool,
  onEditKnowledgeSources,
  matchedKnowledgeBases: matchedKbs,
  matchedConnectors,
}: {
  agent: {
    id: string;
    name: string;
    description?: string | null;
    systemPrompt?: string | null;
    icon?: string | null;
    scope?: string;
    knowledgeBaseIds?: string[];
    connectorIds?: string[];
    createdAt?: string;
    authorName?: string | null;
  } | null;
  onAddTool: () => void;
  onEditTool: (catalog: CatalogItem) => void;
  onEditKnowledgeSources: () => void;
  matchedKnowledgeBases: archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"];
  matchedConnectors: archestraApiTypes.GetConnectorsResponses["200"]["data"];
}) {
  const updateProfile = useUpdateProfile();
  const { data: canReadAgents } = useHasPermissions({ agent: ["read"] });

  const appName = useAppName();
  const [instructions, setInstructions] = useState(agent?.systemPrompt ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState(agent?.name ?? "");
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [isEditingIcon, setIsEditingIcon] = useState(false);
  const truncatedDescription = truncateAgentDescription(agent?.description);

  // biome-ignore lint/correctness/useExhaustiveDependencies: agent?.id ensures reset when switching agents
  useEffect(() => {
    setInstructions(agent?.systemPrompt ?? "");
    setEditedName(agent?.name ?? "");
    setIsEditingName(false);
    setIsEditingIcon(false);
  }, [agent?.id, agent?.systemPrompt, agent?.name]);

  const instructionsChanged =
    (instructions.trim() || null) !== (agent?.systemPrompt ?? null);

  const saveInstructions = useCallback(() => {
    if (!agent || !instructionsChanged) return;
    setIsSaving(true);
    updateProfile.mutateAsync(
      {
        id: agent.id,
        data: { systemPrompt: instructions.trim() || null },
      },
      { onSettled: () => setIsSaving(false) },
    );
  }, [agent, updateProfile, instructions, instructionsChanged]);

  const saveName = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!agent || !trimmed || trimmed === agent.name) {
        setEditedName(agent?.name ?? "");
        setIsEditingName(false);
        return;
      }
      setIsSaving(true);
      updateProfile.mutateAsync(
        { id: agent.id, data: { name: trimmed } },
        { onSettled: () => setIsSaving(false) },
      );
      setIsEditingName(false);
    },
    [agent, updateProfile],
  );

  const saveIcon = useCallback(
    (icon: string | null) => {
      if (!agent) return;
      updateProfile.mutateAsync({ id: agent.id, data: { icon } });
      setIsEditingIcon(false);
    },
    [agent, updateProfile],
  );

  const handleRemoveKnowledgeBase = useCallback(
    (kbId: string) => {
      if (!agent) return;
      const currentIds = agent.knowledgeBaseIds ?? [];
      updateProfile.mutateAsync({
        id: agent.id,
        data: { knowledgeBaseIds: currentIds.filter((id) => id !== kbId) },
      });
    },
    [agent, updateProfile],
  );

  const handleRemoveConnector = useCallback(
    (connectorId: string) => {
      if (!agent) return;
      const currentIds = agent.connectorIds ?? [];
      updateProfile.mutateAsync({
        id: agent.id,
        data: {
          connectorIds: currentIds.filter((id) => id !== connectorId),
        },
      });
    },
    [agent, updateProfile],
  );

  useEffect(() => {
    if (isEditingName) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [isEditingName]);

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
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {isEditingIcon ? (
            <AgentIconPicker
              value={(agent.icon as string | null) ?? null}
              onChange={saveIcon}
              className="h-10 w-10"
            />
          ) : (
            <button
              type="button"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted cursor-pointer"
              onDoubleClick={() => setIsEditingIcon(true)}
            >
              <AgentIcon icon={agent.icon as string | null} size={24} />
            </button>
          )}
          <div className="flex-1 min-w-0">
            {isEditingName ? (
              <Input
                ref={nameInputRef}
                value={editedName}
                onChange={(e) => setEditedName(e.target.value)}
                onBlur={() => saveName(editedName)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveName(editedName);
                  if (e.key === "Escape") {
                    setEditedName(agent.name);
                    setIsEditingName(false);
                  }
                }}
                className="h-7 text-sm font-semibold px-1.5 -ml-1.5"
              />
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="font-semibold text-sm cursor-pointer"
                  onDoubleClick={() => setIsEditingName(true)}
                >
                  {agent.name}
                </button>
                <AgentBadge
                  type={(agent.scope as AgentScope) ?? "personal"}
                  className="text-[10px] px-1.5 py-0"
                />
              </div>
            )}
            {!isEditingName && truncatedDescription && (
              <p className="mt-1 text-left text-xs text-muted-foreground">
                {truncatedDescription}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          {agent?.createdAt &&
            (() => {
              const authorName = agent.authorName ?? appName;
              return (
                <div className="flex items-center gap-2 text-xs text-muted-foreground whitespace-nowrap">
                  <div className="h-5 w-5 rounded-full bg-green-500 flex items-center justify-center text-[10px] font-medium text-white shrink-0">
                    {authorName.charAt(0).toUpperCase()}
                  </div>
                  <span>
                    Created by {authorName} on{" "}
                    {new Date(agent.createdAt).toLocaleDateString()}
                  </span>
                </div>
              );
            })()}
          {isSaving && (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          )}
          <DialogClose className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>
      </div>

      <div className="p-4 space-y-4 flex-1 min-h-0 overflow-y-auto">
        {agent.scope === "org" ||
          (agent.scope === "team" && (
            <Alert variant="info" className="border-0 py-2 text-xs">
              <Info className="size-3.5" />
              <AlertDescription className="text-xs">
                You are editing a shared agent
              </AlertDescription>
            </Alert>
          ))}
        <SystemPromptEditor
          value={instructions}
          onChange={setInstructions}
          height="120px"
        />

        <div>
          <Label className="mb-1.5">Tools and subagents</Label>
          <AssignedToolsGrid
            agentId={agent.id}
            onAddTool={onAddTool}
            onEditTool={onEditTool}
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <Label>Knowledge sources</Label>
          </div>
          {matchedKbs.length === 0 && matchedConnectors.length === 0 ? (
            <button
              type="button"
              onClick={onEditKnowledgeSources}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed p-3 text-center transition-colors hover:bg-accent cursor-pointer text-muted-foreground"
            >
              <Database className="size-4" />
              <span className="text-xs font-medium">Add knowledge sources</span>
            </button>
          ) : (
            <div className="space-y-2">
              {matchedKbs.map((kb) => {
                const connectors = kb.connectors ?? [];
                const connectorTypes = [
                  ...new Set(connectors.map((c) => c.connectorType)),
                ];
                return (
                  <div
                    key={kb.id}
                    className="group flex items-center justify-between gap-2 rounded-lg border bg-muted/30 p-3"
                  >
                    <span className="text-sm font-medium truncate">
                      {kb.name}
                    </span>
                    <div className="flex items-center gap-2">
                      {connectorTypes.length > 0 && (
                        <OverlappedIcons
                          icons={connectorTypes.map((type) => ({
                            key: type,
                            icon: (
                              <ConnectorTypeIcon
                                type={type}
                                className="h-full w-full"
                              />
                            ),
                            tooltip: type,
                          }))}
                          maxVisible={3}
                          size="sm"
                        />
                      )}
                      <button
                        type="button"
                        className="hidden group-hover:flex h-5 w-5 items-center justify-center rounded-full bg-muted hover:bg-destructive hover:text-destructive-foreground transition-colors"
                        onClick={() => handleRemoveKnowledgeBase(kb.id)}
                        title={`Remove ${kb.name}`}
                      >
                        <XIcon className="size-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
              {matchedConnectors.map((connector) => (
                <div
                  key={connector.id}
                  className="group flex items-center gap-2 rounded-lg border bg-muted/30 p-3 text-sm"
                >
                  <ConnectorTypeIcon
                    type={connector.connectorType}
                    className="h-4 w-4 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="truncate block">{connector.name}</span>
                    {connector.description && (
                      <span className="truncate block text-xs text-muted-foreground">
                        {connector.description}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="hidden group-hover:flex h-5 w-5 items-center justify-center rounded-full bg-muted hover:bg-destructive hover:text-destructive-foreground transition-colors"
                    onClick={() => handleRemoveConnector(connector.id)}
                    title={`Remove ${connector.name}`}
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={onEditKnowledgeSources}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed p-2 text-center transition-colors hover:bg-accent cursor-pointer text-muted-foreground"
              >
                <Plus className="size-3.5" />
                <span className="text-xs font-medium">Add</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="border-t px-4 py-3 shrink-0 flex items-center justify-between gap-3">
        {canReadAgents ? (
          <Link
            href={`/agents?edit=${agent.id}`}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
          >
            Full configuration <ExternalLink className="size-3" />
          </Link>
        ) : (
          <div />
        )}
        {instructionsChanged && (
          <Button
            size="sm"
            className="h-7 px-3 text-xs"
            onClick={saveInstructions}
            disabled={isSaving}
          >
            {isSaving && <Loader2 className="size-3 animate-spin mr-1.5" />}
            Save
          </Button>
        )}
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
            <AgentIcon icon={agent.icon} size={24} />
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
  agentId,
  agentName,
  onBack,
  onAddDelegation,
  onSelectCatalog,
  installer,
}: {
  agentId: string;
  agentName: string;
  onBack: () => void;
  onAddDelegation: () => void;
  onSelectCatalog: (catalog: CatalogItem) => void;
  installer: McpInstallOrchestrator;
}) {
  const { data: catalogItems = [], isPending } = useInternalMcpCatalog();
  const allCredentials = useMcpServersGroupedByCatalog();
  const [search, setSearch] = useState("");
  const assignTool = useAssignTool();
  const invalidateAllQueries = useInvalidateToolAssignmentQueries();
  const [addingCatalogId, setAddingCatalogId] = useState<string | null>(null);

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
  const { catalogName } = useArchestraMcpIdentity();

  // Detect servers that are still being installed (local servers with pending status)
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

  // Enable polling while servers are installing
  useMcpServers({ hasInstallingServers });

  // Pre-fetch tool counts for ready catalogs to detect empty ones
  const readyCatalogIds = useMemo(() => {
    return catalogItems
      .filter((c) => {
        const servers = allCredentials?.[c.id] ?? [];
        const hasCredentials = c.serverType === "builtin" || servers.length > 0;
        const isInstalling = servers.some(
          (s) =>
            s.localInstallationStatus === "pending" ||
            s.localInstallationStatus === "discovering-tools",
        );
        return hasCredentials && !isInstalling;
      })
      .map((c) => c.id);
  }, [catalogItems, allCredentials]);

  const toolCountQueries = useQueries({
    queries: readyCatalogIds.map((id) => ({
      queryKey: ["mcp-catalog", id, "tools"],
      queryFn: () => fetchCatalogTools(id),
      staleTime: 60_000,
    })),
  });

  const emptyToolCatalogIds = useMemo(() => {
    const ids = new Set<string>();
    readyCatalogIds.forEach((id, i) => {
      const q = toolCountQueries[i];
      if (q.isSuccess && q.data.length === 0) ids.add(id);
    });
    return ids;
  }, [readyCatalogIds, toolCountQueries]);

  const handleAddAllTools = async (catalog: CatalogItem) => {
    setAddingCatalogId(catalog.id);
    try {
      const tools = await fetchCatalogTools(catalog.id);
      if (tools.length === 0) return;
      const servers = allCredentials?.[catalog.id] ?? [];
      const _isLocal = catalog.serverType === "local";
      const isBuiltin = catalog.serverType === "builtin";
      const credentialId = servers[0]?.id;
      await Promise.all(
        tools.map((tool) =>
          assignTool.mutateAsync({
            agentId,
            toolId: tool.id,
            mcpServerId: !isBuiltin ? (credentialId ?? undefined) : undefined,
            skipInvalidation: true,
          }),
        ),
      );
      invalidateAllQueries(agentId);
      onBack();
    } finally {
      setAddingCatalogId(null);
    }
  };

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
    return sortCatalogItems(
      items,
      (catalog) => (assignedCatalogIds.has(catalog.id) ? 1 : 0),
      () => 1,
    );
  }, [catalogItems, search, assignedCatalogIds]);

  return (
    <div className="flex flex-col h-full">
      <DialogHeader
        title="Add Tools"
        breadcrumbs={[agentName]}
        onBack={onBack}
      />
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
              const isAdding = addingCatalogId === catalog.id;
              const hasNoTools = emptyToolCatalogIds.has(catalog.id);
              const showSelectLink =
                isReady && !isAssigned && !isAdding && !hasNoTools;
              return (
                <div key={catalog.id} className="group relative flex flex-col">
                  <button
                    type="button"
                    disabled={
                      isAssigned || isServerInstalling || isAdding || hasNoTools
                    }
                    onClick={() =>
                      isAssigned
                        ? undefined
                        : isReady
                          ? handleAddAllTools(catalog)
                          : installer.triggerInstallByCatalogId(catalog.id)
                    }
                    className={cn(
                      "relative flex flex-col items-center gap-2 rounded-lg border p-4 text-center transition-colors flex-1",
                      isAssigned
                        ? "opacity-50 cursor-default border-primary/30"
                        : hasNoTools
                          ? "opacity-50 cursor-default"
                          : "cursor-pointer hover:bg-accent",
                      (isServerInstalling || isAdding) &&
                        "opacity-60 cursor-wait",
                    )}
                  >
                    {isAssigned && (
                      <div className="absolute top-2 right-2">
                        <Check className="h-4 w-4 text-primary" />
                      </div>
                    )}
                    <McpCatalogIcon
                      icon={catalog.icon}
                      catalogId={catalog.id}
                      size={28}
                    />
                    <span className="text-sm font-medium truncate w-full">
                      {isBuiltInCatalogId(catalog.id)
                        ? catalogName
                        : catalog.name}
                    </span>
                    {catalog.description && !hasNoTools && (
                      <p className="text-xs text-muted-foreground line-clamp-2 w-full">
                        {catalog.description}
                      </p>
                    )}
                    {hasNoTools && (
                      <p className="text-xs text-muted-foreground">
                        No tools found
                      </p>
                    )}
                    {(isServerInstalling || isAdding) && (
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {isAdding ? "Adding..." : "Installing..."}
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
                  {showSelectLink && (
                    <div className="hidden group-hover:flex flex-col absolute left-0 right-0 bottom-0 rounded-b-lg z-10">
                      <div className="h-4 bg-gradient-to-t from-background to-transparent" />
                      <button
                        type="button"
                        className="flex w-full items-center justify-center px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer bg-background rounded-b-lg"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectCatalog(catalog);
                        }}
                      >
                        Select specific tools
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {!search && (
              <a
                href="/mcp/registry"
                target="_blank"
                rel="noopener noreferrer"
                className="flex flex-col items-center justify-center gap-2 rounded-lg border bg-accent/50 p-4 text-center transition-colors cursor-pointer hover:bg-accent"
              >
                <ExternalLink className="size-7 text-muted-foreground" />
                <span className="text-sm font-medium">Add New Server</span>
              </a>
            )}
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
  agentName,
  catalog,
  onBack,
  onDone,
}: {
  agentId: string;
  agentName: string;
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
      const _isLocal = catalog.serverType === "local";
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
            mcpServerId: !isBuiltin ? (credential ?? undefined) : undefined,
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
    <div className="flex flex-col h-full">
      <DialogHeader
        title={catalog.name}
        breadcrumbs={[agentName, "Add Tools"]}
        onBack={onBack}
        description={
          <>
            {catalog.description}
            {catalog.docsUrl ? (
              <>
                {" "}
                <CatalogDocsLink
                  url={catalog.docsUrl}
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                />
              </>
            ) : null}
          </>
        }
      />

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
            disabled={
              (!hasChanges && isEditing) ||
              (!isEditing && newToolCount === 0) ||
              isSaving
            }
          >
            {isSaving ? <Loader2 className="size-4 animate-spin mr-2" /> : null}
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
// Add Delegation View - Pick agents to delegate to
// ============================================================================

function AddDelegationView({
  agentId,
  agentName,
  onBack,
  onDone,
}: {
  agentId: string;
  agentName: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const { data: allAgents = [] } = useInternalAgents();
  const { data: delegations = [] } = useAgentDelegations(agentId);
  const syncDelegations = useSyncAgentDelegations();
  const [search, setSearch] = useState("");

  const delegatedIds = useMemo(
    () => new Set(delegations.map((d) => d.id)),
    [delegations],
  );

  const filteredAgents = useMemo(() => {
    let result = allAgents.filter((a) => a.id !== agentId);
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
      return (scopeOrder[a.scope] ?? 3) - (scopeOrder[b.scope] ?? 3);
    });
  }, [allAgents, agentId, search]);

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
        title="Call Sub-agent"
        breadcrumbs={[agentName, "Add Tools"]}
        onBack={onBack}
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
                    <AgentIcon icon={agent.icon} size={16} />
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
                    type={agent.scope}
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
// Edit Knowledge Sources View
// ============================================================================

function EditKnowledgeSourcesView({
  agent,
  allKnowledgeBases,
  allConnectors,
  onBack,
}: {
  agent: {
    id: string;
    name: string;
    knowledgeBaseIds?: string[];
    connectorIds?: string[];
  };
  allKnowledgeBases: archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"];
  allConnectors: archestraApiTypes.GetConnectorsResponses["200"]["data"];
  onBack: () => void;
}) {
  const updateProfile = useUpdateProfile();
  const [search, setSearch] = useState("");

  const selectedKbIds = useMemo(
    () => new Set(agent.knowledgeBaseIds ?? []),
    [agent.knowledgeBaseIds],
  );
  const selectedConnectorIds = useMemo(
    () => new Set(agent.connectorIds ?? []),
    [agent.connectorIds],
  );

  const filteredKbs = useMemo(() => {
    if (!search) return allKnowledgeBases;
    const lower = search.toLowerCase();
    return allKnowledgeBases.filter(
      (kb) =>
        kb.name.toLowerCase().includes(lower) ||
        kb.description?.toLowerCase().includes(lower),
    );
  }, [allKnowledgeBases, search]);

  const filteredConnectors = useMemo(() => {
    if (!search) return allConnectors;
    const lower = search.toLowerCase();
    return allConnectors.filter(
      (c) =>
        c.name.toLowerCase().includes(lower) ||
        c.connectorType.toLowerCase().includes(lower),
    );
  }, [allConnectors, search]);

  // Stable sort: use initial selection to avoid rows jumping on toggle
  const initialSelectedKbIds = useRef(selectedKbIds);
  const initialSelectedConnectorIds = useRef(selectedConnectorIds);

  const sortedKbs = useMemo(() => {
    return [...filteredKbs].sort((a, b) => {
      const aSelected = initialSelectedKbIds.current.has(a.id) ? 0 : 1;
      const bSelected = initialSelectedKbIds.current.has(b.id) ? 0 : 1;
      return aSelected - bSelected;
    });
  }, [filteredKbs]);

  const sortedConnectors = useMemo(() => {
    return [...filteredConnectors].sort((a, b) => {
      const aSelected = initialSelectedConnectorIds.current.has(a.id) ? 0 : 1;
      const bSelected = initialSelectedConnectorIds.current.has(b.id) ? 0 : 1;
      return aSelected - bSelected;
    });
  }, [filteredConnectors]);

  const handleToggleKb = (kbId: string) => {
    const currentIds = agent.knowledgeBaseIds ?? [];
    const newIds = selectedKbIds.has(kbId)
      ? currentIds.filter((id) => id !== kbId)
      : [...currentIds, kbId];
    updateProfile.mutate({
      id: agent.id,
      data: { knowledgeBaseIds: newIds },
    });
  };

  const handleToggleConnector = (connectorId: string) => {
    const currentIds = agent.connectorIds ?? [];
    const newIds = selectedConnectorIds.has(connectorId)
      ? currentIds.filter((id) => id !== connectorId)
      : [...currentIds, connectorId];
    updateProfile.mutate({
      id: agent.id,
      data: { connectorIds: newIds },
    });
  };

  const hasItems = allKnowledgeBases.length > 0 || allConnectors.length > 0;
  const totalSelected = selectedKbIds.size + selectedConnectorIds.size;

  return (
    <div className="flex flex-col h-full">
      <DialogHeader
        title="Knowledge Sources"
        breadcrumbs={[agent.name]}
        onBack={onBack}
      />

      {!hasItems ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <Database className="size-8 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">No knowledge sources</p>
            <p className="text-xs text-muted-foreground mt-1">
              Create knowledge bases or connectors to use them here.
            </p>
          </div>
          <a
            href="/knowledge/knowledge-bases"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            Go to Knowledge <ExternalLink className="size-3" />
          </a>
        </div>
      ) : (
        <>
          <div className="px-4 pt-4 shrink-0 space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search knowledge sources..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
                autoFocus
              />
            </div>
            <div className="text-xs text-muted-foreground">
              {totalSelected} source{totalSelected !== 1 ? "s" : ""} selected
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2 space-y-1">
            {sortedKbs.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider pb-1 px-1">
                  Knowledge Bases
                </div>
                {sortedKbs.map((kb) => {
                  const isSelected = selectedKbIds.has(kb.id);
                  const connectors = kb.connectors ?? [];
                  const connectorTypes = [
                    ...new Set(connectors.map((c) => c.connectorType)),
                  ];
                  return (
                    <button
                      key={kb.id}
                      type="button"
                      onClick={() => handleToggleKb(kb.id)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors cursor-pointer",
                        isSelected
                          ? "border-primary bg-primary/5"
                          : "hover:bg-accent",
                      )}
                    >
                      <Database className="size-4 shrink-0 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {kb.name}
                        </div>
                        {kb.description && (
                          <div className="text-xs text-muted-foreground truncate">
                            {kb.description}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {connectorTypes.length > 0 && (
                          <OverlappedIcons
                            icons={connectorTypes.map((type) => ({
                              key: type,
                              icon: (
                                <ConnectorTypeIcon
                                  type={type}
                                  className="h-full w-full"
                                />
                              ),
                              tooltip: type,
                            }))}
                            maxVisible={3}
                            size="sm"
                          />
                        )}
                        {isSelected && (
                          <Check className="size-4 text-primary" />
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {sortedConnectors.length > 0 && (
              <div className="space-y-1">
                {sortedKbs.length > 0 && (
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider pt-3 pb-1 px-1">
                    Connectors
                  </div>
                )}
                {sortedConnectors.map((connector) => {
                  const isSelected = selectedConnectorIds.has(connector.id);
                  return (
                    <button
                      key={connector.id}
                      type="button"
                      onClick={() => handleToggleConnector(connector.id)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors cursor-pointer",
                        isSelected
                          ? "border-primary bg-primary/5"
                          : "hover:bg-accent",
                      )}
                    >
                      <ConnectorTypeIcon
                        type={connector.connectorType}
                        className="h-4 w-4 shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {connector.name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {connector.description || connector.connectorType}
                        </div>
                      </div>
                      {isSelected && (
                        <Check className="size-4 text-primary shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {sortedKbs.length === 0 && sortedConnectors.length === 0 && (
              <div className="text-center py-8 text-sm text-muted-foreground">
                No knowledge sources match your search
              </div>
            )}
          </div>
        </>
      )}
    </div>
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
  connectorTypes = [],
  showAddButton = false,
  onAdd,
}: {
  catalogs: CatalogItem[];
  subagents?: SubagentItem[];
  connectorTypes?: string[];
  showAddButton?: boolean;
  onAdd?: () => void;
}) {
  const hasNonBuiltInTools =
    subagents.length > 0 || catalogs.some((c) => !isBuiltInCatalogId(c.id));
  const totalCount = catalogs.length + subagents.length + connectorTypes.length;

  if (totalCount === 0) {
    if (!showAddButton) return null;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: nested inside parent button */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: parent button handles keyboard */}
          <div
            className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted ml-1 hover:bg-muted/80 transition-colors cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              onAdd?.();
            }}
          >
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

  // Build custom overflow tooltip (showing up to 5 names)
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
            {/* biome-ignore lint/a11y/noStaticElementInteractions: nested inside parent button */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: parent button handles keyboard */}
            <div
              className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted ring-1 ring-background ml-0.5 hover:bg-muted/80 transition-colors cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                onAdd?.();
              }}
            >
              <Plus className="size-3 text-muted-foreground" />
            </div>
          </TooltipTrigger>
          <TooltipContent side="top">Add tools</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
