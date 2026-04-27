"use client";

import {
  type AgentScope,
  type AgentType,
  archestraApiSdk,
  type archestraApiTypes,
  BLOCKED_PASSTHROUGH_HEADERS,
  BUILT_IN_AGENT_DEFAULT_SYSTEM_PROMPTS,
  BUILT_IN_AGENT_IDS,
  DocsPage,
  E2eTestId,
  getDocsUrl,
  getResourceForAgentType,
  HEADER_NAME_REGEX,
  MAX_PASSTHROUGH_HEADERS,
  MAX_SUGGESTED_PROMPT_TEXT_LENGTH,
  MAX_SUGGESTED_PROMPT_TITLE_LENGTH,
  MAX_SUGGESTED_PROMPTS,
  providerDisplayNames,
  type SupportedProvider,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@shared";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  Building2,
  CheckIcon,
  ChevronDown,
  ChevronRight,
  Globe,
  Key,
  Loader2,
  Plus,
  RotateCcw,
  User,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { AgentBadge } from "@/components/agent-badge";
import type { AgentIconVariant } from "@/components/agent-icon";
import { AgentIconPicker } from "@/components/agent-icon-picker";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import {
  AgentToolsEditor,
  type AgentToolsEditorRef,
} from "@/components/agent-tools-editor";
import { ModelSelector } from "@/components/chat/model-selector";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  formatPermissionRequirement,
  PermissionRequirementHint,
} from "@/components/permission-requirement-hint";
import { SystemPromptEditor } from "@/components/system-prompt-editor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AssignmentCombobox,
  type AssignmentComboboxItem,
} from "@/components/ui/assignment-combobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogForm,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExpandableText } from "@/components/ui/expandable-text";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { OverlappedIcons } from "@/components/ui/overlapped-icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  VisibilitySelector as SharedVisibilitySelector,
  type VisibilityOption,
} from "@/components/visibility-selector";
import {
  useCreateProfile,
  useDeleteProfile,
  useInternalAgents,
  useProfile,
  useUpdateProfile,
} from "@/lib/agent.query";
import {
  useAgentDelegations,
  useSyncAgentDelegations,
} from "@/lib/agent-tools.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useChatProfileMcpTools } from "@/lib/chat/chat.query";
import config from "@/lib/config/config";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useConnectors } from "@/lib/knowledge/connector.query";
import { useKnowledgeBases } from "@/lib/knowledge/knowledge-base.query";
import { useLlmModelsByProvider } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { cn } from "@/lib/utils";
import {
  getDescriptionPlaceholder,
  getNamePlaceholder,
  normalizeSuggestedPrompts,
  shouldShowDescriptionField,
} from "./agent-dialog.utils";

const { useIdentityProviders } = config.enterpriseFeatures.core
  ? // biome-ignore lint/style/noRestrictedImports: conditional EE query import for IdP selector
    await import("@/lib/auth/identity-provider.query.ee")
  : {
      useIdentityProviders: (_params?: { enabled?: boolean }) => ({
        data: [] as Array<{ id: string; providerId: string; issuer: string }>,
      }),
    };

type Agent = archestraApiTypes.GetAllAgentsResponses["200"][number];
type ToolExposureMode = Agent["toolExposureMode"];

// Component to display tools for a specific agent
function AgentToolsList({ agentId }: { agentId: string }) {
  const { data: tools = [], isLoading } = useChatProfileMcpTools(agentId);

  if (isLoading) {
    return <p className="text-xs text-muted-foreground">Loading tools...</p>;
  }

  if (tools.length === 0) {
    return <p className="text-xs text-muted-foreground">No tools available</p>;
  }

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground mb-2">
        Available tools ({tools.length}):
      </p>
      <div className="flex flex-wrap gap-1 max-h-[200px] overflow-y-auto">
        {tools.map((tool) => (
          <span
            key={tool.name}
            className="inline-flex items-center gap-1 text-xs bg-muted px-2 py-0.5 rounded"
          >
            {tool.name}
          </span>
        ))}
      </div>
    </div>
  );
}

// Single subagent pill with popover
interface SubagentPillProps {
  agent: Agent;
  isSelected: boolean;
  onToggle: (agentId: string) => void;
}

function SubagentPill({ agent, isSelected, onToggle }: SubagentPillProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <div className="flex items-center">
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "h-8 px-3 gap-1.5 text-xs max-w-[200px] rounded-r-none border-r-0",
              !isSelected && "border-dashed opacity-50",
            )}
          >
            {isSelected && (
              <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
            )}
            <Bot className="h-3 w-3 shrink-0" />
            <span className="font-medium truncate">{agent.name}</span>
          </Button>
        </PopoverTrigger>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-7 p-0 rounded-l-none text-muted-foreground hover:text-destructive"
          onClick={() => onToggle(agent.id)}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      <PopoverContent
        className="w-[350px] p-0"
        side="bottom"
        align="start"
        sideOffset={8}
        avoidCollisions
      >
        <div className="p-4 border-b flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h4 className="font-semibold truncate">{agent.name}</h4>
            {agent.description && (
              <ExpandableText
                text={agent.description}
                maxLines={2}
                className="text-sm text-muted-foreground mt-1"
              />
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 shrink-0"
            onClick={() => setOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-4">
          <AgentToolsList agentId={agent.id} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Component to edit subagents (delegations)
interface SubagentsEditorProps {
  availableAgents: Agent[];
  selectedAgentIds: string[];
  onSelectionChange: (ids: string[]) => void;
  currentAgentId?: string;
}

function SubagentsEditor({
  availableAgents,
  selectedAgentIds,
  onSelectionChange,
  currentAgentId,
}: SubagentsEditorProps) {
  // Filter out current agent from available agents
  const filteredAgents = availableAgents.filter((a) => a.id !== currentAgentId);

  const handleToggle = (agentId: string) => {
    if (selectedAgentIds.includes(agentId)) {
      onSelectionChange(selectedAgentIds.filter((id) => id !== agentId));
    } else {
      onSelectionChange([...selectedAgentIds, agentId]);
    }
  };

  const comboboxItems: AssignmentComboboxItem[] = filteredAgents.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description || undefined,
  }));

  const selectedAgents = filteredAgents.filter((a) =>
    selectedAgentIds.includes(a.id),
  );

  return (
    <div className="flex flex-wrap gap-2">
      {selectedAgents.map((agent) => (
        <SubagentPill
          key={agent.id}
          agent={agent}
          isSelected={true}
          onToggle={handleToggle}
        />
      ))}
      <AssignmentCombobox
        items={comboboxItems}
        selectedIds={selectedAgentIds}
        onToggle={handleToggle}
        placeholder="Search agents..."
        emptyMessage="No agents found."
        createAction={{
          label: "Create a New Agent",
          href: "/agents?create=true",
        }}
      />
    </div>
  );
}

// Helper functions for type-specific UI text
function getDialogTitle(agentType: AgentType, isEdit: boolean): string {
  const titles: Record<string, { create: string; edit: string }> = {
    agent: { create: "Create Agent", edit: "Edit Agent" },
    mcp_gateway: { create: "Create MCP Gateway", edit: "Edit MCP Gateway" },
    llm_proxy: { create: "Create LLM Proxy", edit: "Edit LLM Proxy" },
    profile: { create: "Create Profile", edit: "Edit Profile" },
  };
  return isEdit ? titles[agentType].edit : titles[agentType].create;
}

function getSuccessMessage(agentType: AgentType, isUpdate: boolean): string {
  const messages: Record<string, { create: string; update: string }> = {
    mcp_gateway: {
      create: "MCP Gateway created successfully",
      update: "MCP Gateway updated successfully",
    },
    llm_proxy: {
      create: "LLM Proxy created successfully",
      update: "LLM Proxy updated successfully",
    },
    agent: {
      create: "Agent created successfully",
      update: "Agent updated successfully",
    },
    profile: {
      create: "Profile created successfully",
      update: "Profile updated successfully",
    },
  };
  return isUpdate ? messages[agentType].update : messages[agentType].create;
}

const agentTypeDisplayName: Record<string, string> = {
  agent: "agent",
  mcp_gateway: "MCP Gateway",
  llm_proxy: "LLM Proxy",
  profile: "profile",
};

function getScopeOptions(agentType: string) {
  const name = agentTypeDisplayName[agentType] || "agent";
  return [
    {
      value: "personal" as const,
      label: "Personal",
      description: `Only you can access this ${name}`,
      icon: User,
    },
    {
      value: "team" as const,
      label: "Teams",
      description: `Share ${name} with selected teams`,
      icon: Users,
    },
    {
      value: "org" as const,
      label: "Organization",
      description: `Anyone in your org can access this ${name}`,
      icon: Globe,
    },
  ];
}

function AccessLevelSelector({
  scope,
  onScopeChange,
  isAdmin,
  isTeamAdmin,
  canReadTeams,
  initialScope,
  agentType,
  teams,
  assignedTeamIds,
  onTeamIdsChange,
  hasNoAvailableTeams,
  showTeamRequired,
}: {
  scope: AgentScope;
  onScopeChange: (scope: AgentScope) => void;
  isAdmin: boolean;
  isTeamAdmin: boolean;
  canReadTeams: boolean;
  initialScope?: AgentScope;
  agentType: AgentType;
  teams: Array<{ id: string; name: string }> | undefined;
  assignedTeamIds: string[];
  onTeamIdsChange: (ids: string[]) => void;
  hasNoAvailableTeams: boolean;
  showTeamRequired: boolean;
}) {
  const scopeOptions = getScopeOptions(agentType);
  const canShareWithTeams = isAdmin || isTeamAdmin;

  const isOptionDisabled = (value: string) => {
    if (value === "personal" && initialScope && initialScope !== "personal")
      return true;
    if (value === "team" && (!canShareWithTeams || !canReadTeams)) return true;
    if (value === "org" && !isAdmin) return true;
    return false;
  };

  const resourceMap: Record<string, string> = {
    agent: "agent",
    mcp_gateway: "mcpGateway",
    llm_proxy: "llmProxy",
    profile: "agent",
  };
  const resourceName = resourceMap[agentType] || "agent";

  const getDisabledReason = (value: string) => {
    if (value === "personal" && initialScope && initialScope !== "personal")
      return "Shared agents cannot be made personal";
    if (value === "team" && !canReadTeams)
      return `Team sharing is unavailable without ${formatPermissionRequirement({ resource: "team", action: "read" })}`;
    if (value === "team" && !canShareWithTeams)
      return `You need ${resourceName}:team-admin permission to share with teams`;
    if (value === "org" && !isAdmin)
      return `You need ${resourceName}:admin permission to make this available org-wide`;
    return "";
  };

  const options: VisibilityOption<AgentScope>[] = scopeOptions.map(
    (option) => ({
      ...option,
      disabled: isOptionDisabled(option.value),
      disabledReason: isOptionDisabled(option.value)
        ? getDisabledReason(option.value)
        : undefined,
    }),
  );

  return (
    <SharedVisibilitySelector
      heading={`Who can use this ${agentTypeDisplayName[agentType] || "agent"}`}
      value={scope}
      options={options}
      onValueChange={onScopeChange}
    >
      {scope === "team" && (
        <div className="space-y-2">
          <Label>Teams{showTeamRequired && " *"}</Label>
          <MultiSelectCombobox
            disabled={
              !canShareWithTeams || hasNoAvailableTeams || !canReadTeams
            }
            options={
              teams?.map((team) => ({
                value: team.id,
                label: team.name,
              })) || []
            }
            value={assignedTeamIds}
            onChange={onTeamIdsChange}
            placeholder={
              !canReadTeams
                ? "Teams unavailable"
                : hasNoAvailableTeams
                  ? "No teams available"
                  : "Search teams..."
            }
            emptyMessage="No teams found."
          />
          {!canReadTeams && (
            <PermissionRequirementHint
              message="Team selection is unavailable without"
              permissions={[{ resource: "team", action: "read" }]}
            />
          )}
        </div>
      )}
    </SharedVisibilitySelector>
  );
}

interface AgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Agent to edit. If null/undefined, creates a new agent */
  agent?: Agent | null;
  /** Agent type: 'agent' for internal agents with prompts, 'profile' for external profiles */
  agentType?: AgentType;
  defaultIconType?: AgentIconVariant;
  /** Callback when a new agent/profile is created (not called for updates) */
  onCreated?: (created: { id: string; name: string }) => void;
  /** When true, all fields are disabled and the save button is hidden */
  readOnly?: boolean;
}

export function AgentDialog({
  open,
  onOpenChange,
  agent,
  agentType = "profile",
  defaultIconType = "agent",
  onCreated,
  readOnly = false,
}: AgentDialogProps) {
  const appName = useAppName();
  const shouldLoadInternalAgents = open && agentType !== "llm_proxy";
  const shouldLoadIdentityProviders =
    open && (agentType === "mcp_gateway" || agentType === "llm_proxy");
  const shouldLoadKnowledgeSources = open;
  const shouldLoadLlmConfiguration = open && agentType === "agent";
  const { data: canReadAgents } = useHasPermissions({ agent: ["read"] });

  const { data: allInternalAgents = [] } = useInternalAgents({
    enabled: shouldLoadInternalAgents && !!canReadAgents,
  });
  const createAgent = useCreateProfile();
  const deleteAgent = useDeleteProfile();
  const updateAgent = useUpdateProfile();
  const syncDelegations = useSyncAgentDelegations();
  const { data: currentDelegations = [] } = useAgentDelegations(
    agentType !== "llm_proxy" ? agent?.id : undefined,
  );
  const { data: canReadIdentityProviders } = useHasPermissions({
    identityProvider: ["read"],
  });
  const { data: canReadKnowledgeBase } = useHasPermissions({
    knowledgeSource: ["read"],
  });
  const { data: canReadLlmProviderApiKeys } = useHasPermissions({
    llmProviderApiKey: ["read"],
  });
  const { data: canReadLlmModels } = useHasPermissions({
    llmModel: ["read"],
  });
  const cannotReadLlmConfiguration =
    !canReadLlmProviderApiKeys && !canReadLlmModels;
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: identityProviders = [] } = useIdentityProviders({
    enabled: shouldLoadIdentityProviders && !!canReadIdentityProviders,
  });
  const { data: knowledgeBasesData } = useKnowledgeBases({
    enabled: shouldLoadKnowledgeSources && !!canReadKnowledgeBase,
  });
  const knowledgeBases = knowledgeBasesData ?? [];
  const { data: connectorsData } = useConnectors({
    enabled: shouldLoadKnowledgeSources && !!canReadKnowledgeBase,
  });
  const connectors = connectorsData ?? [];
  const agentLlmApiKeyId = agent?.llmApiKeyId;
  const { data: availableApiKeys = [] } = useAvailableLlmProviderApiKeys({
    includeKeyId: agentLlmApiKeyId ?? undefined,
    enabled: shouldLoadLlmConfiguration && !!canReadLlmProviderApiKeys,
  });
  const { modelsByProvider } = useLlmModelsByProvider({
    enabled: shouldLoadLlmConfiguration && !!canReadLlmModels,
  });

  // Fetch fresh agent data when dialog opens
  const { data: freshAgent, refetch: refetchAgent } = useProfile(agent?.id);
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const response = await archestraApiSdk.getTeams({
        query: { limit: 100, offset: 0 },
      });
      return response.data?.data ?? [];
    },
    enabled: open && !!canReadTeams,
  });
  const resource = getResourceForAgentType(agentType);
  const { data: isAdmin } = useHasPermissions({
    [resource]: ["admin"],
  });
  const { data: isTeamAdmin } = useHasPermissions({
    [resource]: ["team-admin"],
  });
  const agentLabelsRef = useRef<ProfileLabelsRef>(null);
  const agentToolsEditorRef = useRef<AgentToolsEditorRef>(null);

  // Form state
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [suggestedPrompts, setSuggestedPrompts] = useState<
    Array<{ summaryTitle: string; prompt: string }>
  >([]);
  const [suggestedPromptsOpen, setSuggestedPromptsOpen] = useState(false);
  const [selectedDelegationTargetIds, setSelectedDelegationTargetIds] =
    useState<string[]>([]);
  const [assignedTeamIds, setAssignedTeamIds] = useState<string[]>([]);
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const [considerContextUntrusted, setConsiderContextUntrusted] =
    useState(false);
  const [llmApiKeyId, setLlmApiKeyId] = useState<string | null>(null);
  const [llmModel, setLlmModel] = useState<string | null>(null);
  const [apiKeySelectorOpen, setApiKeySelectorOpen] = useState(false);
  const [selectedToolsCount, setSelectedToolsCount] = useState(0);
  const [identityProviderId, setIdentityProviderId] = useState<
    string | null | undefined
  >(undefined);
  const [scope, setScope] = useState<AgentScope>("personal");
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>([]);
  const [connectorIds, setConnectorIds] = useState<string[]>([]);
  const [autoConfigureOnToolDiscovery, setAutoConfigureOnToolDiscovery] =
    useState(false);
  const [dualLlmMaxRounds, setDualLlmMaxRounds] = useState("5");
  const [passthroughHeaders, setPassthroughHeaders] = useState<string[]>([]);
  const [toolExposureMode, setToolExposureMode] =
    useState<ToolExposureMode>("full");
  const [isSaving, setIsSaving] = useState(false);

  // Determine type-specific visibility based on agentType prop
  const isInternalAgent = agentType === "agent";
  const isBuiltIn = !!agent?.builtIn;
  const builtInAgentName = agent?.builtInAgentConfig?.name;
  const isPolicyConfigBuiltIn =
    builtInAgentName === BUILT_IN_AGENT_IDS.POLICY_CONFIG;
  const isDualLlmMainBuiltIn =
    builtInAgentName === BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN;
  const isDualLlmQuarantineBuiltIn =
    builtInAgentName === BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE;
  const _isDualLlmBuiltIn = isDualLlmMainBuiltIn || isDualLlmQuarantineBuiltIn;
  const supportsIdentityProvider =
    agentType === "mcp_gateway" || agentType === "llm_proxy";
  const mcpAuthDocsUrl = getFrontendDocsUrl(DocsPage.McpAuthentication);
  const toolExposureDocsUrl = getDocsUrl(
    agentType === "mcp_gateway"
      ? DocsPage.PlatformMcpGateway
      : DocsPage.PlatformAgents,
    "search-and-run-tool-mode",
  );
  const showPrimarySettingsCard =
    !isBuiltIn ||
    shouldShowDescriptionField({ agentType, isBuiltIn }) ||
    isPolicyConfigBuiltIn ||
    isDualLlmMainBuiltIn;
  const showToolsAndSubagents =
    !isBuiltIn &&
    (agentType === "mcp_gateway" ||
      agentType === "agent" ||
      agentType === "profile");
  const showSecurity =
    !isBuiltIn && (agentType === "llm_proxy" || agentType === "agent");

  // Reset form when dialog opens/closes or agent changes
  useEffect(() => {
    if (open) {
      // Refetch agent data when dialog opens to ensure fresh data
      if (agent?.id) {
        refetchAgent();
      }

      // Use fresh agent data if available, otherwise fall back to prop
      const agentData = freshAgent || agent;

      if (agentData) {
        setName(agentData.name);
        setIcon(agentData.icon);
        setDescription(agentData.description || "");
        setSystemPrompt(agentData.systemPrompt || "");
        setSuggestedPrompts(agentData.suggestedPrompts);
        setSuggestedPromptsOpen(false);
        setLlmApiKeyId(agentData.llmApiKeyId);
        setLlmModel(agentData.llmModel);
        // Reset delegation targets - will be populated by the next useEffect when data loads
        setSelectedDelegationTargetIds([]);
        setAssignedTeamIds(agentData.teams.map((t) => t.id));
        setLabels(agentData.labels);
        setConsiderContextUntrusted(agentData.considerContextUntrusted);
        setIdentityProviderId(agentData.identityProviderId ?? undefined);
        setKnowledgeBaseIds(agentData.knowledgeBaseIds);
        setConnectorIds(agentData.connectorIds);
        setPassthroughHeaders(agentData.passthroughHeaders ?? []);
        setToolExposureMode(agentData.toolExposureMode ?? "full");
        setScope(agentData.scope);
        setAutoConfigureOnToolDiscovery(
          agentData.builtInAgentConfig?.name ===
            BUILT_IN_AGENT_IDS.POLICY_CONFIG
            ? agentData.builtInAgentConfig.autoConfigureOnToolDiscovery
            : false,
        );
        setDualLlmMaxRounds(
          agentData.builtInAgentConfig?.name ===
            BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN
            ? String(agentData.builtInAgentConfig.maxRounds)
            : "5",
        );
      } else {
        // Create mode - reset all fields
        setName("");
        setIcon(null);
        setDescription("");
        setSystemPrompt("");
        setSuggestedPrompts([]);
        setSuggestedPromptsOpen(false);
        setLlmApiKeyId(null);
        setLlmModel(null);
        setSelectedDelegationTargetIds([]);
        setAssignedTeamIds([]);
        setLabels([]);
        setConsiderContextUntrusted(false);
        setIdentityProviderId(undefined);
        setKnowledgeBaseIds([]);
        setConnectorIds([]);
        setScope("personal");
        setPassthroughHeaders([]);
        setToolExposureMode("full");
        setAutoConfigureOnToolDiscovery(false);
        setDualLlmMaxRounds("5");
      }
      // Reset counts when dialog opens
      setSelectedToolsCount(0);
      lastAutoSelectedProviderRef.current = null;
    }
  }, [open, agent, freshAgent, refetchAgent]);

  // Sync selectedDelegationTargetIds with currentDelegations when data loads
  const currentDelegationIds = currentDelegations.map((a) => a.id).join(",");
  const agentId = agent?.id;

  useEffect(() => {
    if (open && agentId && currentDelegationIds) {
      setSelectedDelegationTargetIds(
        currentDelegationIds.split(",").filter(Boolean),
      );
    }
  }, [open, agentId, currentDelegationIds]);

  // LLM Configuration: computed values and bidirectional auto-linking
  // (same reactive pattern as prompt input: LlmProviderApiKeySelector + onProviderChange)
  const selectedApiKey = useMemo(
    () => availableApiKeys.find((k) => k.id === llmApiKeyId),
    [availableApiKeys, llmApiKeyId],
  );

  const apiKeysByProvider = useMemo(() => {
    const grouped: Record<string, typeof availableApiKeys> = {};
    for (const key of availableApiKeys) {
      if (!grouped[key.provider]) grouped[key.provider] = [];
      grouped[key.provider].push(key);
    }
    return grouped;
  }, [availableApiKeys]);

  // Derive provider from selected model (like prompt input's initialProvider/currentProvider)
  const currentLlmProvider = useMemo((): SupportedProvider | null => {
    if (!llmModel) return null;
    for (const [provider, models] of Object.entries(modelsByProvider)) {
      if (models?.some((m) => m.id === llmModel)) {
        return provider as SupportedProvider;
      }
    }
    return null;
  }, [llmModel, modelsByProvider]);

  // Track the provider that was active when auto-selection last ran,
  // so we only auto-select when the provider actually changes (not when the user clears the key).
  const lastAutoSelectedProviderRef = useRef<string | null>(null);

  // Reactive Model → Key: auto-select key when provider changes
  // (mirrors LlmProviderApiKeySelector's auto-select useEffect in prompt input)
  useEffect(() => {
    // Don't auto-select if no model/provider is set
    if (!currentLlmProvider) {
      lastAutoSelectedProviderRef.current = null;
      return;
    }
    // Don't auto-select if no keys available (still loading)
    if (availableApiKeys.length === 0) return;
    // If current key already matches the model's provider, nothing to do
    if (selectedApiKey?.provider === currentLlmProvider) {
      lastAutoSelectedProviderRef.current = currentLlmProvider;
      return;
    }
    // Only auto-select when the provider actually changed (not when user cleared the key)
    if (lastAutoSelectedProviderRef.current === currentLlmProvider) return;

    // Auto-select best key for this provider (personal > team > org)
    const scopePriority = { personal: 0, team: 1, org: 2 } as const;
    const providerKeys = availableApiKeys
      .filter((k) => k.provider === currentLlmProvider)
      .sort(
        (a, b) =>
          (scopePriority[a.scope as keyof typeof scopePriority] ?? 3) -
          (scopePriority[b.scope as keyof typeof scopePriority] ?? 3),
      );

    if (providerKeys.length > 0) {
      setLlmApiKeyId(providerKeys[0].id);
    }
    lastAutoSelectedProviderRef.current = currentLlmProvider;
  }, [currentLlmProvider, availableApiKeys, selectedApiKey]);

  // Model change handler - just sets model, key auto-selection is reactive via useEffect above
  const handleLlmModelChange = useCallback((modelId: string | null) => {
    setLlmModel(modelId);
    // Reset auto-select tracking so provider change triggers key selection
    lastAutoSelectedProviderRef.current = null;
  }, []);

  // Key change handler - imperatively auto-selects model (like prompt input's onProviderChange)
  const handleLlmApiKeyChange = useCallback(
    (keyId: string | null) => {
      setLlmApiKeyId(keyId);
      if (!keyId) return;

      const key = availableApiKeys.find((k) => k.id === keyId);
      if (!key) return;

      // Auto-select model: always prefer bestModelId, fall back to first model when switching providers
      const bestModelId = key.bestModelId;
      if (bestModelId) {
        setLlmModel(bestModelId);
      } else if (currentLlmProvider !== key.provider) {
        // Only fall back to first model when switching providers (no bestModelId available)
        const providerModels = modelsByProvider[key.provider];
        if (providerModels?.length) {
          setLlmModel(providerModels[0].id);
        }
      }
    },
    [availableApiKeys, currentLlmProvider, modelsByProvider],
  );

  // Non-admin users must select at least one team for team-scoped resources
  const requiresTeamSelection =
    !isAdmin && scope === "team" && assignedTeamIds.length === 0;
  const hasNoAvailableTeams = !teams || teams.length === 0;

  const handleSave = useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedSystemPrompt = systemPrompt.trim();
    const parsedDualLlmMaxRounds = Number.parseInt(dualLlmMaxRounds, 10);

    if (!trimmedName) {
      toast.error("Name is required");
      return;
    }

    // Non-admin users must select at least one team for team-scoped resources
    if (!isAdmin && scope === "team" && assignedTeamIds.length === 0) {
      toast.error("Please select at least one team");
      return;
    }

    if (
      isDualLlmMainBuiltIn &&
      (!Number.isInteger(parsedDualLlmMaxRounds) ||
        parsedDualLlmMaxRounds < 1 ||
        parsedDualLlmMaxRounds > 20)
    ) {
      toast.error("Max rounds must be an integer between 1 and 20");
      return;
    }

    // Save any unsaved label before submitting
    const updatedLabels = agentLabelsRef.current?.saveUnsavedLabel() || labels;

    const validSuggestedPrompts = normalizeSuggestedPrompts(suggestedPrompts);
    const normalizedDescription = shouldShowDescriptionField({
      agentType,
      isBuiltIn,
    })
      ? description.trim() || null
      : undefined;

    setIsSaving(true);

    try {
      let savedAgentId: string;

      // Save tool changes FIRST (before agent update triggers refetch that clears pending changes)
      // Skip for built-in agents as they don't have editable tools
      if (agent && !isBuiltIn) {
        await agentToolsEditorRef.current?.saveChanges({
          resourceLabel: agentTypeDisplayName[agentType] || "resource",
        });
      }

      if (agent && isBuiltIn) {
        const builtInAgentConfig = isPolicyConfigBuiltIn
          ? {
              name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
              autoConfigureOnToolDiscovery,
            }
          : isDualLlmMainBuiltIn
            ? {
                name: BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
                maxRounds: parsedDualLlmMaxRounds,
              }
            : {
                name: BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE,
              };

        const updated = await updateAgent.mutateAsync({
          id: agent.id,
          data: {
            builtInAgentConfig,
            systemPrompt: trimmedSystemPrompt || null,
            llmApiKeyId: llmApiKeyId || null,
            llmModel: llmModel || null,
          },
        });
        savedAgentId = updated?.id ?? agent.id;
        if (updated?.id) {
          toast.success("Built-in agent updated successfully");
        }
      } else if (agent) {
        // Update existing agent
        const updated = await updateAgent.mutateAsync({
          id: agent.id,
          data: {
            name: trimmedName,
            icon: icon || null,
            agentType: agentType,
            ...(normalizedDescription !== undefined && {
              description: normalizedDescription,
            }),
            ...(isInternalAgent && {
              systemPrompt: trimmedSystemPrompt || null,
              llmApiKeyId: llmApiKeyId || null,
              llmModel: llmModel || null,
              suggestedPrompts: validSuggestedPrompts,
            }),
            ...(supportsIdentityProvider && {
              identityProviderId: identityProviderId || null,
            }),
            ...(agentType !== "llm_proxy" && {
              knowledgeBaseIds: knowledgeBaseIds,
              connectorIds: connectorIds,
              toolExposureMode,
            }),
            teams: assignedTeamIds,
            labels: updatedLabels,
            scope,
            ...(showSecurity && { considerContextUntrusted }),
            ...(agentType === "mcp_gateway" && {
              passthroughHeaders:
                passthroughHeaders.length > 0 ? passthroughHeaders : null,
            }),
          },
        });
        savedAgentId = updated?.id ?? agent.id;
        if (updated?.id) {
          toast.success(getSuccessMessage(agentType, true));
        }
      } else {
        // Create new agent
        const created = await createAgent.mutateAsync({
          name: trimmedName,
          icon: icon || null,
          agentType: agentType,
          ...(normalizedDescription !== undefined && {
            description: normalizedDescription,
          }),
          ...(isInternalAgent && {
            systemPrompt: trimmedSystemPrompt || null,
            llmApiKeyId: llmApiKeyId || null,
            llmModel: llmModel || null,
            suggestedPrompts: validSuggestedPrompts,
          }),
          ...(supportsIdentityProvider && {
            identityProviderId: identityProviderId || null,
          }),
          ...(agentType !== "llm_proxy" && {
            knowledgeBaseIds: knowledgeBaseIds,
            connectorIds: connectorIds,
            toolExposureMode,
          }),
          teams: assignedTeamIds,
          labels: updatedLabels,
          scope,
          ...(showSecurity && { considerContextUntrusted }),
          ...(agentType === "mcp_gateway" && {
            passthroughHeaders:
              passthroughHeaders.length > 0 ? passthroughHeaders : null,
          }),
        });
        if (!created) return;
        savedAgentId = created?.id ?? "";

        // Save tool changes with the new agent ID
        if (savedAgentId) {
          try {
            await agentToolsEditorRef.current?.saveChanges({
              agentId: savedAgentId,
              resourceLabel: agentTypeDisplayName[agentType] || "resource",
            });
          } catch (error) {
            await deleteAgent.mutateAsync(savedAgentId);
            toast.error(
              error instanceof Error && error.message
                ? error.message
                : `Failed to save ${agentTypeDisplayName[agentType] || "resource"}`,
            );
            return;
          }
        }

        toast.success(getSuccessMessage(agentType, false));
        // Notify parent about creation (for opening connection dialog, etc.)
        if (onCreated && created) {
          onCreated({ id: created.id, name: created.name });
        }
      }

      // Sync delegations (skip for built-in agents)
      if (
        !isBuiltIn &&
        savedAgentId &&
        selectedDelegationTargetIds.length > 0
      ) {
        await syncDelegations.mutateAsync({
          agentId: savedAgentId,
          targetAgentIds: selectedDelegationTargetIds,
        });
      } else if (savedAgentId && agent && currentDelegations.length > 0) {
        // Clear delegations if none selected but there were some before
        await syncDelegations.mutateAsync({
          agentId: savedAgentId,
          targetAgentIds: [],
        });
      }

      // Close dialog on success
      onOpenChange(false);
    } catch (_error) {
      toast.error(
        `Failed to save ${agentTypeDisplayName[agentType] || "resource"}`,
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    name,
    icon,
    description,
    systemPrompt,
    suggestedPrompts,
    assignedTeamIds,
    labels,
    considerContextUntrusted,
    llmApiKeyId,
    llmModel,
    identityProviderId,
    knowledgeBaseIds,
    connectorIds,
    scope,
    agentType,
    agent,
    isBuiltIn,
    autoConfigureOnToolDiscovery,
    dualLlmMaxRounds,
    isDualLlmMainBuiltIn,
    isInternalAgent,
    isPolicyConfigBuiltIn,
    showSecurity,
    isAdmin,
    selectedDelegationTargetIds,
    currentDelegations.length,
    updateAgent,
    createAgent,
    syncDelegations,
    onCreated,
    onOpenChange,
    supportsIdentityProvider,
    passthroughHeaders,
    deleteAgent,
    toolExposureMode,
  ]);

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <div className="flex items-start justify-between gap-4 pr-6">
            <div className="min-w-0 flex-1">
              <DialogTitle className="flex items-center gap-2">
                {readOnly
                  ? `View ${agent?.name ?? "Agent"}`
                  : isBuiltIn
                    ? `Edit ${agent?.name ?? "Built-In Agent"}`
                    : getDialogTitle(agentType, !!agent)}
                {!isBuiltIn && (
                  <AgentBadge type={scope} className="font-normal" />
                )}
              </DialogTitle>
              {isBuiltIn && agent?.description && (
                <p className="pt-2 text-sm text-muted-foreground">
                  {agent.description}.{" "}
                  <ExternalDocsLink
                    href={getDocsUrl(
                      DocsPage.PlatformBuiltInAgentsPolicyConfig,
                    )}
                    className="underline"
                    showIcon={false}
                  >
                    Learn more
                  </ExternalDocsLink>
                </p>
              )}
            </div>
            {agent?.createdAt &&
              (() => {
                const createdBy = agent.authorName ?? appName;
                return (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground font-normal whitespace-nowrap">
                    <div className="h-5 w-5 rounded-full bg-green-500 flex items-center justify-center text-[10px] font-medium text-white shrink-0">
                      {createdBy.charAt(0).toUpperCase()}
                    </div>
                    <span>
                      Created by {createdBy} on{" "}
                      {new Date(agent.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                );
              })()}
          </div>
        </DialogHeader>

        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={handleSave}
        >
          <fieldset disabled={readOnly} className="contents">
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-4 space-y-4">
              {agentType === "profile" && (
                <Alert variant="warning">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    This is a legacy entity that works both as MCP Gateway and
                    LLM Proxy. It appears on both tables and shares Name, Team,
                    and Labels.
                  </AlertDescription>
                </Alert>
              )}

              {/* Section 1: Name, Description, Visibility, LLM Configuration */}
              {showPrimarySettingsCard && (
                <div className="rounded-lg border bg-card p-4 space-y-4">
                  {/* Name + Icon (hidden for built-in agents, shown in dialog title) */}
                  {!isBuiltIn && (
                    <div className="space-y-4">
                      <AgentIconPicker
                        value={icon}
                        onChange={setIcon}
                        fallbackType={defaultIconType}
                      />
                      <div className="space-y-2">
                        <Label htmlFor="agentName">Name *</Label>
                        <Input
                          id="agentName"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder={getNamePlaceholder(agentType)}
                          autoFocus
                        />
                      </div>
                    </div>
                  )}

                  {/* Description (hidden for built-in agents) */}
                  {shouldShowDescriptionField({ agentType, isBuiltIn }) && (
                    <div className="space-y-2">
                      <Label htmlFor="agentDescription">Description</Label>
                      <Textarea
                        id="agentDescription"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder={getDescriptionPlaceholder(agentType)}
                        className="min-h-[60px]"
                      />
                    </div>
                  )}

                  {/* Built-in agent config */}
                  {isPolicyConfigBuiltIn && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                          <Label
                            htmlFor="auto-configure-on-tool-discovery"
                            className="text-sm font-medium cursor-pointer"
                          >
                            Auto-configure on tool discovery
                          </Label>
                          <p className="text-sm text-muted-foreground">
                            Automatically analyze and configure security
                            policies when tools are discovered
                          </p>
                        </div>
                        <Switch
                          id="auto-configure-on-tool-discovery"
                          checked={autoConfigureOnToolDiscovery}
                          onCheckedChange={setAutoConfigureOnToolDiscovery}
                        />
                      </div>
                    </div>
                  )}

                  {isDualLlmMainBuiltIn && (
                    <div className="space-y-2">
                      <Label htmlFor="dual-llm-max-rounds">Max rounds</Label>
                      <Input
                        id="dual-llm-max-rounds"
                        type="number"
                        min={1}
                        max={20}
                        value={dualLlmMaxRounds}
                        onChange={(e) => setDualLlmMaxRounds(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Section 2: Instruction (Agent only) */}
              {isInternalAgent && (
                <div className="rounded-lg border bg-card p-4">
                  <SystemPromptEditor
                    value={systemPrompt}
                    onChange={setSystemPrompt}
                    variant="section"
                    builtInAgentId={builtInAgentName}
                    headerExtra={
                      isBuiltIn && builtInAgentName ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          disabled={
                            systemPrompt ===
                            (BUILT_IN_AGENT_DEFAULT_SYSTEM_PROMPTS[
                              builtInAgentName
                            ] ?? "")
                          }
                          onClick={() =>
                            setSystemPrompt(
                              BUILT_IN_AGENT_DEFAULT_SYSTEM_PROMPTS[
                                builtInAgentName
                              ] ?? "",
                            )
                          }
                        >
                          <RotateCcw className="size-4" />
                          Reset to Default
                        </Button>
                      ) : undefined
                    }
                  />
                </div>
              )}

              {/* Suggested Prompts (Agent only, not built-in, collapsible) */}
              {isInternalAgent && !isBuiltIn && (
                <Collapsible
                  open={suggestedPromptsOpen}
                  onOpenChange={setSuggestedPromptsOpen}
                  className="group"
                >
                  <div className="rounded-lg border bg-card">
                    {suggestedPrompts.length > 0 ? (
                      <CollapsibleTrigger className="flex w-full items-center justify-between p-4 transition-colors [&:hover:not(:has(button:hover))]:bg-muted/50 [&[data-state=open]>div>svg]:rotate-90">
                        <div className="text-left">
                          <h3 className="text-sm font-semibold">
                            Suggested Prompts
                            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                              ({suggestedPrompts.length})
                            </span>
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            Shown to users when starting a new chat. Max{" "}
                            {MAX_SUGGESTED_PROMPTS} prompts, title max{" "}
                            {MAX_SUGGESTED_PROMPT_TITLE_LENGTH} chars, prompt
                            max {MAX_SUGGESTED_PROMPT_TEXT_LENGTH} chars.
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {suggestedPromptsOpen && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      disabled={
                                        suggestedPrompts.length >=
                                        MAX_SUGGESTED_PROMPTS
                                      }
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setSuggestedPrompts((prev) => [
                                          ...prev,
                                          { summaryTitle: "", prompt: "" },
                                        ]);
                                      }}
                                    >
                                      <Plus className="h-4 w-4 mr-1" />
                                      Add
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                                {suggestedPrompts.length >=
                                  MAX_SUGGESTED_PROMPTS && (
                                  <TooltipContent>
                                    Maximum of {MAX_SUGGESTED_PROMPTS} suggested
                                    prompts reached
                                  </TooltipContent>
                                )}
                              </Tooltip>
                            </TooltipProvider>
                          )}
                          <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform" />
                        </div>
                      </CollapsibleTrigger>
                    ) : (
                      <div className="flex items-center justify-between p-4">
                        <div>
                          <h3 className="text-sm font-semibold">
                            Suggested Prompts
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            Shown to users when starting a new chat. Max{" "}
                            {MAX_SUGGESTED_PROMPTS} prompts, title max{" "}
                            {MAX_SUGGESTED_PROMPT_TITLE_LENGTH} chars, prompt
                            max {MAX_SUGGESTED_PROMPT_TEXT_LENGTH} chars.
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setSuggestedPrompts([
                              { summaryTitle: "", prompt: "" },
                            ]);
                            setSuggestedPromptsOpen(true);
                          }}
                        >
                          <Plus className="h-4 w-4 mr-1" />
                          Add
                        </Button>
                      </div>
                    )}
                    <CollapsibleContent>
                      <div className="border-t p-4 space-y-4">
                        {suggestedPrompts.map((sp, index) => (
                          <div
                            // biome-ignore lint/suspicious/noArrayIndexKey: items have no stable ID
                            key={`sp-${index}`}
                            className="space-y-2 rounded-md border p-3 relative"
                          >
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="absolute top-2 right-2 h-6 w-6"
                              onClick={() => {
                                setSuggestedPrompts((prev) => {
                                  const next = prev.filter(
                                    (_, i) => i !== index,
                                  );
                                  if (next.length === 0)
                                    setSuggestedPromptsOpen(false);
                                  return next;
                                });
                              }}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                            <div className="space-y-1 pr-8">
                              <Label className="text-xs">Button Label</Label>
                              <Input
                                value={sp.summaryTitle}
                                onChange={(e) =>
                                  setSuggestedPrompts((prev) =>
                                    prev.map((p, i) =>
                                      i === index
                                        ? {
                                            ...p,
                                            summaryTitle: e.target.value,
                                          }
                                        : p,
                                    ),
                                  )
                                }
                                placeholder="e.g. Summarize recent changes"
                                maxLength={MAX_SUGGESTED_PROMPT_TITLE_LENGTH}
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Prompt</Label>
                              <Textarea
                                value={sp.prompt}
                                onChange={(e) =>
                                  setSuggestedPrompts((prev) =>
                                    prev.map((p, i) =>
                                      i === index
                                        ? { ...p, prompt: e.target.value }
                                        : p,
                                    ),
                                  )
                                }
                                placeholder="The full prompt sent when clicked"
                                className="min-h-[60px]"
                                maxLength={MAX_SUGGESTED_PROMPT_TEXT_LENGTH}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </CollapsibleContent>
                  </div>
                </Collapsible>
              )}

              {/* Section 3: Capabilities (Tools, Subagents, Knowledge Sources) */}
              {showToolsAndSubagents && (
                <div
                  className="rounded-lg border bg-card p-4 space-y-4"
                  data-testid={E2eTestId.AgentCapabilitiesSection}
                >
                  <h3 className="text-sm font-semibold">Capabilities</h3>

                  {/* Tools */}
                  <div className="space-y-2">
                    <Label>Tools ({selectedToolsCount})</Label>
                    {!agent && selectedToolsCount > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Some recommended {appName} MCP tools are pre-selected
                        for you
                      </p>
                    )}
                    <AgentToolsEditor
                      ref={agentToolsEditorRef}
                      agentId={agent?.id}
                      assignmentScope={scope}
                      assignmentTeamIds={assignedTeamIds}
                      onSelectedCountChange={setSelectedToolsCount}
                    />
                  </div>

                  {/* Subagents */}
                  <div className="space-y-2">
                    <Label>
                      Subagents ({selectedDelegationTargetIds.length})
                    </Label>
                    <SubagentsEditor
                      availableAgents={allInternalAgents}
                      selectedAgentIds={selectedDelegationTargetIds}
                      onSelectionChange={setSelectedDelegationTargetIds}
                      currentAgentId={agent?.id}
                    />
                  </div>

                  <div className="rounded-md border p-3 space-y-2">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        id="search-and-run-tool-mode"
                        checked={toolExposureMode === "search_and_run_only"}
                        onCheckedChange={(checked) =>
                          setToolExposureMode(
                            checked ? "search_and_run_only" : "full",
                          )
                        }
                        className="mt-0.5"
                      />
                      <div className="space-y-1">
                        <Label
                          htmlFor="search-and-run-tool-mode"
                          className="font-medium"
                        >
                          Search-and-run tool mode
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          Expose only{" "}
                          <code>{TOOL_SEARCH_TOOLS_SHORT_NAME}</code> and{" "}
                          <code>{TOOL_RUN_TOOL_SHORT_NAME}</code> in MCP{" "}
                          <code>tools/list</code>; assigned tools stay
                          searchable and runnable.{" "}
                          <ExternalDocsLink
                            href={toolExposureDocsUrl}
                            className="underline"
                            showIcon={false}
                          >
                            Learn more
                          </ExternalDocsLink>
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Knowledge Sources */}
                  {(knowledgeBases.length > 0 || connectors.length > 0) && (
                    <div className="space-y-2">
                      <Label>Knowledge Sources</Label>
                      <p className="text-xs text-muted-foreground">
                        Choose which knowledge this{" "}
                        {(agentTypeDisplayName[agentType] || "agent").replace(
                          /^./,
                          (c) => c.toUpperCase(),
                        )}{" "}
                        can draw from when responding
                      </p>
                      <Popover modal>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            className="w-full justify-between font-normal"
                          >
                            {(() => {
                              const totalSelected =
                                knowledgeBaseIds.length + connectorIds.length;
                              return totalSelected === 0
                                ? "Select connectors or knowledge bases"
                                : `${totalSelected} source${totalSelected > 1 ? "s" : ""} selected`;
                            })()}
                            <ChevronDown className="ml-2 h-4 w-4 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-96 p-0" align="start">
                          <Command>
                            <CommandInput placeholder="Search knowledge sources..." />
                            <CommandList>
                              <CommandEmpty>
                                No knowledge sources found.
                              </CommandEmpty>
                              {knowledgeBases.length > 0 && (
                                <CommandGroup heading="Knowledge Bases">
                                  {knowledgeBases.map((kb) => {
                                    const isSelected =
                                      knowledgeBaseIds.includes(kb.id);
                                    const connectorTypes = [
                                      ...new Set<string>(
                                        kb.connectors?.map(
                                          (c) => c.connectorType,
                                        ) ?? [],
                                      ),
                                    ];
                                    return (
                                      <CommandItem
                                        key={kb.id}
                                        value={kb.name}
                                        className="data-[selected=true]:bg-transparent"
                                        onSelect={() => {
                                          setKnowledgeBaseIds((prev) =>
                                            isSelected
                                              ? prev.filter(
                                                  (id) => id !== kb.id,
                                                )
                                              : [...prev, kb.id],
                                          );
                                        }}
                                      >
                                        <CheckIcon
                                          className={cn(
                                            "mr-2 h-4 w-4 shrink-0",
                                            isSelected
                                              ? "opacity-100"
                                              : "opacity-0",
                                          )}
                                        />
                                        <div className="flex-1 min-w-0">
                                          <div className="truncate text-sm">
                                            {kb.name}
                                          </div>
                                          {kb.description && (
                                            <div className="truncate text-xs text-muted-foreground">
                                              {kb.description}
                                            </div>
                                          )}
                                        </div>
                                        {connectorTypes.length > 0 && (
                                          <OverlappedIcons
                                            icons={connectorTypes.map(
                                              (type: string) => ({
                                                key: type,
                                                icon: (
                                                  <ConnectorTypeIcon
                                                    type={type}
                                                    className="h-full w-full"
                                                  />
                                                ),
                                                tooltip: type,
                                              }),
                                            )}
                                            maxVisible={3}
                                            size="sm"
                                            className="ml-2"
                                          />
                                        )}
                                      </CommandItem>
                                    );
                                  })}
                                </CommandGroup>
                              )}
                              {connectors.length > 0 && (
                                <CommandGroup heading="Connectors">
                                  {connectors.map((connector) => {
                                    const isSelected = connectorIds.includes(
                                      connector.id,
                                    );
                                    return (
                                      <CommandItem
                                        key={connector.id}
                                        value={connector.name}
                                        className="data-[selected=true]:bg-transparent"
                                        onSelect={() => {
                                          setConnectorIds((prev) =>
                                            isSelected
                                              ? prev.filter(
                                                  (id) => id !== connector.id,
                                                )
                                              : [...prev, connector.id],
                                          );
                                        }}
                                      >
                                        <CheckIcon
                                          className={cn(
                                            "mr-2 h-4 w-4 shrink-0",
                                            isSelected
                                              ? "opacity-100"
                                              : "opacity-0",
                                          )}
                                        />
                                        <div className="flex-1 min-w-0">
                                          <div className="truncate text-sm">
                                            {connector.name}
                                          </div>
                                          <div className="truncate text-xs text-muted-foreground">
                                            {connector.description || (
                                              <span className="capitalize">
                                                {connector.connectorType}
                                              </span>
                                            )}
                                          </div>
                                        </div>
                                        <div className="ml-2 shrink-0">
                                          <ConnectorTypeIcon
                                            type={connector.connectorType}
                                            className="h-4 w-4"
                                          />
                                        </div>
                                      </CommandItem>
                                    );
                                  })}
                                </CommandGroup>
                              )}
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>
                  )}
                </div>
              )}

              {/* Section 4: Access & LLM */}
              {(!isBuiltIn || isInternalAgent) && (
                <div className="rounded-lg border bg-card p-4 space-y-4">
                  {/* Visibility / Scope */}
                  {!isBuiltIn && (
                    <AccessLevelSelector
                      scope={scope}
                      onScopeChange={(newScope) => {
                        setScope(newScope);
                        if (newScope === "org") {
                          setAssignedTeamIds([]);
                        }
                      }}
                      isAdmin={!!isAdmin}
                      isTeamAdmin={!!isTeamAdmin}
                      initialScope={agent?.scope}
                      agentType={agentType}
                      teams={teams}
                      canReadTeams={!!canReadTeams}
                      assignedTeamIds={assignedTeamIds}
                      onTeamIdsChange={setAssignedTeamIds}
                      hasNoAvailableTeams={hasNoAvailableTeams}
                      showTeamRequired={!isAdmin}
                    />
                  )}

                  {/* LLM Configuration (Agent and Built-in) */}
                  {(isInternalAgent || isBuiltIn) && (
                    <div className="space-y-2">
                      <h3 className="text-sm font-semibold">
                        LLM Configuration
                      </h3>
                      {cannotReadLlmConfiguration ? (
                        <Alert>
                          <AlertDescription className="text-sm text-muted-foreground">
                            You do not have permission to view LLM API keys or
                            models. This agent will use the organization&apos;s
                            default model configuration.
                          </AlertDescription>
                        </Alert>
                      ) : (
                        <>
                          <p className="text-sm text-muted-foreground">
                            {selectedApiKey && selectedApiKey.scope !== "org"
                              ? "Selected key will be available to everyone who has access to this agent."
                              : null}
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <Popover
                              open={apiKeySelectorOpen}
                              onOpenChange={setApiKeySelectorOpen}
                            >
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 px-3 gap-1.5 text-xs max-w-[250px]"
                                >
                                  <Key className="h-3 w-3 shrink-0" />
                                  {selectedApiKey ? (
                                    <>
                                      <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
                                      <span className="font-medium truncate">
                                        {selectedApiKey.name}
                                      </span>
                                    </>
                                  ) : (
                                    <span className="text-muted-foreground">
                                      Dynamic API key
                                    </span>
                                  )}
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent
                                className="w-96 p-0"
                                align="start"
                              >
                                <Command>
                                  <CommandInput placeholder="Search API keys..." />
                                  <CommandList>
                                    <CommandEmpty>
                                      No API keys found.
                                    </CommandEmpty>
                                    <CommandGroup>
                                      <CommandItem
                                        onSelect={() => {
                                          setLlmApiKeyId(null);
                                          setLlmModel(null);
                                          lastAutoSelectedProviderRef.current =
                                            null;
                                          setApiKeySelectorOpen(false);
                                        }}
                                      >
                                        <div className="flex flex-col min-w-0">
                                          <span className="text-muted-foreground">
                                            Dynamic API key
                                          </span>
                                          <span className="text-xs text-muted-foreground">
                                            Resolved at runtime: org-wide → team
                                            → personal
                                          </span>
                                        </div>
                                        {!llmApiKeyId && (
                                          <CheckIcon className="ml-auto h-4 w-4" />
                                        )}
                                      </CommandItem>
                                    </CommandGroup>
                                    {(
                                      Object.keys(
                                        apiKeysByProvider,
                                      ) as SupportedProvider[]
                                    ).map((provider) => (
                                      <CommandGroup
                                        key={provider}
                                        heading={
                                          providerDisplayNames[provider] ??
                                          provider
                                        }
                                      >
                                        {apiKeysByProvider[provider]?.map(
                                          (
                                            apiKey: (typeof availableApiKeys)[number],
                                          ) => (
                                            <CommandItem
                                              key={apiKey.id}
                                              value={`${provider} ${apiKey.name} ${apiKey.teamName || ""}`}
                                              onSelect={() => {
                                                handleLlmApiKeyChange(
                                                  apiKey.id,
                                                );
                                                setApiKeySelectorOpen(false);
                                              }}
                                              className="cursor-pointer"
                                            >
                                              <div className="flex items-center gap-2 flex-1 min-w-0">
                                                {apiKey.scope ===
                                                  "personal" && (
                                                  <User className="h-3 w-3 shrink-0" />
                                                )}
                                                {apiKey.scope === "team" && (
                                                  <Users className="h-3 w-3 shrink-0" />
                                                )}
                                                {apiKey.scope === "org" && (
                                                  <Building2 className="h-3 w-3 shrink-0" />
                                                )}
                                                <span className="truncate">
                                                  {apiKey.name}
                                                </span>
                                                {apiKey.scope === "team" &&
                                                  apiKey.teamName && (
                                                    <span className="text-[10px] text-muted-foreground">
                                                      ({apiKey.teamName})
                                                    </span>
                                                  )}
                                              </div>
                                              {llmApiKeyId === apiKey.id && (
                                                <CheckIcon className="ml-auto h-4 w-4 shrink-0" />
                                              )}
                                            </CommandItem>
                                          ),
                                        )}
                                      </CommandGroup>
                                    ))}
                                  </CommandList>
                                </Command>
                              </PopoverContent>
                            </Popover>

                            {!llmApiKeyId ? (
                              <TooltipProvider delayDuration={300}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div>
                                      <ModelSelector
                                        selectedModel=""
                                        onModelChange={() => {}}
                                        disabled
                                        variant="outline"
                                        enabled={false}
                                      />
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent
                                    side="bottom"
                                    className="text-xs"
                                  >
                                    Select a provider API key first
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            ) : (
                              <ModelSelector
                                selectedModel={llmModel || ""}
                                onModelChange={(modelId) =>
                                  handleLlmModelChange(modelId)
                                }
                                onClear={() => {
                                  setLlmModel(null);
                                  setLlmApiKeyId(null);
                                  lastAutoSelectedProviderRef.current = null;
                                }}
                                variant="outline"
                                apiKeyId={llmApiKeyId}
                                enabled={!!canReadLlmModels}
                              />
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Section 5: Advanced (collapsible) — always shown for non-built-in (Labels are universal) */}
              {!isBuiltIn && (
                <Collapsible>
                  <div className="rounded-lg border bg-card">
                    <CollapsibleTrigger className="flex w-full items-center justify-between p-4 hover:bg-muted/50 transition-colors [&[data-state=open]>svg]:rotate-90">
                      <h3 className="text-sm font-semibold">Advanced</h3>
                      <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform" />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="border-t p-4 space-y-4">
                        {/* Labels */}
                        <ProfileLabels
                          ref={agentLabelsRef}
                          labels={labels}
                          onLabelsChange={setLabels}
                        />

                        {/* Security (LLM Proxy and Agent only) */}
                        {showSecurity && (
                          <div className="space-y-2">
                            <Label>Security</Label>
                            <div className="flex items-center justify-between">
                              <div className="space-y-0.5">
                                <Label
                                  htmlFor="consider-context-untrusted"
                                  className="text-sm font-medium cursor-pointer"
                                >
                                  Treat context as sensitive from the start of
                                  chat
                                </Label>
                                <p className="text-sm text-muted-foreground">
                                  When enabled, the context is always considered
                                  sensitive. Only tools allowed to run in
                                  sensitive context will be permitted.
                                </p>
                              </div>
                              <Switch
                                id="consider-context-untrusted"
                                checked={considerContextUntrusted}
                                onCheckedChange={setConsiderContextUntrusted}
                              />
                            </div>
                          </div>
                        )}

                        {/* Custom Header Passthrough (MCP Gateway only) */}
                        {agentType === "mcp_gateway" && (
                          <div className="space-y-2">
                            <Label>Custom Header Passthrough</Label>
                            <p className="text-sm text-muted-foreground">
                              Client request headers to pass through to
                              downstream MCP servers. Case-insensitive.
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                              {passthroughHeaders.map((header) => (
                                <Badge
                                  key={header}
                                  variant="secondary"
                                  className="gap-1 pr-1"
                                >
                                  {header}
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-4 w-4 p-0 hover:bg-transparent"
                                    onClick={() =>
                                      setPassthroughHeaders((prev) =>
                                        prev.filter((h) => h !== header),
                                      )
                                    }
                                  >
                                    <X className="h-3 w-3" />
                                  </Button>
                                </Badge>
                              ))}
                            </div>
                            {passthroughHeaders.length <
                              MAX_PASSTHROUGH_HEADERS && (
                              <Input
                                placeholder="Type header name and press Enter"
                                onKeyDown={(e) => {
                                  if (e.key !== "Enter") return;
                                  e.preventDefault();
                                  const value = e.currentTarget.value
                                    .trim()
                                    .toLowerCase();
                                  if (!value) return;
                                  if (!HEADER_NAME_REGEX.test(value)) {
                                    toast.error(
                                      "Header name must contain only alphanumeric characters and hyphens",
                                    );
                                    return;
                                  }
                                  if (BLOCKED_PASSTHROUGH_HEADERS.has(value)) {
                                    toast.error(
                                      `"${value}" is a hop-by-hop or protocol-level header and cannot be forwarded`,
                                    );
                                    return;
                                  }
                                  if (passthroughHeaders.includes(value)) {
                                    toast.error(
                                      `"${value}" is already in the list`,
                                    );
                                    return;
                                  }
                                  setPassthroughHeaders((prev) => [
                                    ...prev,
                                    value,
                                  ]);
                                  e.currentTarget.value = "";
                                }}
                              />
                            )}
                          </div>
                        )}

                        {/* Identity Provider for JWKS auth */}
                        {supportsIdentityProvider &&
                          identityProviders.length > 0 && (
                            <div className="space-y-2">
                              <Label>
                                {agentType === "llm_proxy"
                                  ? "Identity Provider (JWKS)"
                                  : "Identity Provider (Enterprise/JWKS)"}
                              </Label>
                              <p className="text-sm text-muted-foreground">
                                {agentType === "llm_proxy"
                                  ? `Select the OIDC identity provider this LLM Proxy should trust for JWKS JWT authentication. Leave this unset to keep using provider API keys and virtual keys without IdP JWT validation.`
                                  : `Select the OIDC identity provider this MCP Gateway should trust for ID-JAG and direct JWKS JWT authentication. The same provider is also used when ${appName} needs to resolve enterprise-managed downstream credentials for tool calls. Leave this unset to keep using the other supported MCP Gateway authentication methods without IdP JWT validation.`}
                                {mcpAuthDocsUrl ? (
                                  <>
                                    {" "}
                                    <ExternalDocsLink
                                      href={mcpAuthDocsUrl}
                                      className="underline"
                                      showIcon={false}
                                    >
                                      Learn more
                                    </ExternalDocsLink>
                                  </>
                                ) : null}
                              </p>
                              <Select
                                value={identityProviderId ?? "none"}
                                onValueChange={(value) =>
                                  setIdentityProviderId(
                                    value === "none" ? null : value,
                                  )
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="No Identity Provider selected" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">
                                    No Identity Provider
                                  </SelectItem>
                                  {identityProviders.map((provider) => (
                                    <SelectItem
                                      key={provider.id}
                                      value={provider.id}
                                    >
                                      {provider.providerId} ({provider.issuer})
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          )}
                      </div>
                    </CollapsibleContent>
                  </div>
                </Collapsible>
              )}

              {/* Labels for built-in agents (outside advanced section since advanced is hidden) */}
              {isBuiltIn && (
                <div className="rounded-lg border bg-card p-4 space-y-4">
                  <ProfileLabels
                    ref={agentLabelsRef}
                    labels={labels}
                    onLabelsChange={setLabels}
                  />
                </div>
              )}
            </div>
          </fieldset>
          <DialogStickyFooter className="mt-0">
            <Button type="button" variant="outline" onClick={handleClose}>
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {!readOnly && (
              <Button
                type="submit"
                disabled={
                  !name.trim() ||
                  isSaving ||
                  createAgent.isPending ||
                  updateAgent.isPending ||
                  requiresTeamSelection ||
                  (!isAdmin && scope === "team" && hasNoAvailableTeams)
                }
              >
                {(isSaving ||
                  createAgent.isPending ||
                  updateAgent.isPending) && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {agent ? "Update" : "Create"}
              </Button>
            )}
          </DialogStickyFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
