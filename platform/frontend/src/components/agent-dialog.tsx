"use client";

import {
  type AgentScope,
  type AgentType,
  type archestraApiTypes,
  BLOCKED_PASSTHROUGH_HEADERS,
  BUILT_IN_AGENT_DEFAULT_SYSTEM_PROMPTS,
  BUILT_IN_AGENT_IDS,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  DocsPage,
  DUAL_LLM_DEFAULT_MAX_ROUNDS,
  E2eTestId,
  getDocsUrl,
  getResourceForAgentType,
  HEADER_NAME_REGEX,
  MAX_PASSTHROUGH_HEADERS,
  MAX_SUGGESTED_PROMPT_TEXT_LENGTH,
  MAX_SUGGESTED_PROMPT_TITLE_LENGTH,
  MAX_SUGGESTED_PROMPTS,
  type SupportedProvider,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import {
  AlertTriangle,
  Bot,
  CheckIcon,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Globe,
  InfoIcon,
  Loader2,
  Plus,
  RotateCcw,
  User,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { AgentBadge } from "@/components/agent-badge";
import {
  AgentHooksEditor,
  type AgentHooksEditorRef,
} from "@/components/agent-hooks-editor";
import type { AgentIconVariant } from "@/components/agent-icon";
import { AgentIconPicker } from "@/components/agent-icon-picker";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import {
  AgentSkillsEditor,
  type EditableSkill,
} from "@/components/agent-skills-editor";
import type { GatewayLike } from "@/components/agent-skills-editor.utils";
import {
  AgentToolExclusionsEditor,
  type AgentToolExclusionsEditorRef,
} from "@/components/agent-tool-exclusions-editor";
import {
  AgentToolsEditor,
  type AgentToolsEditorRef,
  type McpEnvConflict,
} from "@/components/agent-tools-editor";
import { ModelSelector } from "@/components/chat/model-selector";
import { EnvironmentSelector } from "@/components/environment-selector";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import {
  formatPermissionRequirement,
  PermissionRequirementHint,
} from "@/components/permission-requirement-hint";
import { SystemPromptEditor } from "@/components/system-prompt-editor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AssignmentCombobox,
  type AssignmentComboboxItem,
} from "@/components/ui/assignment-combobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { hasUnsavedChanges } from "@/components/unsaved-changes-guard-utils";
import {
  UserShareField,
  useUserShareChoice,
  useUserShareOption,
} from "@/components/user-share-field";
import {
  VisibilitySelector as SharedVisibilitySelector,
  type VisibilityOption,
} from "@/components/visibility-selector";

/**
 * What the agent visibility control offers. Wider than the stored scope: an
 * agent shared with named people persists as `personal` plus grants.
 */
type AgentVisibilityChoice = AgentScope | "user";

import {
  useCreateProfile,
  useDelegationTargetAgents,
  useDeleteProfile,
  useProfile,
  useUpdateProfile,
} from "@/lib/agent.query";
import {
  useAgentSkillExclusions,
  useAgentSkills,
  useUpdateAgentSkillExclusions,
  useUpdateAgentSkills,
} from "@/lib/agent-skills.query";
import {
  useAgentSubagentExclusions,
  useUpdateAgentSubagentExclusions,
} from "@/lib/agent-subagent-exclusions.query";
import type { AgentToolExclusions } from "@/lib/agent-tool-exclusions.query";
import {
  useAgentDelegations,
  useSyncAgentDelegations,
} from "@/lib/agent-tools.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import { useChatProfileMcpTools } from "@/lib/chat/chat.query";
import { useFeature } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useEnvironments } from "@/lib/environment.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useConnectors } from "@/lib/knowledge/connector.query";
import {
  useIsKnowledgeBaseConfigured,
  useKnowledgeBases,
} from "@/lib/knowledge/knowledge-base.query";
import { isPersonalSubscription } from "@/lib/llm-key-subscription";
import { useLlmModelsByProvider } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useSkillsPaginated } from "@/lib/skills/skill.query";
import { useAssignableTeams } from "@/lib/teams/team.query";
import { cn } from "@/lib/utils";
import {
  getDescriptionPlaceholder,
  getNamePlaceholder,
  normalizeSuggestedPrompts,
  shouldOfferAppCatalogs,
  shouldShowDescriptionField,
} from "./agent-dialog.utils";

type Agent = archestraApiTypes.GetAllAgentsResponses["200"][number];
type ToolExposureMode = Agent["toolExposureMode"];

/** The API caps `limit` at 100, which is as much as the skill picker can load. */
const SKILL_PICKER_PAGE_SIZE = 100;

/**
 * The skill catalog page plus the rows the assignment API returned, deduped by
 * id with the catalog winning (it is the fresher read of the two).
 *
 * The second source exists because the first is capped: a configured skill
 * beyond the first page is not in the catalog page, and rendering the picker
 * from that page alone would silently hide it.
 */
function mergeSkillsById(
  ...sources: Array<readonly EditableSkill[] | undefined>
): EditableSkill[] {
  const byId = new Map<string, EditableSkill>();
  for (const source of sources) {
    for (const skill of source ?? []) {
      if (!byId.has(skill.id)) byId.set(skill.id, skill);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Remembers the row behind every id in `selectedIds`, for as long as it stays
 * selected, drawing from whatever `sources` currently hold it.
 *
 * The picker's rows are one catalog page plus the hits for the query being
 * typed, so a skill selected from one search belongs to neither once the query
 * changes. Its chip would disappear while its id stayed selected and was still
 * submitted on save — a published skill an admin can neither see nor remove.
 * The last source in the merge, so a fresher row always wins.
 *
 * Returns a stable array: it is a `useMemo` input, and a new identity per
 * render would defeat the memo it feeds.
 */
function useRememberedSkills(
  selectedIds: string[],
  sources: Array<readonly EditableSkill[] | undefined>,
): EditableSkill[] {
  const remembered = useRef(new Map<string, EditableSkill>());
  const snapshot = useRef<EditableSkill[]>([]);
  const selected = new Set(selectedIds);

  let changed = false;
  for (const source of sources) {
    for (const skill of source ?? []) {
      if (!selected.has(skill.id)) continue;
      if (remembered.current.get(skill.id) === skill) continue;
      remembered.current.set(skill.id, skill);
      changed = true;
    }
  }
  // Deselecting has to drop the row too, or an id removed and re-added would
  // resurrect a stale copy of it.
  for (const id of remembered.current.keys()) {
    if (selected.has(id)) continue;
    remembered.current.delete(id);
    changed = true;
  }
  if (changed) snapshot.current = [...remembered.current.values()];
  return snapshot.current;
}

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

type BuiltInAgentId =
  (typeof BUILT_IN_AGENT_IDS)[keyof typeof BUILT_IN_AGENT_IDS];

function getBuiltInAgentConfigForSave(params: {
  builtInAgentName: BuiltInAgentId;
  autoConfigureOnToolDiscovery: boolean;
  maxRounds: number;
}) {
  switch (params.builtInAgentName) {
    case BUILT_IN_AGENT_IDS.POLICY_CONFIG:
      return {
        name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
        autoConfigureOnToolDiscovery: params.autoConfigureOnToolDiscovery,
      };
    case BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN:
      return {
        name: BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
        maxRounds: params.maxRounds,
      };
    case BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE:
      return {
        name: BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE,
      };
    case BUILT_IN_AGENT_IDS.CONTEXT_COMPACTION:
      return {
        name: BUILT_IN_AGENT_IDS.CONTEXT_COMPACTION,
      };
    case BUILT_IN_AGENT_IDS.CHAT_TITLE_GENERATION:
      return {
        name: BUILT_IN_AGENT_IDS.CHAT_TITLE_GENERATION,
      };
    case BUILT_IN_AGENT_IDS.APP_RUNTIME:
      return {
        name: BUILT_IN_AGENT_IDS.APP_RUNTIME,
      };
    case BUILT_IN_AGENT_IDS.ADVISOR:
      return {
        name: BUILT_IN_AGENT_IDS.ADVISOR,
      };
    default: {
      // exhaustive check: a new BUILT_IN_AGENT_ID will fail the build here
      const _exhaustive: never = params.builtInAgentName;
      throw new Error(`Unsupported built-in agent: ${String(_exhaustive)}`);
    }
  }
}

// Single subagent pill with popover
interface SubagentPillProps {
  agent: Agent;
  isSelected: boolean;
  onToggle: (agentId: string) => void;
  // "delegate" pills read as an active delegation target (green); "exclude"
  // pills read as a target removed from the Auto surface (red).
  tone?: "delegate" | "exclude";
}

function SubagentPill({
  agent,
  isSelected,
  onToggle,
  tone = "delegate",
}: SubagentPillProps) {
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
              <span
                className={cn(
                  "h-2 w-2 rounded-full shrink-0",
                  tone === "exclude" ? "bg-red-500" : "bg-green-500",
                )}
              />
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
          aria-label="Remove agent"
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
            aria-label="Close"
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
  placeholder?: string;
  // The "delegate" role offers a shortcut to create a new agent; the "exclude"
  // (disabled-subagents) role only narrows an existing set, so it omits it.
  showCreateAction?: boolean;
  tone?: "delegate" | "exclude";
}

function SubagentsEditor({
  availableAgents,
  selectedAgentIds,
  onSelectionChange,
  currentAgentId,
  placeholder = "Search agents...",
  showCreateAction = true,
  tone = "delegate",
}: SubagentsEditorProps) {
  // Filter out the current agent, and the advisor: its own switch below owns
  // that decision, and listing it here would offer a second way to change the
  // same thing — one that reads as the opposite in Auto mode, where this list
  // is what an agent may *not* delegate to.
  const filteredAgents = availableAgents.filter(
    (a) =>
      a.id !== currentAgentId &&
      a.builtInAgentConfig?.name !== BUILT_IN_AGENT_IDS.ADVISOR,
  );

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
          tone={tone}
        />
      ))}
      <AssignmentCombobox
        items={comboboxItems}
        selectedIds={selectedAgentIds}
        onToggle={handleToggle}
        placeholder={placeholder}
        emptyMessage="No agents found."
        createAction={
          showCreateAction
            ? {
                label: "Create a New Agent",
                href: "/agents?create=true",
              }
            : undefined
        }
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

export const agentTypeDisplayName: Record<string, string> = {
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

export function AccessLevelSelector({
  scope,
  onScopeChange,
  isAdmin,
  isTeamAdmin,
  canReadTeams,
  initialScope,
  agentType,
  teams,
  assignedTeamIds,
  assignedUserIds = [],
  onUserIdsChange,
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
  /**
   * Per-user sharing. Omitted by surfaces that cannot persist grants (the
   * clone dialog), which then simply do not offer the option — better than
   * showing a control whose selection would be silently dropped.
   */
  assignedUserIds?: string[];
  onUserIdsChange?: (ids: string[]) => void;
  onTeamIdsChange: (ids: string[]) => void;
  hasNoAvailableTeams: boolean;
  showTeamRequired: boolean;
}) {
  const scopeOptions = getScopeOptions(agentType);
  const canShareWithTeams = isAdmin || isTeamAdmin;
  const userOption = useUserShareOption<AgentVisibilityChoice>("user");
  // An agent shared with named people stays `personal` in storage and carries
  // grants beside it, so "user" is a synthetic choice rather than a scope.
  const { isUserChoice, selectChoice } = useUserShareChoice<AgentScope>({
    scope,
    personalScope: "personal",
    userIds: assignedUserIds,
    onScopeChange,
    onUserIdsChange,
  });
  const choice: AgentVisibilityChoice = isUserChoice ? "user" : scope;

  const isOptionDisabled = (value: string) => {
    if (value === "personal" && initialScope && initialScope !== "personal")
      return true;
    if (value === "team" && (!canShareWithTeams || !canReadTeams)) return true;
    // Nothing to share with: keep the option visible but inert and explained,
    // rather than offering a choice that cannot be completed.
    if (value === "team" && hasNoAvailableTeams) return true;
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
    if (value === "team" && hasNoAvailableTeams)
      return "There are no teams to share with yet. Create one from Settings → Teams.";
    if (value === "org" && !isAdmin)
      return `You need ${resourceName}:admin permission to make this available org-wide`;
    return "";
  };

  /** The short note beside the label; the reason itself sits under it. */
  const getDisabledLabel = (value: string) => {
    if (value === "personal") return "Unavailable";
    if (value === "team" && (!canReadTeams || !canShareWithTeams))
      return "Requires permission";
    if (value === "team" && hasNoAvailableTeams) return "No teams available";
    if (value === "org") return "Requires permission";
    return undefined;
  };

  const scopedOptions: VisibilityOption<AgentVisibilityChoice>[] =
    scopeOptions.map((option) => ({
      ...option,
      disabled: isOptionDisabled(option.value),
      disabledLabel: isOptionDisabled(option.value)
        ? getDisabledLabel(option.value)
        : undefined,
      disabledReason: isOptionDisabled(option.value)
        ? getDisabledReason(option.value)
        : undefined,
    }));
  // Users sits next to Personal: both keep the agent out of team/org reach.
  const personalIndex = scopedOptions.findIndex(
    (option) => option.value === "personal",
  );
  // Sharing with named people is stored as `personal` plus grants, so it is
  // bound by whatever bars Personal itself. Without this an already-shared
  // agent offered the option and then refused the save.
  const personalLocked = isOptionDisabled("personal");
  const userChoiceOption: VisibilityOption<AgentVisibilityChoice> =
    personalLocked
      ? {
          ...userOption,
          disabled: true,
          disabledLabel: "Unavailable",
          disabledReason:
            "Sharing with named people keeps this personal, and a shared agent cannot be made personal again.",
        }
      : userOption;
  const options: VisibilityOption<AgentVisibilityChoice>[] =
    personalIndex === -1 || !onUserIdsChange
      ? scopedOptions
      : [
          ...scopedOptions.slice(0, personalIndex + 1),
          userChoiceOption,
          ...scopedOptions.slice(personalIndex + 1),
        ];

  return (
    <SharedVisibilitySelector
      heading={`Who can use this ${agentTypeDisplayName[agentType] || "agent"}`}
      value={choice}
      options={options}
      onValueChange={selectChoice}
    >
      {choice === "user" && onUserIdsChange && (
        <UserShareField
          value={assignedUserIds}
          onValueChange={onUserIdsChange}
        />
      )}

      {choice === "team" && (
        <div className="space-y-2">
          <Label>Teams{showTeamRequired && <span> *</span>}</Label>
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
  /** When true, the tools "Add MCP server" combobox starts open. */
  openToolsCombobox?: boolean;
}

/**
 * Wrapper whose only job is to give the dialog body a fresh mount per agent.
 *
 * Every list page keeps one dialog mounted and swaps the `agent` prop as rows
 * are opened, and several of the body's controls are seeded from per-agent
 * requests that land after the swap — delegations, subagent exclusions, and the
 * published-skill sets. Without a remount the body keeps the previous agent's
 * values until those land: it renders one agent's configuration under another's
 * name, counts as edited, and a save issues the full-replace PUTs that write it
 * onto the wrong agent. Remounting makes that unrepresentable rather than
 * relying on every call site to pass a `key`.
 */
export function AgentDialog(props: AgentDialogProps) {
  const { key, agent } = useAgentInstance(props);
  return <AgentDialogBody key={key} {...props} agent={agent} />;
}

/**
 * The entity the body is mounted for, and the key that identifies it — `new`
 * in create mode, where there is nothing per-agent to load.
 *
 * Held still while the dialog is closed, because closing clears the caller's
 * entity in the same render that flips `open` — swapping the body out right
 * then would cut off the dialog's exit animation.
 *
 * An open dialog holds its agent too. Callers derive the prop from a list
 * query rather than from dialog state (chat picks the agent out of a
 * refetching list), so an agent deleted elsewhere — or briefly absent from a
 * refetch — turned the dialog into an empty create form mid-edit: the key fell
 * back to `new` and remounted the body, discarding every pending change with
 * no prompt, and the next save would have created a second agent. Only the
 * transition into open adopts an absent entity, which is what create mode is.
 */
function useAgentInstance({ open, agent }: AgentDialogProps): {
  key: string;
  agent: AgentDialogProps["agent"];
} {
  const heldAgent = useRef(agent);
  const wasOpen = useRef(false);

  if (open && (!wasOpen.current || agent)) {
    heldAgent.current = agent;
  }
  wasOpen.current = open;

  return {
    key: heldAgent.current?.id ?? "new",
    agent: heldAgent.current,
  };
}

function AgentDialogBody({
  open,
  onOpenChange,
  agent,
  agentType = "profile",
  defaultIconType = "agent",
  onCreated,
  readOnly = false,
  openToolsCombobox = false,
}: AgentDialogProps) {
  const appName = useAppName();
  const shouldLoadInternalAgents = open && agentType !== "llm_proxy";
  const shouldLoadIdentityProviders =
    open &&
    (agentType === "mcp_gateway" ||
      agentType === "llm_proxy" ||
      agentType === "agent");
  const shouldLoadKnowledgeSources = open;
  const shouldLoadLlmConfiguration = open && agentType === "agent";
  const { data: canReadAgents } = useHasPermissions({ agent: ["read"] });

  const { data: allInternalAgents = [] } = useDelegationTargetAgents({
    enabled: shouldLoadInternalAgents && !!canReadAgents,
  });
  const createAgent = useCreateProfile();
  const deleteAgent = useDeleteProfile();
  const updateAgent = useUpdateProfile();
  const syncDelegations = useSyncAgentDelegations();
  // Every set below is seeded from its own request and saved back as a full
  // replace, so all of them gate on `isSuccess` rather than `isFetched`:
  // `isFetched` also counts a failed attempt, and seeding an empty set from one
  // turns a single failed GET into a save that deletes what it could not read.
  const { data: currentDelegations = [], isSuccess: delegationsLoaded } =
    useAgentDelegations(agentType !== "llm_proxy" ? agent?.id : undefined);
  const syncSubagentExclusions = useUpdateAgentSubagentExclusions();
  const {
    data: currentSubagentExclusions,
    isSuccess: subagentExclusionsLoaded,
  } = useAgentSubagentExclusions(
    agentType !== "llm_proxy" ? agent?.id : undefined,
  );
  // Which skills this gateway publishes over `skill://` (SEP-2640). Offered on
  // exactly the agent types that serve MCP resources — the same set that gets
  // the tool control, so LLM proxies have neither — and only where the
  // deployment has enabled the draft extension. The API enforces the same
  // split, so a proxy cannot be given a published set out of band.
  const mcpGatewaySkillsEnabled = useFeature("mcpGatewaySkillsEnabled");
  // `skill:read` is the API's floor on these endpoints — publishing a skill
  // hands its body to every holder of the gateway's token, so it is not
  // something gateway permission alone buys. Hiding the section for a caller
  // without the capability is the difference between a control they never see
  // and one that 403s when they save.
  const { data: canReadSkills } = useHasPermissions({ skill: ["read"] });
  const showSkills =
    mcpGatewaySkillsEnabled === true &&
    !!canReadSkills &&
    !agent?.builtIn &&
    (agentType === "mcp_gateway" ||
      agentType === "agent" ||
      agentType === "profile");
  // The section renders only while the dialog is open, but the component stays
  // mounted closed on the list and chat pages — so without `open` every one of
  // those page loads fetches a skill catalog for a dialog nobody opened.
  const loadSkills = open && showSkills;
  const syncSkills = useUpdateAgentSkills();
  const syncSkillExclusions = useUpdateAgentSkillExclusions();
  const {
    data: currentSkillAssignments,
    isSuccess: skillAssignmentsLoaded,
    isError: skillAssignmentsFailed,
  } = useAgentSkills(loadSkills ? agent?.id : undefined);
  const {
    data: currentSkillExclusions,
    isSuccess: skillExclusionsLoaded,
    isError: skillExclusionsFailed,
  } = useAgentSkillExclusions(loadSkills ? agent?.id : undefined);
  // Create mode has no agent to read from, so both queries stay disabled and
  // the editors are usable at once; edit mode waits for both, because the
  // section is one full-replace save over the pair.
  const skillsQueriesEnabled = loadSkills && !!agent?.id;
  const skillsLoaded =
    !skillsQueriesEnabled || (skillAssignmentsLoaded && skillExclusionsLoaded);
  const skillsFailed =
    skillsQueriesEnabled && (skillAssignmentsFailed || skillExclusionsFailed);
  // The picker opens on the first page of skills by name; `limit` is capped at
  // 100 by the API.
  const { data: skillsPage, isFetching: skillsPageFetching } =
    useSkillsPaginated(
      {
        limit: SKILL_PICKER_PAGE_SIZE,
        offset: 0,
        sortBy: "name",
        sortDirection: "asc",
      },
      { enabled: loadSkills },
    );
  // Typing in the picker searches the whole catalog server-side rather than
  // filtering the loaded page, so a skill past the first 100 is reachable at
  // all. Only the mode's own picker is mounted at a time, so one query serves
  // both; it stays idle until there is something to search for.
  const [skillSearch, setSkillSearch] = useState("");
  const debouncedSkillSearch = useDebouncedValue(skillSearch, 250);
  const { data: skillSearchPage, isFetching: skillSearchFetching } =
    useSkillsPaginated(
      {
        limit: SKILL_PICKER_PAGE_SIZE,
        offset: 0,
        sortBy: "name",
        sortDirection: "asc",
        search: debouncedSkillSearch,
      },
      { enabled: loadSkills && debouncedSkillSearch.trim().length > 0 },
    );
  // The debounce is part of the wait: between the keystroke and the request the
  // picker holds only the first page, and calling that "No skills found." is
  // how a user concludes a skill they can see in the catalog does not exist.
  //
  // The first page counts for the same reason. A user who opens the picker
  // before it lands would otherwise read the settled empty message about a
  // catalog that simply has not arrived.
  const skillSearchPending =
    (skillSearch.trim().length > 0 &&
      (skillSearch !== debouncedSkillSearch || skillSearchFetching)) ||
    (skillsPageFetching && !skillsPage);
  const { data: canReadIdentityProviders } = useHasPermissions({
    identityProvider: ["read"],
  });
  const { data: canReadKnowledgeBase } = useHasPermissions({
    knowledgeSource: ["read"],
  });
  const { data: canAccessKnowledgeSettings } = useHasPermissions({
    knowledgeSettings: ["read"],
  });
  const isKnowledgeConfigured = useIsKnowledgeBaseConfigured();
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
  // Environment isolation is always enforced by the backend for agents and MCP
  // gateways, so the tool picker reflects it (cross-environment catalogs are
  // shown disabled). When the org only has the Default environment, nothing is
  // cross-environment, so this is a no-op.
  const environmentScopingEnabled =
    agentType === "agent" || agentType === "mcp_gateway";
  const { data: environmentsData } = useEnvironments(
    open && environmentScopingEnabled,
  );
  // Used to resolve the selected environment's name for the tools editor; the
  // EnvironmentSelector owns its own list + permission filtering.
  const environments = environmentsData?.environments ?? [];
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
  const resource = getResourceForAgentType(agentType);
  const { data: isAdmin } = useHasPermissions({
    [resource]: ["admin"],
  });
  const { data: isTeamAdmin } = useHasPermissions({
    [resource]: ["team-admin"],
  });
  // Picker offers all teams to a full resource-admin, otherwise only the teams
  // the user belongs to (the only ones the backend lets a team-admin assign).
  const { data: teams } = useAssignableTeams({
    isResourceAdmin: !!isAdmin,
    enabled: open && !!canReadTeams,
  });
  const agentLabelsRef = useRef<ProfileLabelsRef>(null);
  const agentToolsEditorRef = useRef<AgentToolsEditorRef>(null);
  const agentHooksEditorRef = useRef<AgentHooksEditorRef>(null);
  const agentToolExclusionsEditorRef =
    useRef<AgentToolExclusionsEditorRef>(null);
  // Snapshot of the form's pristine values, captured whenever the dialog
  // (re)populates from the loaded agent, so we can detect unsaved edits.
  const initialSnapshotRef = useRef<Record<string, unknown> | null>(null);

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
  // People the agent is shared with by name. Stored beside the `personal`
  // scope, so the control below reads (scope, userIds) as a fourth choice.
  const [assignedUserIds, setAssignedUserIds] = useState<string[]>([]);
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const [considerContextUntrusted, setConsiderContextUntrusted] =
    useState(false);
  const [llmApiKeyId, setLlmApiKeyId] = useState<string | null>(null);
  const [llmModel, setLlmModel] = useState<string | null>(null);
  const [apiKeySelectorOpen, setApiKeySelectorOpen] = useState(false);
  const [selectedToolsCount, setSelectedToolsCount] = useState(0);
  // The tools editor's live selection (pending edits included), so the
  // exclusions editor's seed treats a just-checked-but-unsaved built-in as
  // assigned instead of disabling it.
  const [pendingSelectedToolIds, setPendingSelectedToolIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [identityProviderId, setIdentityProviderId] = useState<
    string | null | undefined
  >(undefined);
  const [environmentId, setEnvironmentId] = useState<string | null | undefined>(
    undefined,
  );
  const agentEnvironmentName =
    environments.find((env) => env.id === environmentId)?.name ?? null;
  const [mcpEnvConflicts, setMcpEnvConflicts] = useState<McpEnvConflict[]>([]);
  const [scope, setScope] = useState<AgentScope>("personal");
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>([]);
  const [connectorIds, setConnectorIds] = useState<string[]>([]);
  const [autoConfigureOnToolDiscovery, setAutoConfigureOnToolDiscovery] =
    useState(false);
  const [dualLlmMaxRounds, setDualLlmMaxRounds] = useState(
    String(DUAL_LLM_DEFAULT_MAX_ROUNDS),
  );
  const [passthroughHeaders, setPassthroughHeaders] = useState<string[]>([]);
  const [toolExposureMode, setToolExposureMode] =
    useState<ToolExposureMode>("full");
  // New agents default to Auto mode (implicit access to all tools); editing an
  // existing agent overwrites this from its stored value.
  const [accessAllTools, setAccessAllTools] = useState(true);
  // Auto subagent mode: new agents default to Auto (may delegate to any agent
  // the caller can access); editing overwrites this from the stored value.
  const [accessAllSubagents, setAccessAllSubagents] = useState(true);
  // Delegation targets excluded from the Auto surface ("Auto All Except Some").
  // Inert while in Custom subagent mode. Seeded async from the backend.
  const [disabledSubagentIds, setDisabledSubagentIds] = useState<string[]>([]);
  // Skills published over `skill://`. Auto exposes every org-scoped skill in the
  // agent's environment minus exclusions; Custom publishes exactly the assigned
  // set. Both sets persist independently, so switching mode discards neither.
  // All three are seeded async from the backend.
  const [accessAllSkills, setAccessAllSkills] = useState(false);
  const [assignedSkillIds, setAssignedSkillIds] = useState<string[]>([]);
  const [excludedSkillIds, setExcludedSkillIds] = useState<string[]>([]);
  // Auto-mode exclusions dirty tracking: { initial, current } normalized
  // payloads reported by the exclusions editor (null until it initializes and
  // after it unmounts when the dialog closes).
  const [exclusionsState, setExclusionsState] = useState<{
    initial: AgentToolExclusions;
    current: AgentToolExclusions;
  } | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Determine type-specific visibility based on agentType prop
  const isInternalAgent = agentType === "agent";
  // Agents, LLM proxies, and MCP gateways can all be assigned a deployment
  // environment. For agents it binds the code sandbox runtime; for LLM proxies
  // / MCP gateways it is an attribution label so their
  // inference/usage falls under environment-scoped cost limits.
  const supportsEnvironment =
    isInternalAgent || agentType === "llm_proxy" || agentType === "mcp_gateway";
  const environmentHelpText =
    agentType === "llm_proxy"
      ? "The environment this proxy's inference is attributed to, so its usage counts against that environment's cost limits."
      : agentType === "mcp_gateway"
        ? "The environment this gateway belongs to, controlling which tools and knowledge it can expose to consumers."
        : "The environment for this agent's code sandbox (runtime and network egress) and the tools and knowledge sources it can use.";
  const isBuiltIn = !!agent?.builtIn;
  const agentHooksEnabled = useFeature("agentHooksEnabled");
  // "Auto" (implicit access to all tools) is the default for new agents; admins
  // can switch an agent to "Custom" (explicitly assigned tools). Implicit access
  // is scoped to tools/knowledge visible to the user AND in the agent's
  // environment.
  const autoToolsMode = accessAllTools;
  // Seed the exclusions editor with the backend's Auto-mode pre-fill whenever
  // saving would put the agent into Auto mode from scratch: creating a new
  // agent on the Auto tab, or editing an agent whose SAVED accessAllTools is
  // off while the Auto tab is selected. An agent already saved in Auto mode has
  // its pre-fill persisted server-side, so the editor just loads it.
  const savedAccessAllTools = (freshAgent || agent)?.accessAllTools ?? false;
  const seedDefaultExclusions =
    autoToolsMode && (agent ? !savedAccessAllTools : true);
  const builtInAgentName = agent?.builtInAgentConfig?.name;
  const isPolicyConfigBuiltIn =
    builtInAgentName === BUILT_IN_AGENT_IDS.POLICY_CONFIG;
  const isDualLlmMainBuiltIn =
    builtInAgentName === BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN;
  const isDualLlmQuarantineBuiltIn =
    builtInAgentName === BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE;
  const isAdvisorBuiltIn = builtInAgentName === BUILT_IN_AGENT_IDS.ADVISOR;
  const _isDualLlmBuiltIn = isDualLlmMainBuiltIn || isDualLlmQuarantineBuiltIn;
  const supportsIdentityProvider =
    agentType === "mcp_gateway" ||
    agentType === "llm_proxy" ||
    agentType === "agent";
  const mcpAuthDocsUrl = getFrontendDocsUrl(DocsPage.McpAuthentication);
  const toolExposureDocsUrl = getDocsUrl(
    agentType === "mcp_gateway"
      ? DocsPage.PlatformMcpGateway
      : DocsPage.PlatformAgents,
    "load-tools-when-needed",
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
  // The delegation targets and the disabled-subagent set each arrive from their
  // own request. Until both have succeeded the editors would render a
  // not-yet-seeded empty list, which reads as "delegates to nothing" and can be
  // saved as one — both sets are written back as full replaces. Create mode has
  // nothing to wait for.
  const subagentSetsLoaded =
    !agent?.id ||
    agentType === "llm_proxy" ||
    (delegationsLoaded && subagentExclusionsLoaded);
  const showSecurity =
    !isBuiltIn && (agentType === "llm_proxy" || agentType === "agent");
  // The environment comes from the form rather than the stored agent: the
  // agent update lands before the skills PUT, so a pending environment change
  // is what the API will judge the assignment against.
  const skillGateway: GatewayLike = {
    environmentId: environmentId ?? null,
  };
  // Personal skills are publishable only by their author, so the picker needs
  // to know who is signed in. Independent of the agent row — the rule holds in
  // create mode too, before any gateway exists.
  const { data: session } = useSession();
  const currentUserId = session?.user?.id ?? null;
  // Rows the admin has picked, kept for as long as they stay picked. Without
  // this a skill chosen from one search vanishes the moment the query changes —
  // it is in neither the catalog page nor the new search hits — while its id
  // stays selected and is still submitted, publishing something that can be
  // neither seen nor removed.
  const pickedAssignedSkills = useRememberedSkills(assignedSkillIds, [
    skillsPage?.data,
    skillSearchPage?.data,
    currentSkillAssignments?.skills,
  ]);
  const pickedExcludedSkills = useRememberedSkills(excludedSkillIds, [
    skillsPage?.data,
    skillSearchPage?.data,
    currentSkillExclusions?.skills,
  ]);
  // The catalog page, the server-side search hits, the rows the API returned
  // for what is already configured, and the rows picked earlier this session.
  // The merge is what keeps the picker honest: `limit` is capped at 100, so an
  // assignment outside that page would otherwise render no chip at all — the
  // count would say five while three were shown, and the missing ones could be
  // neither seen nor removed.
  const availableSkills: EditableSkill[] = useMemo(
    () =>
      mergeSkillsById(
        skillsPage?.data,
        skillSearchPage?.data,
        currentSkillAssignments?.skills,
        pickedAssignedSkills,
      ),
    [
      skillsPage,
      skillSearchPage,
      currentSkillAssignments,
      pickedAssignedSkills,
    ],
  );
  // Auto publishes org-scoped skills only, so those are the only ones worth
  // offering to exclude from it — merged with the configured exclusions for the
  // same reason as above.
  //
  // An exclusion outlives the scope it was made under: nothing prunes the id
  // when an excluded skill is re-scoped to team or personal. Such a row is kept
  // so its chip stays visible and removable — the same reason AgentSkillsEditor
  // exempts already-selected rows from its `disabled` check. Dropping it would
  // leave the count saying three while two chips showed, with the third
  // re-submitted verbatim on every save and reachable from nowhere.
  const orgScopedSkills = useMemo(() => {
    const excluded = new Set([
      ...(currentSkillExclusions?.excludedSkillIds ?? []),
      ...excludedSkillIds,
    ]);
    return mergeSkillsById(
      skillsPage?.data,
      skillSearchPage?.data,
      currentSkillExclusions?.skills,
      pickedExcludedSkills,
    ).filter((skill) => skill.scope === "org" || excluded.has(skill.id));
  }, [
    skillsPage,
    skillSearchPage,
    currentSkillExclusions,
    excludedSkillIds,
    pickedExcludedSkills,
  ]);

  // Reset form when dialog opens/closes or agent changes
  useEffect(() => {
    if (open) {
      // Refetch agent data when dialog opens to ensure fresh data
      if (agent?.id) {
        refetchAgent();
      }

      // Use fresh agent data if available, otherwise fall back to prop
      const agentData = freshAgent || agent;

      const nextValues: AgentFormFields = agentData
        ? {
            name: agentData.name,
            icon: agentData.icon,
            description: agentData.description || "",
            systemPrompt: agentData.systemPrompt || "",
            suggestedPrompts: agentData.suggestedPrompts,
            assignedTeamIds: agentData.teams.map((t) => t.id),
            assignedUserIds: agentData.users?.map((u) => u.id) ?? [],
            labels: agentData.labels,
            considerContextUntrusted: agentData.considerContextUntrusted,
            llmApiKeyId: agentData.llmApiKeyId,
            llmModel: agentData.modelId,
            identityProviderId: agentData.identityProviderId ?? undefined,
            environmentId: agentData.environmentId ?? undefined,
            knowledgeBaseIds: agentData.knowledgeBaseIds,
            connectorIds: agentData.connectorIds,
            scope: agentData.scope,
            autoConfigureOnToolDiscovery:
              agentData.builtInAgentConfig?.name ===
              BUILT_IN_AGENT_IDS.POLICY_CONFIG
                ? agentData.builtInAgentConfig.autoConfigureOnToolDiscovery
                : false,
            dualLlmMaxRounds:
              agentData.builtInAgentConfig?.name ===
              BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN
                ? String(agentData.builtInAgentConfig.maxRounds)
                : String(DUAL_LLM_DEFAULT_MAX_ROUNDS),
            passthroughHeaders: agentData.passthroughHeaders ?? [],
            toolExposureMode: agentData.toolExposureMode ?? "full",
            accessAllTools: agentData.accessAllTools ?? false,
            accessAllSubagents: agentData.accessAllSubagents ?? false,
          }
        : {
            name: "",
            icon: null,
            description: "",
            // Prefill a starter persona for new agents so the default is
            // visible and editable in the UI; other agent types don't surface
            // the instruction.
            systemPrompt: isInternalAgent ? DEFAULT_AGENT_SYSTEM_PROMPT : "",
            suggestedPrompts: [],
            assignedTeamIds: [],
            assignedUserIds: [],
            labels: [],
            considerContextUntrusted: false,
            llmApiKeyId: null,
            llmModel: null,
            identityProviderId: undefined,
            environmentId: undefined,
            knowledgeBaseIds: [],
            connectorIds: [],
            scope: "personal",
            autoConfigureOnToolDiscovery: false,
            dualLlmMaxRounds: String(DUAL_LLM_DEFAULT_MAX_ROUNDS),
            passthroughHeaders: [],
            // New agents default to "Auto" (implicit access to all tools);
            // admins can switch to "Custom" (explicitly assigned tools).
            toolExposureMode: "full",
            accessAllTools: true,
            accessAllSubagents: true,
          };

      setName(nextValues.name);
      setIcon(nextValues.icon);
      setDescription(nextValues.description);
      setSystemPrompt(nextValues.systemPrompt);
      setSuggestedPrompts(nextValues.suggestedPrompts);
      setSuggestedPromptsOpen(false);
      setLlmApiKeyId(nextValues.llmApiKeyId);
      setLlmModel(nextValues.llmModel);
      setAssignedTeamIds(nextValues.assignedTeamIds);
      setAssignedUserIds(nextValues.assignedUserIds);
      setLabels(nextValues.labels);
      setConsiderContextUntrusted(nextValues.considerContextUntrusted);
      setIdentityProviderId(nextValues.identityProviderId);
      setEnvironmentId(nextValues.environmentId);
      setKnowledgeBaseIds(nextValues.knowledgeBaseIds);
      setConnectorIds(nextValues.connectorIds);
      setScope(nextValues.scope);
      setPassthroughHeaders(nextValues.passthroughHeaders);
      setToolExposureMode(nextValues.toolExposureMode);
      setAccessAllTools(nextValues.accessAllTools);
      setAccessAllSubagents(nextValues.accessAllSubagents);
      setAutoConfigureOnToolDiscovery(nextValues.autoConfigureOnToolDiscovery);
      setDualLlmMaxRounds(nextValues.dualLlmMaxRounds);
      if (!agentData) {
        // Create mode only. The create dialog is the one instance whose key
        // never changes, so reopening it reuses the mount and has to be cleared
        // here; edit mode remounts per agent and seeds each set from its own
        // request, and clearing here would instead wipe pending edits on every
        // agent refetch.
        setSelectedDelegationTargetIds([]);
        setDisabledSubagentIds([]);
        // A new gateway publishes nothing until an admin opts in, so Custom
        // with an empty set is the default rather than Auto.
        setAccessAllSkills(false);
        setAssignedSkillIds([]);
        setExcludedSkillIds([]);
      }
      initialSnapshotRef.current = buildAgentFormSnapshot(nextValues);

      // Reset counts when dialog opens
      setSelectedToolsCount(0);
      lastAutoSelectedProviderRef.current = null;
    }
  }, [open, agent, freshAgent, refetchAgent, isInternalAgent]);

  // Sync selectedDelegationTargetIds with currentDelegations when data loads.
  // Agent refetches can update freshAgent after delegations have loaded; keeping
  // delegations out of the agent reset path avoids clearing them on save.
  // Seeding waits for success, never mere completion: a failed read seeds an
  // empty set, and the save below writes empty sets back as a full replace.
  const currentDelegationIds = currentDelegations.map((a) => a.id).join(",");
  const agentId = agent?.id;

  useEffect(() => {
    if (open && agentId && delegationsLoaded) {
      setSelectedDelegationTargetIds(
        currentDelegationIds.split(",").filter(Boolean),
      );
    }
  }, [open, agentId, currentDelegationIds, delegationsLoaded]);

  // Seed the Auto-mode disabled-subagents set once the exclusions load. Kept out
  // of the agent reset path (same reasoning as delegations above) so a refetch
  // doesn't wipe pending edits.
  const currentExcludedSubagentIds = (
    currentSubagentExclusions?.excludedSubagentIds ?? []
  ).join(",");

  useEffect(() => {
    if (open && agentId && subagentExclusionsLoaded) {
      setDisabledSubagentIds(
        currentExcludedSubagentIds.split(",").filter(Boolean),
      );
    }
  }, [open, agentId, currentExcludedSubagentIds, subagentExclusionsLoaded]);

  // Seed the published-skill sets once they load, for the same reason as the
  // subagent sets above: they arrive after the agent reset, so keeping them out
  // of that path stops a refetch from wiping pending edits.
  const currentAssignedSkillIds = (
    currentSkillAssignments?.skillIds ?? []
  ).join(",");
  const currentSavedAccessAllSkills =
    currentSkillAssignments?.accessAllSkills ?? false;

  useEffect(() => {
    if (open && agentId && skillAssignmentsLoaded) {
      setAssignedSkillIds(currentAssignedSkillIds.split(",").filter(Boolean));
      setAccessAllSkills(currentSavedAccessAllSkills);
    }
  }, [
    open,
    agentId,
    currentAssignedSkillIds,
    currentSavedAccessAllSkills,
    skillAssignmentsLoaded,
  ]);

  const currentExcludedSkillIds = (
    currentSkillExclusions?.excludedSkillIds ?? []
  ).join(",");

  useEffect(() => {
    if (open && agentId && skillExclusionsLoaded) {
      setExcludedSkillIds(currentExcludedSkillIds.split(",").filter(Boolean));
    }
  }, [open, agentId, currentExcludedSkillIds, skillExclusionsLoaded]);

  // One org-wide advisor: delegation reaches it from every environment, so the
  // switch targets the same row wherever this agent lives.
  const advisorAgentId = allInternalAgents.find(
    (a) => a.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.ADVISOR,
  )?.id;

  // Consulting the advisor is off until someone turns it on, and a new agent
  // starts in Auto mode where every accessible agent is reachable. Seeding the
  // disabled set is what makes the switch's "off" true rather than decorative.
  const advisorSeededRef = useRef(false);
  useEffect(() => {
    if (!open) {
      advisorSeededRef.current = false;
      return;
    }
    if (agentId || !advisorAgentId || advisorSeededRef.current) return;
    advisorSeededRef.current = true;
    setDisabledSubagentIds((ids) =>
      ids.includes(advisorAgentId) ? ids : [...ids, advisorAgentId],
    );
  }, [open, agentId, advisorAgentId]);

  // One switch over two representations: Auto mode reaches every agent unless
  // excluded, Custom mode reaches only what is listed. The reader should not
  // have to know which is in play to decide whether the advisor is on.
  const advisorEnabled = advisorAgentId
    ? accessAllSubagents
      ? !disabledSubagentIds.includes(advisorAgentId)
      : selectedDelegationTargetIds.includes(advisorAgentId)
    : false;

  // The advisor is kept out of both lists, so it must be kept out of their
  // counts too — a count that includes something invisible reads as a bug.
  const delegationTargetCount = selectedDelegationTargetIds.filter(
    (id) => id !== advisorAgentId,
  ).length;
  const disabledSubagentCount = disabledSubagentIds.filter(
    (id) => id !== advisorAgentId,
  ).length;

  const listedWhen = (
    ids: string[],
    agentId: string | undefined,
    listed: boolean,
  ) => {
    if (!agentId) return ids;
    if (listed) {
      return ids.includes(agentId) ? ids : [...ids, agentId];
    }
    return ids.filter((id) => id !== agentId);
  };

  const advisorListedWhen = (ids: string[], listed: boolean) =>
    listedWhen(ids, advisorAgentId, listed);

  // Save writes both sets whatever the mode, and an Auto-mode agent driven by a
  // system or token flow resolves its targets from the explicit set rather than
  // the Auto surface. So the advisor has to match the switch in both sets, not
  // just the one the current mode reads — a grant stranded in the other set is
  // a live consultation nothing in the dialog can show or clear.
  const delegationTargetIdsToSave = advisorListedWhen(
    selectedDelegationTargetIds,
    advisorEnabled,
  );
  const disabledSubagentIdsToSave = advisorListedWhen(
    disabledSubagentIds,
    !advisorEnabled,
  );

  const writeAdvisorEnabled = (enabled: boolean) => {
    if (!advisorAgentId) return;
    setDisabledSubagentIds((ids) => advisorListedWhen(ids, !enabled));
    setSelectedDelegationTargetIds((ids) => advisorListedWhen(ids, enabled));
  };

  // Each mode reads the advisor from its own set, so a mode change would
  // otherwise surface an unrelated value and appear to flip the switch on its
  // own. Carry the current setting across instead.
  const handleSubagentModeChange = (value: string) => {
    setAccessAllSubagents(value === "auto");
    writeAdvisorEnabled(advisorEnabled);
  };

  // LLM Configuration: computed values and bidirectional auto-linking
  // (same reactive pattern as prompt input: LlmProviderApiKeySelector + onProviderChange)
  const selectedApiKey = useMemo(
    () => availableApiKeys.find((k) => k.id === llmApiKeyId),
    [availableApiKeys, llmApiKeyId],
  );
  const selectedApiKeyIsSubscription =
    selectedApiKey !== undefined && isPersonalSubscription(selectedApiKey);

  // The selected model's row: source of the derived provider (like prompt
  // input's initialProvider/currentProvider) and of the capability gating
  // for the no-tools notice below.
  const selectedLlmModelRow = useMemo(() => {
    if (!llmModel) return null;
    for (const models of Object.values(modelsByProvider)) {
      const match = models?.find((m) => m.dbId === llmModel);
      if (match) return match;
    }
    return null;
  }, [llmModel, modelsByProvider]);

  const currentLlmProvider: SupportedProvider | null =
    selectedLlmModelRow?.provider ?? null;

  // Pairing a no-tools model (e.g. Microsoft 365 Copilot) with a tooled
  // agent is allowed — chat omits the tools for that model — but the user
  // must learn that before the first message, not from a silent no-op.
  const showNoToolsModelNotice =
    selectedLlmModelRow?.capabilities?.supportsToolCalling === false &&
    (accessAllTools || selectedToolsCount > 0);

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
          setLlmModel(providerModels[0].dbId);
        }
      }
    },
    [availableApiKeys, currentLlmProvider, modelsByProvider],
  );

  // A team-scoped agent must have at least one team, otherwise it is
  // inaccessible to everyone (issue #6624). Applies to admins too.
  const requiresTeamSelection =
    scope === "team" && assignedTeamIds.length === 0;
  const hasNoAvailableTeams = !teams || teams.length === 0;

  const performSave = useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedSystemPrompt = systemPrompt.trim();
    const parsedDualLlmMaxRounds = Number.parseInt(dualLlmMaxRounds, 10);

    if (!trimmedName) {
      toast.error("Name is required");
      return;
    }

    // A team-scoped agent must have at least one team (issue #6624)
    if (scope === "team" && assignedTeamIds.length === 0) {
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

    // Persist the published-skill sets, each only when it changed (same
    // no-op-audit reasoning as the delegation sets below). The assignment PUT
    // carries the Auto toggle with it, so a mode flip alone is a change worth
    // writing. Skipped entirely while the reads behind the editors have not
    // succeeded: the sets on screen are then defaults, not the gateway's.
    const savePublishedSkills = async (targetAgentId: string) => {
      if (!showSkills || !skillsLoaded || !targetAgentId) return;
      if (
        hasUnsavedChanges(
          [...(currentSkillAssignments?.skillIds ?? [])].sort(),
          [...assignedSkillIds].sort(),
        ) ||
        (currentSkillAssignments?.accessAllSkills ?? false) !== accessAllSkills
      ) {
        await syncSkills.mutateAsync({
          agentId: targetAgentId,
          assignments: { accessAllSkills, skillIds: assignedSkillIds },
        });
      }
      if (
        hasUnsavedChanges(
          [...(currentSkillExclusions?.excludedSkillIds ?? [])].sort(),
          [...excludedSkillIds].sort(),
        )
      ) {
        await syncSkillExclusions.mutateAsync({
          agentId: targetAgentId,
          exclusions: { excludedSkillIds },
        });
      }
    };

    try {
      let savedAgentId: string;

      // Save tool changes FIRST (before agent update triggers refetch that clears pending changes)
      // Skip for built-in agents as they don't have editable tools
      if (agent && !isBuiltIn) {
        await agentToolsEditorRef.current?.saveChanges({
          resourceLabel: agentTypeDisplayName[agentType] || "resource",
        });
      }

      if (agent && isBuiltIn && builtInAgentName) {
        const builtInAgentConfig = getBuiltInAgentConfigForSave({
          builtInAgentName,
          autoConfigureOnToolDiscovery,
          maxRounds: parsedDualLlmMaxRounds,
        });

        const updated = await updateAgent.mutateAsync({
          id: agent.id,
          data: {
            builtInAgentConfig,
            systemPrompt: trimmedSystemPrompt || null,
            llmApiKeyId: llmApiKeyId || null,
            modelId: llmModel || null,
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
              modelId: llmModel || null,
              suggestedPrompts: validSuggestedPrompts,
            }),
            ...(supportsEnvironment && {
              environmentId: environmentId || null,
            }),
            ...(supportsIdentityProvider && {
              identityProviderId: identityProviderId || null,
            }),
            ...(agentType !== "llm_proxy" && {
              knowledgeBaseIds: knowledgeBaseIds,
              connectorIds: connectorIds,
              toolExposureMode,
              accessAllTools,
              accessAllSubagents,
            }),
            teams: assignedTeamIds,
            users: assignedUserIds,
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
        // Auto-mode exclusions (full-replace PUT; no-op when unchanged). Runs
        // AFTER the agent update so that when accessAllTools flips Custom→Auto,
        // the backend's switch-time pre-fill lands first and this full replace
        // is the authoritative last write of the set the user saw and edited.
        if (!isBuiltIn) {
          await agentToolExclusionsEditorRef.current?.saveChanges();
        }
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
            modelId: llmModel || null,
            suggestedPrompts: validSuggestedPrompts,
          }),
          ...(supportsEnvironment && {
            environmentId: environmentId || null,
          }),
          ...(supportsIdentityProvider && {
            identityProviderId: identityProviderId || null,
          }),
          ...(agentType !== "llm_proxy" && {
            knowledgeBaseIds: knowledgeBaseIds,
            connectorIds: connectorIds,
            toolExposureMode,
            accessAllTools,
            accessAllSubagents,
          }),
          teams: assignedTeamIds,
          users: assignedUserIds,
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
            // Auto-mode exclusions configured before the agent existed.
            await agentToolExclusionsEditorRef.current?.saveChanges({
              agentId: savedAgentId,
            });
            // Hooks staged before the agent existed.
            await agentHooksEditorRef.current?.saveChanges({
              agentId: savedAgentId,
            });
            // Published skills too, and before `onCreated` below: both call
            // sites close the dialog from it, so a rejection afterwards would
            // land on a screen that has already said "created successfully",
            // with the selection gone and a half-configured gateway left
            // behind. Inside the rollback instead, it deletes the agent.
            await savePublishedSkills(savedAgentId);
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

      // Sync delegations only when the target set actually changed (skip for
      // built-in agents). Re-sending the unchanged set on every save produced a
      // spurious no-op agent.updated audit record.
      if (
        !isBuiltIn &&
        savedAgentId &&
        hasUnsavedChanges(
          [...currentDelegations.map((d) => d.id)].sort(),
          [...delegationTargetIdsToSave].sort(),
        )
      ) {
        await syncDelegations.mutateAsync({
          agentId: savedAgentId,
          targetAgentIds: delegationTargetIdsToSave,
        });
      }

      // Persist the Auto-mode disabled-subagents set only when it changed (same
      // no-op-audit reasoning as delegations). Skipped for built-ins.
      if (
        !isBuiltIn &&
        savedAgentId &&
        hasUnsavedChanges(
          [...(currentSubagentExclusions?.excludedSubagentIds ?? [])].sort(),
          [...disabledSubagentIdsToSave].sort(),
        )
      ) {
        await syncSubagentExclusions.mutateAsync({
          agentId: savedAgentId,
          exclusions: { excludedSubagentIds: disabledSubagentIdsToSave },
        });
      }

      // Edit mode only: create mode wrote them inside the rollback above,
      // before `onCreated` closed the dialog.
      if (agent) {
        await savePublishedSkills(savedAgentId);
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
    assignedUserIds,
    labels,
    considerContextUntrusted,
    llmApiKeyId,
    llmModel,
    identityProviderId,
    environmentId,
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
    builtInAgentName,
    showSecurity,
    delegationTargetIdsToSave,
    currentDelegations,
    currentSubagentExclusions,
    disabledSubagentIdsToSave,
    updateAgent,
    createAgent,
    syncDelegations,
    syncSubagentExclusions,
    showSkills,
    skillsLoaded,
    accessAllSkills,
    assignedSkillIds,
    excludedSkillIds,
    currentSkillAssignments,
    currentSkillExclusions,
    syncSkills,
    syncSkillExclusions,
    onCreated,
    onOpenChange,
    supportsIdentityProvider,
    passthroughHeaders,
    deleteAgent,
    toolExposureMode,
    accessAllTools,
    accessAllSubagents,
    supportsEnvironment,
  ]);

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!isAdmin && scope === "team" && assignedTeamIds.length === 0) {
      toast.error("Please select at least one team");
      return;
    }
    await performSave();
  }, [name, isAdmin, scope, assignedTeamIds, performSave]);

  // Detect unsaved edits so any close path (Esc, backdrop, the X button, or the
  // Cancel button) prompts before discarding. Covers every form field held here
  // plus delegations and Auto-mode tool exclusions; per-tool selections live in
  // the tools editor child and are not part of this check (the All-tools/Custom
  // switch below is, though).
  const currentSnapshot = buildAgentFormSnapshot({
    name,
    icon,
    description,
    systemPrompt,
    suggestedPrompts,
    assignedTeamIds,
    assignedUserIds,
    labels,
    considerContextUntrusted,
    llmApiKeyId,
    llmModel,
    identityProviderId,
    environmentId,
    knowledgeBaseIds,
    connectorIds,
    scope,
    autoConfigureOnToolDiscovery,
    dualLlmMaxRounds,
    passthroughHeaders,
    toolExposureMode,
    accessAllTools,
    accessAllSubagents,
  });
  const isDirty =
    !readOnly &&
    initialSnapshotRef.current !== null &&
    (hasUnsavedChanges(initialSnapshotRef.current, currentSnapshot) ||
      hasUnsavedChanges(
        [...currentDelegations.map((delegate) => delegate.id)].sort(),
        [...selectedDelegationTargetIds].sort(),
      ) ||
      // Disabled subagents load async, so they're diffed against the fetched
      // baseline (same pattern as delegations above).
      hasUnsavedChanges(
        [...(currentSubagentExclusions?.excludedSubagentIds ?? [])].sort(),
        [...disabledSubagentIds].sort(),
      ) ||
      // Auto-mode exclusions load async, so they're diffed against the
      // baseline the editor reports (same pattern as delegations above)
      // rather than the open-time snapshot.
      (exclusionsState !== null &&
        hasUnsavedChanges(exclusionsState.initial, exclusionsState.current)) ||
      // Published skills load async too, so all three are diffed against their
      // fetched baselines rather than the open-time snapshot — and only once
      // those baselines exist, so a failed read is never mistaken for an edit.
      (showSkills &&
        skillsLoaded &&
        (hasUnsavedChanges(
          [...(currentSkillAssignments?.skillIds ?? [])].sort(),
          [...assignedSkillIds].sort(),
        ) ||
          (currentSkillAssignments?.accessAllSkills ?? false) !==
            accessAllSkills ||
          hasUnsavedChanges(
            [...(currentSkillExclusions?.excludedSkillIds ?? [])].sort(),
            [...excludedSkillIds].sort(),
          ))));
  const guard = useUnsavedChangesGuard({ isDirty, onOpenChange });

  const handleClose = guard.requestClose;

  return (
    <>
      <Dialog open={open} onOpenChange={guard.handleOpenChange}>
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
                      href={getDocsUrl(DocsPage.PlatformBuiltInSubagents)}
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
              <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4 pb-4 space-y-4">
                {agentType === "profile" && (
                  <Alert variant="warning">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      This is a legacy entity that works both as MCP Gateway and
                      LLM Proxy. It appears on both tables and shares Name,
                      Team, and Labels.
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

                    {/* Environment assignment (below description).
                      - Agent: binds the agent's code sandbox to a per-environment
                        Dagger engine + egress policy.
                      - LLM proxy / MCP gateway: assigns the deployment environment
                        so its usage falls under environment-scoped cost limits.
                      The advisor renders no selector: it is configured once for
                      the organization and reachable from every environment.
                      Renders disabled when only the default environment exists. */}
                    {(isInternalAgent ||
                      agentType === "llm_proxy" ||
                      agentType === "mcp_gateway") &&
                      !isAdvisorBuiltIn && (
                        <EnvironmentSelector
                          value={environmentId ?? null}
                          onChange={setEnvironmentId}
                          resource={getResourceForAgentType(agentType)}
                          helpText={environmentHelpText}
                        />
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
                                      Maximum of {MAX_SUGGESTED_PROMPTS}{" "}
                                      suggested prompts reached
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
                                aria-label="Remove suggested prompt"
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
                                  aria-label="Button Label"
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
                                  aria-label="Suggested prompt"
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                )}

                {/* Section 3: Tools & Knowledge Sources */}
                {showToolsAndSubagents && (
                  <div
                    className="rounded-lg border bg-card p-4 space-y-4"
                    data-testid={E2eTestId.AgentToolsSection}
                  >
                    <h3 className="text-sm font-semibold">
                      Tools & Knowledge Sources
                    </h3>
                    <div className="space-y-2">
                      <Tabs
                        value={autoToolsMode ? "auto" : "custom"}
                        onValueChange={(value) => {
                          const auto = value === "auto";
                          setAccessAllTools(auto);
                          // Dynamic access only works through the search/run
                          // dispatch surface, so picking it enables that mode.
                          if (auto) {
                            setToolExposureMode("search_and_run_only");
                          }
                        }}
                      >
                        <TabsList className="grid w-full grid-cols-2">
                          <TabsTrigger value="auto">Auto</TabsTrigger>
                          <TabsTrigger value="custom">Custom</TabsTrigger>
                        </TabsList>
                      </Tabs>
                      {autoToolsMode ? (
                        <ul className="space-y-1.5 pt-1 text-xs text-muted-foreground">
                          <li className="flex gap-2">
                            <CheckIcon className="mt-px size-3.5 shrink-0" />
                            Every MCP tool and knowledge source the calling user
                            can access, in this{" "}
                            {agentTypeDisplayName[agentType] || "agent"}'s
                            environment — new servers included automatically
                          </li>
                          <li className="flex gap-2">
                            <CheckIcon className="mt-px size-3.5 shrink-0" />
                            Credentials resolve at call time per each server's
                            default credential setting — on behalf of the
                            calling user unless the server always uses one
                            account
                          </li>
                          <li className="flex gap-2">
                            <CheckIcon className="mt-px size-3.5 shrink-0" />
                            <span>
                              Tools are discovered on demand — the catalog never
                              burns context tokens.{" "}
                              <ExternalDocsLink
                                href={toolExposureDocsUrl}
                                className="underline"
                                showIcon={false}
                              >
                                Learn more
                              </ExternalDocsLink>
                            </span>
                          </li>
                        </ul>
                      ) : (
                        <p className="pt-1 text-xs text-muted-foreground">
                          Only the tools and knowledge sources you assign below
                          are available to this{" "}
                          {agentTypeDisplayName[agentType] || "agent"}.
                        </p>
                      )}
                      {/* Auto-mode exclusions; kept mounted while hidden so
                        pending edits and the save-time ref survive switching
                        to "Custom". */}
                      <div
                        className={cn(
                          "space-y-2 pt-2",
                          !autoToolsMode && "hidden",
                        )}
                      >
                        <p className="text-sm text-muted-foreground">
                          Disabled tools
                        </p>
                        <p className="text-xs text-muted-foreground">
                          These tools stay disabled for this{" "}
                          {agentTypeDisplayName[agentType] || "agent"} while
                          Auto mode is on.
                        </p>
                        <AgentToolExclusionsEditor
                          ref={agentToolExclusionsEditorRef}
                          agentId={agent?.id}
                          seedDefaultExclusions={seedDefaultExclusions}
                          pendingAssignedToolIds={pendingSelectedToolIds}
                          onStateChange={setExclusionsState}
                        />
                      </div>
                      {/* Kept mounted while hidden so pending selections and the
                        save-time ref survive switching to "Auto". */}
                      <div
                        className={cn("space-y-3", autoToolsMode && "hidden")}
                      >
                        <div className="space-y-2">
                          <p className="text-sm text-muted-foreground">
                            Tools ({selectedToolsCount})
                          </p>
                          {((!agent && selectedToolsCount > 0) ||
                            environmentScopingEnabled) && (
                            <p className="text-xs text-muted-foreground">
                              {!agent && selectedToolsCount > 0 && (
                                <>
                                  Some recommended {appName} MCP tools are
                                  pre-selected for you.{" "}
                                </>
                              )}
                              {environmentScopingEnabled && (
                                <>
                                  MCP servers are filtered to the selected
                                  environment
                                  {agentEnvironmentName
                                    ? ` ("${agentEnvironmentName}")`
                                    : " (Default)"}
                                  .
                                </>
                              )}
                            </p>
                          )}
                          <AgentToolsEditor
                            ref={agentToolsEditorRef}
                            agentId={agent?.id}
                            assignmentScope={scope}
                            assignmentTeamIds={assignedTeamIds}
                            onSelectedCountChange={setSelectedToolsCount}
                            onSelectedToolIdsChange={setPendingSelectedToolIds}
                            environmentScopingEnabled={
                              environmentScopingEnabled
                            }
                            agentEnvironmentId={environmentId ?? null}
                            agentEnvironmentName={agentEnvironmentName}
                            onConflictsChange={setMcpEnvConflicts}
                            openComboboxOnMount={openToolsCombobox}
                            includeAppCatalogs={shouldOfferAppCatalogs(
                              agentType,
                            )}
                          />
                        </div>
                        <div className="space-y-2">
                          <p className="text-sm text-muted-foreground">
                            Knowledge Sources
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Assigning a source gives this{" "}
                            {agentType === "mcp_gateway" ? "gateway" : "agent"}{" "}
                            a <code>query_knowledge_sources</code> tool to
                            search it.
                          </p>
                          {!isKnowledgeConfigured ? (
                            <>
                              <Button
                                variant="outline"
                                disabled
                                className="w-full justify-between font-normal"
                              >
                                Knowledge not configured
                                <ChevronDown className="ml-2 h-4 w-4 opacity-50" />
                              </Button>
                              <p className="text-xs text-muted-foreground">
                                Configure an embedding model to use knowledge
                                sources.
                                {canAccessKnowledgeSettings && (
                                  <>
                                    {" "}
                                    <Link
                                      href="/settings/knowledge"
                                      className="underline underline-offset-2"
                                    >
                                      Configure knowledge
                                    </Link>
                                  </>
                                )}
                              </p>
                            </>
                          ) : knowledgeBases.length === 0 &&
                            connectors.length === 0 ? (
                            <>
                              <Button
                                variant="outline"
                                disabled
                                className="w-full justify-between font-normal"
                              >
                                No knowledge sources available
                                <ChevronDown className="ml-2 h-4 w-4 opacity-50" />
                              </Button>
                              <p className="text-xs text-muted-foreground">
                                No knowledge bases or connectors yet.{" "}
                                <Link
                                  href="/knowledge/connectors"
                                  className="underline underline-offset-2"
                                >
                                  Add a connector
                                </Link>
                                .
                              </p>
                            </>
                          ) : (
                            <Popover modal>
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  className="w-full justify-between font-normal"
                                >
                                  {(() => {
                                    const totalSelected =
                                      knowledgeBaseIds.length +
                                      connectorIds.length;
                                    return totalSelected === 0 ? (
                                      <span>
                                        Select connectors or knowledge bases
                                      </span>
                                    ) : (
                                      <span>
                                        {totalSelected} source
                                        {totalSelected > 1 ? (
                                          <span>s</span>
                                        ) : null}{" "}
                                        selected
                                      </span>
                                    );
                                  })()}
                                  <ChevronDown className="ml-2 h-4 w-4 opacity-50" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent
                                className="w-96 p-0"
                                align="start"
                              >
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
                                          const isSelected =
                                            connectorIds.includes(connector.id);
                                          // Environment isolation: a connector in
                                          // another environment can't be used by
                                          // this agent, so it's shown disabled.
                                          const isEnvIncompatible =
                                            environmentScopingEnabled &&
                                            (connector.environmentId ??
                                              null) !== (environmentId ?? null);
                                          return (
                                            <CommandItem
                                              key={connector.id}
                                              value={connector.name}
                                              disabled={isEnvIncompatible}
                                              className="data-[selected=true]:bg-transparent"
                                              onSelect={() => {
                                                if (isEnvIncompatible) return;
                                                setConnectorIds((prev) =>
                                                  isSelected
                                                    ? prev.filter(
                                                        (id) =>
                                                          id !== connector.id,
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
                                                  {isEnvIncompatible ? (
                                                    <span>
                                                      Different environment
                                                    </span>
                                                  ) : connector.description ? (
                                                    <span>
                                                      {connector.description}
                                                    </span>
                                                  ) : (
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
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Progressive loading is only a choice for Custom mode —
                      "Auto" requires the search/run dispatch surface. */}
                    {!autoToolsMode && (
                      <div className="flex items-center justify-between gap-4">
                        <div className="space-y-0.5">
                          <Label htmlFor="load-tools-when-needed">
                            Load tools progressively when needed
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            Exposes <code>{TOOL_SEARCH_TOOLS_SHORT_NAME}</code>{" "}
                            and <code>{TOOL_RUN_TOOL_SHORT_NAME}</code> instead
                            of the full list.{" "}
                            <ExternalDocsLink
                              href={toolExposureDocsUrl}
                              className="underline"
                              showIcon={false}
                            >
                              Learn more
                            </ExternalDocsLink>
                          </p>
                        </div>
                        <Switch
                          id="load-tools-when-needed"
                          checked={toolExposureMode === "search_and_run_only"}
                          onCheckedChange={(checked) =>
                            setToolExposureMode(
                              checked ? "search_and_run_only" : "full",
                            )
                          }
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Section 4: Subagents */}
                {showToolsAndSubagents && (
                  <div className="rounded-lg border bg-card p-4 space-y-4">
                    <h3 className="text-sm font-semibold">Subagents</h3>
                    {!subagentSetsLoaded ? (
                      <p className="text-sm text-muted-foreground">
                        <span>Loading subagents…</span>
                      </p>
                    ) : (
                      <div className="space-y-2">
                        <Tabs
                          value={accessAllSubagents ? "auto" : "custom"}
                          onValueChange={handleSubagentModeChange}
                        >
                          <TabsList className="grid w-full grid-cols-2">
                            <TabsTrigger value="auto">Auto</TabsTrigger>
                            <TabsTrigger value="custom">Custom</TabsTrigger>
                          </TabsList>
                        </Tabs>
                        {accessAllSubagents ? (
                          <div className="space-y-2">
                            <ul className="space-y-1.5 pt-1 text-xs text-muted-foreground">
                              <li className="flex gap-2">
                                <CheckIcon className="mt-px size-3.5 shrink-0" />
                                Can delegate to any agent the calling user can
                                access, in this{" "}
                                {agentTypeDisplayName[agentType] || "agent"}'s
                                environment — new agents included automatically
                              </li>
                              <li className="flex gap-2">
                                <CheckIcon className="mt-px size-3.5 shrink-0" />
                                Disable specific agents below to keep them off
                                the delegation surface
                              </li>
                            </ul>
                            <div className="space-y-1.5">
                              <p className="text-sm text-muted-foreground">
                                Disabled subagents ({disabledSubagentCount})
                              </p>
                              <SubagentsEditor
                                availableAgents={allInternalAgents}
                                selectedAgentIds={disabledSubagentIds}
                                onSelectionChange={setDisabledSubagentIds}
                                currentAgentId={agent?.id}
                                placeholder="Search agents to disable..."
                                showCreateAction={false}
                                tone="exclude"
                              />
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            <p className="pt-1 text-xs text-muted-foreground">
                              Only the subagents you assign below can be
                              delegated to by this{" "}
                              {agentTypeDisplayName[agentType] || "agent"}.
                            </p>
                            <p className="text-sm text-muted-foreground">
                              Subagents ({delegationTargetCount})
                            </p>
                            <SubagentsEditor
                              availableAgents={allInternalAgents}
                              selectedAgentIds={selectedDelegationTargetIds}
                              onSelectionChange={setSelectedDelegationTargetIds}
                              currentAgentId={agent?.id}
                            />
                          </div>
                        )}
                        {/* Outside the Auto/Custom split on purpose: whether this
                        agent can consult the advisor is one decision, even
                        though the two modes record it differently. */}
                        {advisorAgentId && (
                          <div className="flex items-center justify-between gap-4 border-t pt-4">
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-2">
                                <Label htmlFor="consult-advisor">
                                  Enable Advisor
                                </Label>
                                <Badge
                                  variant="secondary"
                                  className="px-1.5 py-0 text-[10px]"
                                >
                                  Beta
                                </Badge>
                              </div>
                              <p className="text-xs text-muted-foreground">
                                Pairs this{" "}
                                {agentTypeDisplayName[agentType] || "agent"}{" "}
                                with a stronger model it consults at key
                                moments. Those calls are billed at the advisor
                                model&apos;s rates, and usually cost less than
                                running the stronger model throughout.{" "}
                                {/* New tab: this dialog holds unsaved edits that
                                navigating away would discard. */}
                                <Link
                                  href={`/agents?edit=${advisorAgentId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 underline underline-offset-4"
                                >
                                  Edit the Advisor agent
                                  <span className="sr-only">
                                    (opens in new tab)
                                  </span>
                                  <ExternalLink
                                    aria-hidden
                                    className="h-3 w-3"
                                  />
                                </Link>
                                .
                              </p>
                            </div>
                            <Switch
                              id="consult-advisor"
                              checked={advisorEnabled}
                              onCheckedChange={writeAdvisorEnabled}
                              data-testid={E2eTestId.ConsultAdvisorSwitch}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Section 5: Skills published over MCP (SEP-2640). Behind the
                  draft-extension feature flag. */}
                {showSkills && (
                  <div className="rounded-lg border bg-card p-4 space-y-4">
                    <h3 className="text-sm font-semibold">Published skills</h3>
                    <p className="text-xs text-muted-foreground">
                      Skills this {agentTypeDisplayName[agentType] || "agent"}{" "}
                      serves to MCP clients as <code>skill://</code> resources,
                      alongside the client's own.
                    </p>
                    {/* Nothing editable until the reads behind it succeed. The
                      controls below are seeded from those reads and saved back
                      as a full replace, so rendering their defaults early would
                      show a gateway publishing everything as publishing
                      nothing — and let an admin save that reading. */}
                    {skillsFailed ? (
                      <p className="text-sm text-destructive">
                        <span>
                          Could not load the published skills for this{" "}
                          {agentTypeDisplayName[agentType] || "agent"}. Close
                          and reopen to try again — the published set stays as
                          it is, and your other changes still save.
                        </span>
                      </p>
                    ) : !skillsLoaded ? (
                      <p className="text-sm text-muted-foreground">
                        <span>Loading published skills…</span>
                      </p>
                    ) : (
                      <div className="space-y-2">
                        <Tabs
                          value={accessAllSkills ? "auto" : "custom"}
                          onValueChange={(value) =>
                            setAccessAllSkills(value === "auto")
                          }
                        >
                          <TabsList className="grid w-full grid-cols-2">
                            <TabsTrigger value="auto">Auto</TabsTrigger>
                            <TabsTrigger value="custom">Custom</TabsTrigger>
                          </TabsList>
                        </Tabs>
                        {accessAllSkills ? (
                          <div className="space-y-2">
                            <ul className="space-y-1.5 pt-1 text-xs text-muted-foreground">
                              <li className="flex gap-2">
                                <CheckIcon className="mt-px size-3.5 shrink-0" />
                                Publishes every organization-scoped skill in
                                this{" "}
                                {agentTypeDisplayName[agentType] || "agent"}
                                's environment — new ones included automatically
                              </li>
                              <li className="flex gap-2">
                                <CheckIcon className="mt-px size-3.5 shrink-0" />
                                Team and personal skills are never published
                                automatically; assign them in Custom instead
                              </li>
                            </ul>
                            <div className="space-y-1.5">
                              <p className="text-sm text-muted-foreground">
                                Excluded skills ({excludedSkillIds.length})
                              </p>
                              <AgentSkillsEditor
                                availableSkills={orgScopedSkills}
                                selectedSkillIds={excludedSkillIds}
                                onSelectionChange={setExcludedSkillIds}
                                gateway={skillGateway}
                                currentUserId={currentUserId}
                                tone="exclude"
                                onSearchChange={setSkillSearch}
                                isSearching={skillSearchPending}
                                placeholder="Search skills to exclude..."
                              />
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            <p className="pt-1 text-xs text-muted-foreground">
                              Only the skills you assign below are published.
                              Templated and agent-delegated skills cannot be
                              published, a personal skill only by its own
                              author, and a skill restricted to other
                              environments not at all.
                            </p>
                            <p className="text-sm text-muted-foreground">
                              Skills ({assignedSkillIds.length})
                            </p>
                            <AgentSkillsEditor
                              availableSkills={availableSkills}
                              selectedSkillIds={assignedSkillIds}
                              onSelectionChange={setAssignedSkillIds}
                              gateway={skillGateway}
                              currentUserId={currentUserId}
                              onSearchChange={setSkillSearch}
                              isSearching={skillSearchPending}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Hooks (internal agents only; shown when the agent runtime is
                  available, since hooks run in its sandbox). In create mode the
                  editor stages hooks locally and persists them via the ref once
                  the agent exists. */}
                {agentHooksEnabled && isInternalAgent && !isBuiltIn && (
                  <AgentHooksEditor
                    ref={agentHooksEditorRef}
                    agentId={agent?.id}
                  />
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
                        assignedUserIds={assignedUserIds}
                        onUserIdsChange={setAssignedUserIds}
                        hasNoAvailableTeams={hasNoAvailableTeams}
                        showTeamRequired={true}
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
                              models. This agent will use the
                              organization&apos;s default model configuration.
                            </AlertDescription>
                          </Alert>
                        ) : (
                          <>
                            {selectedApiKeyIsSubscription ? (
                              <Alert>
                                <InfoIcon className="h-4 w-4" />
                                <AlertDescription>
                                  Each person using this agent must connect
                                  their own subscription account. No credential
                                  is shared.
                                </AlertDescription>
                              </Alert>
                            ) : (
                              <p className="text-sm text-muted-foreground">
                                {selectedApiKey &&
                                selectedApiKey.scope !== "org" ? (
                                  <span>
                                    Selected key will be available to everyone
                                    who has access to this agent.
                                  </span>
                                ) : null}
                              </p>
                            )}
                            <div className="flex flex-wrap items-center gap-2">
                              <LlmProviderApiKeyDropdown
                                availableKeys={availableApiKeys}
                                selectedApiKeyId={llmApiKeyId}
                                open={apiKeySelectorOpen}
                                onOpenChange={setApiKeySelectorOpen}
                                onSelectKey={(keyId) => {
                                  handleLlmApiKeyChange(keyId);
                                  setApiKeySelectorOpen(false);
                                }}
                                currentProvider={
                                  currentLlmProvider ?? undefined
                                }
                                triggerVariant="button"
                                triggerClassName="h-8 max-w-[250px] text-xs"
                                popoverClassName="w-96"
                                popoverPortal={false}
                                searchPlaceholder="Search API keys..."
                                allowOrganizationDefault
                                organizationDefaultSelected={!llmApiKeyId}
                                onSelectOrganizationDefault={() => {
                                  setLlmApiKeyId(null);
                                  setLlmModel(null);
                                  lastAutoSelectedProviderRef.current = null;
                                  setApiKeySelectorOpen(false);
                                }}
                              />
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
                            {showNoToolsModelNotice && (
                              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                                <InfoIcon
                                  className="mt-0.5 size-3 shrink-0"
                                  aria-hidden="true"
                                />
                                <span>
                                  This model doesn&apos;t support tools, so this{" "}
                                  {agentTypeDisplayName[agentType] || "agent"}
                                  &apos;s tools won&apos;t be used in its chats.
                                  Pick a different model to use tools.
                                </span>
                              </p>
                            )}
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
                          <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 flex-1 min-w-0">
                                <Label>Labels</Label>
                              </div>
                            </div>
                            <ProfileLabels
                              ref={agentLabelsRef}
                              labels={labels}
                              onLabelsChange={setLabels}
                              showLabel={false}
                            />
                          </div>

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
                                    When enabled, the context is always
                                    considered sensitive. Only tools allowed to
                                    run in sensitive context will be permitted.
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
                                      aria-label="Remove header"
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
                                  aria-label="Add passthrough header"
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
                                    if (
                                      BLOCKED_PASSTHROUGH_HEADERS.has(value)
                                    ) {
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
                                  {agentType === "llm_proxy" ||
                                  agentType === "agent"
                                    ? "Identity Provider (JWKS)"
                                    : "Identity Provider (Enterprise/JWKS)"}
                                </Label>
                                <p className="text-sm text-muted-foreground">
                                  {agentType === "llm_proxy"
                                    ? `Select the OIDC identity provider this LLM Proxy should trust for JWKS JWT authentication. Leave this unset to keep using provider API keys and virtual keys without IdP JWT validation.`
                                    : agentType === "agent"
                                      ? `Select the OIDC identity provider this agent should trust for direct JWKS JWT authentication over A2A (Webhook). Leave this unset to keep authenticating A2A requests with ${appName} platform tokens.`
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
                                        {provider.providerId} ({provider.issuer}
                                        )
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
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <Label>Labels</Label>
                        </div>
                      </div>
                      <ProfileLabels
                        ref={agentLabelsRef}
                        labels={labels}
                        onLabelsChange={setLabels}
                        showLabel={false}
                      />
                    </div>
                  </div>
                )}
              </div>
            </fieldset>
            {!readOnly && mcpEnvConflicts.length > 0 && (
              <Alert variant="warning" className="mt-4">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>
                  {mcpEnvConflicts.length} MCP server
                  {mcpEnvConflicts.length === 1 ? null : <span>s</span>} not in
                  this environment
                </AlertTitle>
                <AlertDescription>
                  <p>
                    Remove {mcpEnvConflicts.length === 1 ? "it" : "them"} or
                    change the environment before saving:{" "}
                    <span className="font-medium text-foreground">
                      {mcpEnvConflicts.map((c) => c.name).join(", ")}
                    </span>
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() =>
                      agentToolsEditorRef.current?.removeIncompatibleTools()
                    }
                  >
                    Remove incompatible
                  </Button>
                </AlertDescription>
              </Alert>
            )}
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
                    mcpEnvConflicts.length > 0 ||
                    (scope === "team" && hasNoAvailableTeams)
                  }
                >
                  {(isSaving ||
                    createAgent.isPending ||
                    updateAgent.isPending) && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  <span>{agent ? "Update" : "Create"}</span>
                </Button>
              )}
            </DialogStickyFooter>
          </DialogForm>
        </DialogContent>
      </Dialog>
      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={guard.keepEditing}
        onDiscard={guard.discardChanges}
      />
    </>
  );
}

type AgentFormFields = {
  name: string;
  icon: string | null;
  description: string;
  systemPrompt: string;
  suggestedPrompts: Array<{ summaryTitle: string; prompt: string }>;
  assignedTeamIds: string[];
  assignedUserIds: string[];
  labels: ProfileLabel[];
  considerContextUntrusted: boolean;
  llmApiKeyId: string | null;
  llmModel: string | null;
  identityProviderId: string | null | undefined;
  environmentId: string | null | undefined;
  knowledgeBaseIds: string[];
  connectorIds: string[];
  scope: AgentScope;
  autoConfigureOnToolDiscovery: boolean;
  dualLlmMaxRounds: string;
  passthroughHeaders: string[];
  toolExposureMode: ToolExposureMode;
  accessAllTools: boolean;
  accessAllSubagents: boolean;
};

// Normalizes set-like id arrays (order-independent) so reselecting the same
// teams/knowledge bases/connectors in a different order isn't mistaken for an
// edit when comparing the pristine and current form snapshots.
function buildAgentFormSnapshot(fields: AgentFormFields) {
  return {
    ...fields,
    assignedTeamIds: [...fields.assignedTeamIds].sort(),
    knowledgeBaseIds: [...fields.knowledgeBaseIds].sort(),
    connectorIds: [...fields.connectorIds].sort(),
  };
}
