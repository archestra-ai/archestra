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
  ChevronRight,
  Globe,
  InfoIcon,
  PackageSearch,
  Plus,
  RotateCcw,
  Settings2,
  Unplug,
  User,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  AgentHooksEditor,
  type AgentHooksEditorRef,
} from "@/components/agent-hooks-editor";
import { AgentIcon, type AgentIconVariant } from "@/components/agent-icon";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import {
  agentDetailHref,
  agentListHref,
  agentPageKindForType,
} from "@/components/agent-pages/agent-page-config";
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
import { IdentityFields } from "@/components/identity-fields";
import {
  type KnowledgeSourceOption,
  KnowledgeSourcesEditor,
} from "@/components/knowledge-sources-editor";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import {
  formatPermissionRequirement,
  PermissionRequirementHint,
} from "@/components/permission-requirement-hint";
import { SettingIcon } from "@/components/setting-icon";
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
import { ExpandableText } from "@/components/ui/expandable-text";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
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
import { WizardFooter } from "@/components/wizard-footer";

/**
 * What the agent visibility control offers. Wider than the stored scope: an
 * agent shared with named people persists as `personal` plus grants.
 */
type AgentVisibilityChoice = AgentScope | "user";

import {
  useCreateProfile,
  useDefaultAgentId,
  useDelegationTargetAgents,
  useDeleteProfile,
  useProfile,
  useUpdateDefaultAgentId,
  useUpdateProfile,
} from "@/lib/agent.query";
import {
  useAgentKnowledgeSourceExclusions,
  useUpdateAgentKnowledgeSourceExclusions,
} from "@/lib/agent-knowledge-source-exclusions.query";
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
import { useDefaultEnvironmentSeed } from "@/lib/hooks/use-default-environment-seed";
import { useOrganizationDefaultModel } from "@/lib/hooks/use-organization-default-model";
import { useConnectors } from "@/lib/knowledge/connector.query";
import {
  useIsKnowledgeBaseConfigured,
  useKnowledgeBases,
} from "@/lib/knowledge/knowledge-base.query";
import { isPersonalSubscription } from "@/lib/llm-key-subscription";
import { useLlmModelsByProvider } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useOrganization } from "@/lib/organization.query";
import { useSkillsPaginated } from "@/lib/skills/skill.query";
import { useAssignableTeams } from "@/lib/teams/team.query";
import { cn, isReportedApiError } from "@/lib/utils";
import { useAgentEnvironmentConflicts } from "./agent-environment-conflicts";
import {
  getDescriptionPlaceholder,
  getNamePlaceholder,
  MISSING_CREDENTIAL_BEHAVIOR_OPTIONS,
  MISSING_CREDENTIAL_TONE,
  normalizeSuggestedPrompts,
  shouldOfferAppCatalogs,
  shouldShowDescriptionField,
  TOOL_CONNECTION_PROMPTING,
} from "./agent-form.utils";

type Agent = archestraApiTypes.GetAllAgentsResponses["200"][number];
type ToolExposureMode = Agent["toolExposureMode"];
type MissingCredentialBehavior = Agent["missingCredentialBehavior"];

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
                href: "/agents/new",
              }
            : undefined
        }
      />
    </div>
  );
}

// Helper functions for type-specific UI text
function getSuccessMessage(agentType: AgentType, isUpdate: boolean): string {
  const messages: Record<string, { create: string; update: string }> = {
    mcp_gateway: {
      create: "MCP Gateway created successfully",
      update: "MCP Gateway updated successfully",
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
      label={`Who can use this ${agentTypeDisplayName[agentType] || "agent"}`}
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

/**
 * The form's top-level section groups — the setup wizard's steps. The edit
 * wizard mounts one group per step; the create wizard mounts them all on one
 * form and shows one at a time; the default renders every group, which is
 * the whole configuration in one scroll.
 *
 * - `configuration`: identity (name, icon, description, environment), who can
 *   use it, and the instruction, suggested prompts and model of an internal
 *   agent.
 * - `tools`: everything the agent reaches — tools and knowledge sources,
 *   subagents, published skills, and hooks.
 * - `advanced`: labels, security, passthrough headers, identity provider.
 */
export type AgentFormSection = "configuration" | "tools" | "advanced";

/** The default render: the whole form. */
const AGENT_FORM_SECTIONS: readonly AgentFormSection[] = [
  "configuration",
  "tools",
  "advanced",
];

/** What a caller-rendered footer gets to build its buttons from. */
export interface AgentFormFooterState {
  /** Create mode (no agent yet) vs. edit mode. */
  isCreate: boolean;
  /** A save is in flight — disable everything that would start another. */
  isSaving: boolean;
  /** The form differs from what is saved (edit mode; always true in create). */
  isDirty: boolean;
  /**
   * The submit button may be enabled: a name is present, the visibility choice
   * is complete, no cross-environment MCP conflicts remain, and no save is in
   * flight.
   */
  canSubmit: boolean;
}

export interface AgentFormProps {
  /** Agent to edit. If null/undefined, creates a new agent */
  agent?: Agent | null;
  /** Agent type: 'agent' for internal agents with prompts, 'profile' for external profiles */
  agentType?: AgentType;
  defaultIconType?: AgentIconVariant;
  /** Callback when a new agent/profile is created (not called for updates) */
  onCreated?: (created: { id: string; name: string }) => void;
  /** Callback after an existing agent was saved (not called for creates). */
  onSaved?: (saved: { id: string; name: string }) => void;
  /**
   * Reports whether the form holds unsaved edits, so the page hosting it can
   * guard navigation away (a wizard step change, a back link) the way the
   * modal used to guard its close.
   */
  onDirtyChange?: (isDirty: boolean) => void;
  /**
   * Which section groups to mount; defaults to all of them. An edit save
   * writes only the mounted groups' fields, so a wizard step that mounts one
   * group leaves the others exactly as saved.
   */
  sections?: readonly AgentFormSection[];
  /**
   * The one mounted group on screen; the others stay mounted but hidden. The
   * create wizard steps through every group on one mount, so each editor
   * keeps what was picked on it until the create at the end.
   */
  activeSection?: AgentFormSection;
  /**
   * Whether submitting the form saves. Off on the create wizard's earlier
   * steps: Enter in a field must not create the record before the last step
   * offers to.
   */
  submitEnabled?: boolean;
  /**
   * Renders the submit row — the page owns it, so that its Cancel/Back/Next
   * controls sit in the same row as the submit. Must render a `type="submit"`
   * button, or the form cannot be saved at all.
   */
  footer: (state: AgentFormFooterState) => ReactNode;
  /** When true, all fields are disabled and the save button is hidden */
  readOnly?: boolean;
  /** When true, the tools "Add MCP server" combobox starts open. */
  openToolsCombobox?: boolean;
}

/**
 * The agent / LLM proxy / MCP gateway configuration form, embeddable in a
 * page. Callers give it a fresh mount per agent (`key={agent.id}`): several of
 * its controls are seeded from per-agent requests that land after mount —
 * delegations, subagent exclusions, the published-skill sets — and reusing a
 * mount across agents would render one agent's configuration under another's
 * name until those land, and a save would write it onto the wrong agent.
 */
export function AgentForm({
  agent,
  agentType = "profile",
  defaultIconType = "agent",
  onCreated,
  onSaved,
  onDirtyChange,
  sections = AGENT_FORM_SECTIONS,
  activeSection,
  submitEnabled = true,
  footer,
  readOnly = false,
  openToolsCombobox = false,
}: AgentFormProps) {
  const appName = useAppName();
  const mountedSections = new Set<AgentFormSection>(sections);
  const showConfigurationSections = mountedSections.has("configuration");
  const showToolsSections = mountedSections.has("tools");
  const showAdvancedSections = mountedSections.has("advanced");
  const isActiveSection = (group: AgentFormSection) =>
    activeSection === undefined || activeSection === group;
  const supportsSubagents = agentType === "agent";
  const shouldLoadIdentityProviders =
    agentType === "mcp_gateway" || agentType === "agent";
  const shouldLoadKnowledgeSources = true;
  const shouldLoadLlmConfiguration = agentType === "agent";
  const { data: canReadAgents } = useHasPermissions({ agent: ["read"] });

  const { data: allInternalAgents = [] } = useDelegationTargetAgents({
    enabled: supportsSubagents && !!canReadAgents,
  });
  const createAgent = useCreateProfile();
  const updateAgent = useUpdateProfile();
  // Only for the create rollback: a refused follow-up write deletes the record
  // the create just made, so nothing half set up is left behind.
  const deleteAgent = useDeleteProfile();
  const updateDefaultAgentId = useUpdateDefaultAgentId();
  const syncDelegations = useSyncAgentDelegations();
  // Every set below is seeded from its own request and saved back as a full
  // replace, so all of them gate on `isSuccess` rather than `isFetched`:
  // `isFetched` also counts a failed attempt, and seeding an empty set from one
  // turns a single failed GET into a save that deletes what it could not read.
  const { data: currentDelegations = [], isSuccess: delegationsLoaded } =
    useAgentDelegations(supportsSubagents ? agent?.id : undefined);
  const syncSubagentExclusions = useUpdateAgentSubagentExclusions();
  const syncKnowledgeSourceExclusions =
    useUpdateAgentKnowledgeSourceExclusions();
  const {
    data: currentSubagentExclusions,
    isSuccess: subagentExclusionsLoaded,
  } = useAgentSubagentExclusions(supportsSubagents ? agent?.id : undefined);
  // Which skills this gateway publishes over `skill://` (SEP-2640). A gateway
  // surface only: publishing is what an MCP gateway is for, while an agent
  // reaches skills through `load_skill` in its own runtime and has no client
  // to serve `skill://` resources to. Legacy `profile` rows are gateways under
  // an older name, so they keep the control. Shown only where the deployment
  // has enabled the draft extension; the API enforces the same split.
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
    (agentType === "mcp_gateway" || agentType === "profile");
  const loadSkills = showSkills;
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
  const advisorDocsUrl = getDocsUrl(
    DocsPage.PlatformBuiltInSubagents,
    "advisor",
  );
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
  const { data: environmentsData } = useEnvironments(environmentScopingEnabled);
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
  const {
    data: currentKnowledgeSourceExclusions,
    isSuccess: knowledgeSourceExclusionsLoaded,
  } = useAgentKnowledgeSourceExclusions(
    shouldLoadKnowledgeSources && canReadKnowledgeBase ? agent?.id : undefined,
  );
  const agentLlmApiKeyId = agent?.llmApiKeyId;
  const { data: availableApiKeys = [] } = useAvailableLlmProviderApiKeys({
    includeKeyId: agentLlmApiKeyId ?? undefined,
    enabled: shouldLoadLlmConfiguration && !!canReadLlmProviderApiKeys,
  });
  const { modelsByProvider } = useLlmModelsByProvider({
    enabled: shouldLoadLlmConfiguration && !!canReadLlmModels,
  });

  // Fetch fresh agent data on mount, so a stale row from a list is not what
  // the form is seeded from.
  const { data: freshAgent, refetch: refetchAgent } = useProfile(agent?.id);
  // What the form is seeded from, and so what "did this field change?" is
  // measured against: the fresh read once it lands, the caller's row until then.
  const persistedAgent = freshAgent || agent;
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
    enabled: !!canReadTeams,
  });
  const agentLabelsRef = useRef<ProfileLabelsRef>(null);
  const agentToolsEditorRef = useRef<AgentToolsEditorRef>(null);
  const agentToolExclusionsEditorRef =
    useRef<AgentToolExclusionsEditorRef>(null);
  const agentHooksEditorRef = useRef<AgentHooksEditorRef>(null);
  // Snapshot of the form's pristine values, captured whenever the form
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

  // One definition of "in this record's environment", used by the Custom
  // picker's disabled state below and by the set of sources Auto mode offers
  // to disable.
  const isInSelectedEnvironment = (connectorEnvironmentId: string | null) =>
    !environmentScopingEnabled ||
    (connectorEnvironmentId ?? null) === (environmentId ?? null);
  const environmentConnectors = connectors.filter((connector) =>
    isInSelectedEnvironment(connector.environmentId ?? null),
  );
  const agentEnvironmentName =
    environments.find((env) => env.id === environmentId)?.name ?? null;
  const [mcpEnvConflicts, setMcpEnvConflicts] = useState<McpEnvConflict[]>([]);
  // Unsaved tool/credential picks in the Custom tools editor. It keeps those
  // in its own state and writes them from `saveChanges`, so without this
  // report the form's dirty check — and every control keyed off it — would
  // read a tools-only edit as nothing to save.
  const [hasPendingToolChanges, setHasPendingToolChanges] = useState(false);
  const [scope, setScope] = useState<AgentScope>("personal");
  // The caller's personal default lives on the member, not the agent, so it is
  // read from its own query and tracked as an override on top: null until the
  // switch is touched, so a late-arriving query result cannot be mistaken for
  // an edit.
  const { data: memberDefaultAgentId } = useDefaultAgentId();
  const [personalDefaultOverride, setPersonalDefaultOverride] = useState<
    boolean | null
  >(null);
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
  const [missingCredentialBehavior, setMissingCredentialBehavior] =
    useState<MissingCredentialBehavior>("allow");
  // New agents default to Auto mode (implicit access to all tools); editing an
  // existing agent starts from its stored value. Seeded here rather than only
  // in the reset effect below, which runs after the first commit: an existing
  // Custom agent would otherwise render one frame with the Auto tab selected,
  // and the Auto tab's editor would begin loading data it does not need.
  const [accessAllTools, setAccessAllTools] = useState(
    agent ? (agent.accessAllTools ?? false) : true,
  );
  // Auto subagent mode: new agents default to Auto (may delegate to any agent
  // the caller can access); editing overwrites this from the stored value.
  const [accessAllSubagents, setAccessAllSubagents] = useState(true);
  // Delegation targets excluded from the Auto surface ("Auto All Except Some").
  // Inert while in Custom subagent mode. Seeded async from the backend.
  const [disabledSubagentIds, setDisabledSubagentIds] = useState<string[]>([]);
  const [disabledKnowledgeSourceIds, setDisabledKnowledgeSourceIds] = useState<
    string[]
  >([]);
  // Both knowledge fields are one list of the same shape; the Custom one spans
  // two tables, so its ids are namespaced by kind and unpicked apart on toggle.
  // Auto's are connector ids as the exclusions API stores them.
  const assignableKnowledgeSources: KnowledgeSourceOption[] = [
    ...knowledgeBases.map((kb) => ({
      id: `${KNOWLEDGE_BASE_ID_PREFIX}${kb.id}`,
      name: kb.name,
      description: kb.description,
      badge: "Knowledge base",
      connectorType: kb.connectors?.[0]?.connectorType ?? null,
    })),
    ...connectors.map((connector) => ({
      id: `${CONNECTOR_ID_PREFIX}${connector.id}`,
      name: connector.name,
      description: connector.description || connector.connectorType,
      badge: "Connector",
      connectorType: connector.connectorType,
      // Environment isolation: a connector in another environment can't be
      // used by this agent, so it is offered but not selectable.
      disabled: !isInSelectedEnvironment(connector.environmentId ?? null),
      disabledReason: "Different environment",
    })),
  ];
  const assignedKnowledgeSourceIds = [
    ...knowledgeBaseIds.map((id) => `${KNOWLEDGE_BASE_ID_PREFIX}${id}`),
    ...connectorIds.map((id) => `${CONNECTOR_ID_PREFIX}${id}`),
  ];
  const toggleAssignedKnowledgeSource = (namespacedId: string) => {
    const toggle = (previous: string[], id: string) =>
      previous.includes(id)
        ? previous.filter((selected) => selected !== id)
        : [...previous, id];
    if (namespacedId.startsWith(KNOWLEDGE_BASE_ID_PREFIX)) {
      const id = namespacedId.slice(KNOWLEDGE_BASE_ID_PREFIX.length);
      setKnowledgeBaseIds((previous) => toggle(previous, id));
      return;
    }
    const id = namespacedId.slice(CONNECTOR_ID_PREFIX.length);
    setConnectorIds((previous) => toggle(previous, id));
  };
  const toggleDisabledKnowledgeSource = (id: string) =>
    setDisabledKnowledgeSourceIds((previous) =>
      previous.includes(id)
        ? previous.filter((selected) => selected !== id)
        : [...previous, id],
    );
  // Knowledge needs an embedding model before either field can do anything, so
  // both modes say so in the same place and with the same words.
  const knowledgeNotConfiguredNotice = (
    <p className="text-xs text-muted-foreground">
      Configure an embedding model to use knowledge sources.
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
  );
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
  // Agents and MCP gateways can be assigned a deployment environment. For
  // agents it binds the code sandbox runtime; for MCP gateways it is an
  // attribution label so their usage falls under environment-scoped cost
  // limits.
  const supportsEnvironment = isInternalAgent || agentType === "mcp_gateway";
  const environmentHelpText =
    agentType === "mcp_gateway"
      ? "The environment this gateway belongs to, controlling which tools and knowledge it can expose to consumers."
      : "The environment for this agent's code sandbox (runtime and network egress) and the tools and knowledge sources it can use.";
  const isBuiltIn = !!agent?.builtIn;
  const agentHooksEnabled = useFeature("agentHooksEnabled");
  // "Auto" (implicit access to all tools) is the default for new agents; admins
  // can switch an agent to "Custom" (explicitly assigned tools). Implicit access
  // is scoped to tools/knowledge visible to the user AND in the agent's
  // environment.
  const autoToolsMode = accessAllTools;
  // Auto mode implies progressive loading whatever the record says: the
  // backend coerces `accessAllTools` agents to `search_and_run_only` on create
  // and on every update, so a legacy row still holding "full" is stale rather
  // than a state the switch should report.
  const progressiveToolLoading =
    autoToolsMode || toolExposureMode === "search_and_run_only";
  // Seed the exclusions editor with the backend's Auto-mode pre-fill whenever
  // saving would put the agent into Auto mode from scratch: creating a new
  // agent on the Auto tab, or editing an agent whose SAVED accessAllTools is
  // off while the Auto tab is selected. An agent already saved in Auto mode has
  // its pre-fill persisted server-side, so the editor just loads it.
  const savedAccessAllTools = persistedAgent?.accessAllTools ?? false;
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
  // The Advisor is org-wide by design — every environment consults the one
  // instance — so it is the one agent kind with no environment of its own.
  const showsEnvironmentSelector =
    (isInternalAgent || agentType === "mcp_gateway") && !isAdvisorBuiltIn;
  const supportsIdentityProvider =
    agentType === "mcp_gateway" || agentType === "agent";
  const mcpAuthDocsUrl = getFrontendDocsUrl(DocsPage.McpAuthentication);
  // The agents page documents this setting for gateways too.
  const toolConnectionsDocsUrl = getDocsUrl(
    DocsPage.PlatformAgents,
    "tool-connections",
  );
  const toolExposureDocsUrl = getDocsUrl(
    agentType === "mcp_gateway"
      ? DocsPage.PlatformMcpGateway
      : DocsPage.PlatformAgents,
    "load-tools-when-needed",
  );
  // The provider key + model pair: internal agents, built-in ones included.
  const showsModelControl = isInternalAgent || isBuiltIn;
  // Which model "Organization default" currently means, so the control can
  // say so instead of leaving the reader to look it up.
  const organizationDefaultModel = useOrganizationDefaultModel({
    enabled: showsModelControl,
  });
  const showPrimarySettingsCard =
    !isBuiltIn ||
    shouldShowDescriptionField({ agentType, isBuiltIn }) ||
    isPolicyConfigBuiltIn ||
    isDualLlmMainBuiltIn;
  const showTools =
    !isBuiltIn &&
    (agentType === "mcp_gateway" ||
      agentType === "agent" ||
      agentType === "profile");
  const showSubagents = !isBuiltIn && supportsSubagents;
  // The delegation targets and the disabled-subagent set each arrive from their
  // own request. Until both have succeeded the editors would render a
  // not-yet-seeded empty list, which reads as "delegates to nothing" and can be
  // saved as one — both sets are written back as full replaces. Create mode has
  // nothing to wait for.
  const subagentSetsLoaded =
    !agent?.id ||
    !supportsSubagents ||
    (delegationsLoaded && subagentExclusionsLoaded);
  const showSecurity = !isBuiltIn && agentType === "agent";
  const showsHooks = agentHooksEnabled && isInternalAgent && !isBuiltIn;
  // The tools panel is mounted only when it has a section to show: an empty
  // bordered panel would read as broken.
  const toolsPanelHasContent = showTools || showSkills || showsHooks;
  // What the Advanced step holds for this record, named in its description.
  const advancedSettingsSummary = [
    "labels",
    showSecurity ? "security" : null,
    agentType === "mcp_gateway" ? "header passthrough" : null,
    supportsIdentityProvider && identityProviders.length > 0
      ? "the identity provider to trust"
      : null,
  ]
    .filter((part): part is string => !!part)
    .join(", ");
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
  const { data: organization } = useOrganization();
  // Any chat agent this form can show is one the caller can start a chat
  // with, so any of them can be their default — a team's or the
  // organization's as readily as their own. Hidden only for built-ins and
  // other agent types, which no chat starts on.
  const isCurrentlyPersonalDefault =
    !!agent?.id && agent.id === memberDefaultAgentId;
  const canTogglePersonalDefault = isInternalAgent && !isBuiltIn;
  // Pinning the agent the organization already defaults to changes nothing
  // today — the agents list reads that row as `default (org)` and offers no
  // pin at all. The switch stays, because it is the only place the pin can be
  // taken back off, but it has to say what it is (and is not) doing here.
  const isOrganizationDefault =
    !!agent?.id && agent.id === organization?.defaultAgentId;
  const personalDefault =
    canTogglePersonalDefault &&
    (personalDefaultOverride ?? isCurrentlyPersonalDefault);
  const personalDefaultChanged =
    canTogglePersonalDefault &&
    personalDefaultOverride !== null &&
    personalDefaultOverride !== isCurrentlyPersonalDefault;
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

  // Reset the form on mount and whenever the agent (or its fresh read) changes.
  useEffect(() => {
    {
      // Refetch agent data on mount to ensure fresh data
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
            missingCredentialBehavior:
              agentData.missingCredentialBehavior ?? "allow",
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
            missingCredentialBehavior: "allow",
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
      setPersonalDefaultOverride(null);
      setPassthroughHeaders(nextValues.passthroughHeaders);
      setToolExposureMode(nextValues.toolExposureMode);
      setMissingCredentialBehavior(nextValues.missingCredentialBehavior);
      setAccessAllTools(nextValues.accessAllTools);
      setAccessAllSubagents(nextValues.accessAllSubagents);
      setAutoConfigureOnToolDiscovery(nextValues.autoConfigureOnToolDiscovery);
      setDualLlmMaxRounds(nextValues.dualLlmMaxRounds);
      if (!agentData) {
        // Create mode only: edit mode remounts per agent and seeds each set
        // from its own request, and clearing here would instead wipe pending
        // edits on every agent refetch.
        setSelectedDelegationTargetIds([]);
        setDisabledSubagentIds([]);
        // A new gateway publishes nothing until an admin opts in, so Custom
        // with an empty set is the default rather than Auto.
        setAccessAllSkills(false);
        setAssignedSkillIds([]);
        setExcludedSkillIds([]);
      }
      initialSnapshotRef.current = buildAgentFormSnapshot(nextValues);

      // Reset counts on (re)seed
      setSelectedToolsCount(0);
      lastAutoSelectedProviderRef.current = null;
    }
  }, [agent, freshAgent, refetchAgent, isInternalAgent]);

  // A brand-new agent starts in the org's configured landing environment for
  // its type. Kept out of the reset path above (same reasoning as the seeds
  // below) and declared after it so the reset can't overwrite the seed. Gated
  // on the same condition that renders the selector, so the form never
  // submits an environment it did not show.
  useDefaultEnvironmentSeed({
    resource: agentType === "mcp_gateway" ? "mcpGateway" : "agent",
    enabled: !agent && showsEnvironmentSelector,
    apply: setEnvironmentId,
  });

  // Sync selectedDelegationTargetIds with currentDelegations when data loads.
  // Agent refetches can update freshAgent after delegations have loaded; keeping
  // delegations out of the agent reset path avoids clearing them on save.
  // Seeding waits for success, never mere completion: a failed read seeds an
  // empty set, and the save below writes empty sets back as a full replace.
  const currentDelegationIds = currentDelegations.map((a) => a.id).join(",");
  const agentId = agent?.id;

  useEffect(() => {
    if (agentId && delegationsLoaded) {
      setSelectedDelegationTargetIds(
        currentDelegationIds.split(",").filter(Boolean),
      );
    }
  }, [agentId, currentDelegationIds, delegationsLoaded]);

  // Seed the Auto-mode disabled-subagents set once the exclusions load. Kept out
  // of the agent reset path (same reasoning as delegations above) so a refetch
  // doesn't wipe pending edits.
  const currentExcludedSubagentIds = (
    currentSubagentExclusions?.excludedSubagentIds ?? []
  ).join(",");

  useEffect(() => {
    if (agentId && subagentExclusionsLoaded) {
      setDisabledSubagentIds(
        currentExcludedSubagentIds.split(",").filter(Boolean),
      );
    }
  }, [agentId, currentExcludedSubagentIds, subagentExclusionsLoaded]);

  // Same for the Auto-mode disabled-knowledge-sources set, and for the same
  // reason: it arrives after the agent reset.
  const currentExcludedConnectorIds = (
    currentKnowledgeSourceExclusions?.excludedConnectorIds ?? []
  ).join(",");

  useEffect(() => {
    if (agentId && knowledgeSourceExclusionsLoaded) {
      setDisabledKnowledgeSourceIds(
        currentExcludedConnectorIds.split(",").filter(Boolean),
      );
    }
  }, [agentId, currentExcludedConnectorIds, knowledgeSourceExclusionsLoaded]);

  // Seed the published-skill sets once they load, for the same reason as the
  // subagent sets above: they arrive after the agent reset, so keeping them out
  // of that path stops a refetch from wiping pending edits.
  const currentAssignedSkillIds = (
    currentSkillAssignments?.skillIds ?? []
  ).join(",");
  const currentSavedAccessAllSkills =
    currentSkillAssignments?.accessAllSkills ?? false;

  useEffect(() => {
    if (agentId && skillAssignmentsLoaded) {
      setAssignedSkillIds(currentAssignedSkillIds.split(",").filter(Boolean));
      setAccessAllSkills(currentSavedAccessAllSkills);
    }
  }, [
    agentId,
    currentAssignedSkillIds,
    currentSavedAccessAllSkills,
    skillAssignmentsLoaded,
  ]);

  const currentExcludedSkillIds = (
    currentSkillExclusions?.excludedSkillIds ?? []
  ).join(",");

  useEffect(() => {
    if (agentId && skillExclusionsLoaded) {
      setExcludedSkillIds(currentExcludedSkillIds.split(",").filter(Boolean));
    }
  }, [agentId, currentExcludedSkillIds, skillExclusionsLoaded]);

  // One org-wide advisor: delegation reaches it from every environment, so the
  // switch targets the same row wherever this agent lives.
  const advisorAgentId = allInternalAgents.find(
    (a) => a.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.ADVISOR,
  )?.id;

  // Consulting the advisor is off until someone turns it on. A new agent gets
  // that default from the backend, which excludes the advisor as it creates the
  // agent — seeding it here as well meant the create could not be submitted
  // until the delegation-target roster had loaded, for a write the server was
  // going to make anyway.

  // One switch over two representations: Auto mode reaches every agent unless
  // excluded, Custom mode reaches only what is listed. The reader should not
  // have to know which is in play to decide whether the advisor is on. Before
  // the record exists the switch holds the choice itself: the server excludes
  // the advisor as it creates the agent, and waiting for the roster to seed
  // that here would only hold the create for a write the server makes anyway.
  const [createAdvisorEnabled, setCreateAdvisorEnabled] = useState(false);
  const advisorEnabled = advisorAgentId
    ? agent
      ? accessAllSubagents
        ? !disabledSubagentIds.includes(advisorAgentId)
        : selectedDelegationTargetIds.includes(advisorAgentId)
      : createAdvisorEnabled
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
    if (!agent) setCreateAdvisorEnabled(enabled);
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

  // An update sends the section groups the caller mounted and nothing else:
  // the PUT is partial, and a field the user could not see is held here as
  // whatever this mount was seeded with — re-sending it forks a config version
  // and writes an audit record for an edit nobody made. Within a mounted group
  // the environment and the key/model pair go further and are sent only once
  // they actually change: re-sending an environment or a model the caller may
  // no longer assign turns an unrelated edit into a permission error.
  const savedEnvironmentId = persistedAgent?.environmentId ?? null;
  const environmentChanged =
    !!persistedAgent && (environmentId ?? null) !== savedEnvironmentId;
  // The API validates the key and the model against each other, so whichever
  // one moved, both go.
  const llmSelectionChanged =
    !!persistedAgent &&
    ((llmApiKeyId ?? null) !== (persistedAgent.llmApiKeyId ?? null) ||
      (llmModel ?? null) !== (persistedAgent.modelId ?? null));

  // Moving an agent out of the environment its tools belong to strands them.
  // The tools editor refuses that itself, but the Configuration step does not
  // mount it — so on that step the same verdict is computed from the saved
  // assignments, and a pending or failed read counts as "still blocked".
  const environmentConflicts = useAgentEnvironmentConflicts({
    agentId: agent?.id,
    environmentId: environmentId ?? null,
    agentType,
    enabled:
      environmentChanged &&
      !showToolsSections &&
      showTools &&
      environmentScopingEnabled,
  });

  const performSave = useCallback(async (): Promise<boolean> => {
    const trimmedName = name.trim();
    const trimmedSystemPrompt = systemPrompt.trim();
    const parsedDualLlmMaxRounds = Number.parseInt(dualLlmMaxRounds, 10);

    if (!trimmedName) {
      toast.error("Name is required");
      return false;
    }

    // A team-scoped agent must have at least one team (issue #6624)
    if (scope === "team" && assignedTeamIds.length === 0) {
      toast.error("Please select at least one team");
      return false;
    }

    if (
      isDualLlmMainBuiltIn &&
      (!Number.isInteger(parsedDualLlmMaxRounds) ||
        parsedDualLlmMaxRounds < 1 ||
        parsedDualLlmMaxRounds > 20)
    ) {
      toast.error("Max rounds must be an integer between 1 and 20");
      return false;
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
      // Whether the agent PUT came back with the updated row. The success
      // toast waits for the writes after it, so this carries the verdict there.
      let updateConfirmed = false;

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
            ...(llmSelectionChanged && {
              llmApiKeyId: llmApiKeyId || null,
              modelId: llmModel || null,
            }),
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
            // The configuration group: who the agent is, what it is told, and
            // who may reach it.
            ...(showConfigurationSections && {
              name: trimmedName,
              icon: icon || null,
              ...(normalizedDescription !== undefined && {
                description: normalizedDescription,
              }),
              ...(isInternalAgent && {
                systemPrompt: trimmedSystemPrompt || null,
                suggestedPrompts: validSuggestedPrompts,
                ...(llmSelectionChanged && {
                  llmApiKeyId: llmApiKeyId || null,
                  modelId: llmModel || null,
                }),
              }),
              ...(supportsEnvironment &&
                environmentChanged && {
                  environmentId: environmentId ?? null,
                }),
              teams: assignedTeamIds,
              users: assignedUserIds,
              scope,
            }),
            // The Advanced group: labels, the identity provider, security,
            // header passthrough.
            ...(showAdvancedSections && {
              labels: updatedLabels,
              ...(supportsIdentityProvider && {
                identityProviderId: identityProviderId || null,
              }),
              ...(showSecurity && { considerContextUntrusted }),
              ...(agentType === "mcp_gateway" && {
                passthroughHeaders:
                  passthroughHeaders.length > 0 ? passthroughHeaders : null,
              }),
            }),
            // The tools group: what the agent may reach, and how.
            ...(showToolsSections && {
              knowledgeBaseIds: knowledgeBaseIds,
              connectorIds: connectorIds,
              toolExposureMode,
              missingCredentialBehavior,
              accessAllTools,
              ...(supportsSubagents && { accessAllSubagents }),
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
        updateConfirmed = !!updated?.id;
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
          // Omitted, not null, while the field holds no value: the selector
          // hides itself when the org offers no choice, and null would pin the
          // new agent to the Default environment instead of letting the backend
          // resolve the org's configured landing environment for its type.
          ...(supportsEnvironment &&
            environmentId !== undefined && { environmentId }),
          ...(supportsIdentityProvider && {
            identityProviderId: identityProviderId || null,
          }),
          knowledgeBaseIds: knowledgeBaseIds,
          connectorIds: connectorIds,
          toolExposureMode,
          missingCredentialBehavior,
          accessAllTools,
          ...(supportsSubagents && { accessAllSubagents }),
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
        if (!created) return false;
        savedAgentId = created?.id ?? "";

        // Everything picked on the wizard's other steps exists only on this
        // form until now; it is written against the new id, and if any of it
        // is refused the record is deleted again rather than left half set
        // up behind a page that has already said "created".
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
            // Delegations and disabled subagents: the server wrote the new
            // record's defaults (advisor off, nothing listed), so only a set
            // that differs from those is worth a write.
            if (supportsSubagents && delegationTargetIdsToSave.length > 0) {
              await syncDelegations.mutateAsync({
                agentId: savedAgentId,
                targetAgentIds: delegationTargetIdsToSave,
              });
            }
            const createdExclusions = advisorAgentId ? [advisorAgentId] : [];
            if (
              supportsSubagents &&
              hasUnsavedChanges(
                [...createdExclusions].sort(),
                [...disabledSubagentIdsToSave].sort(),
              )
            ) {
              await syncSubagentExclusions.mutateAsync({
                agentId: savedAgentId,
                exclusions: { excludedSubagentIds: disabledSubagentIdsToSave },
              });
            }
            // A new agent starts with nothing disabled, so only a non-empty
            // set is worth a write.
            if (disabledKnowledgeSourceIds.length > 0) {
              await syncKnowledgeSourceExclusions.mutateAsync({
                agentId: savedAgentId,
                exclusions: {
                  excludedConnectorIds: disabledKnowledgeSourceIds,
                },
              });
            }
            await savePublishedSkills(savedAgentId);
          } catch (error) {
            await deleteAgent.mutateAsync(savedAgentId);
            throw error;
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
      //
      // Edit mode only: `AgentModel.create` writes a new agent's subagent
      // defaults itself, and these editors live on a later wizard step anyway,
      // so on create both sets are still their untouched defaults.
      if (
        agent &&
        supportsSubagents &&
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

      // The personal default is a member setting, saved through its own route
      // once the agent exists. Only when the switch was actually moved: an
      // untouched switch means the member did not ask for this agent to become
      // their default, and nothing else in the product decides that for them.
      if (savedAgentId && personalDefaultChanged) {
        await updateDefaultAgentId.mutateAsync(
          personalDefault ? savedAgentId : null,
        );
      }

      // Persist the Auto-mode disabled-subagents set only when it changed (same
      // no-op-audit reasoning as delegations, and edit-mode-only for the same
      // reason). Skipped for built-ins.
      if (
        agent &&
        supportsSubagents &&
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

      // Persist the Auto-mode disabled-knowledge-sources set only when it
      // changed, for the same no-op-audit reason as the sets above. Not
      // skipped for built-ins: their knowledge surface is configured like any
      // other agent's.
      if (
        agent &&
        savedAgentId &&
        knowledgeSourceExclusionsLoaded &&
        hasUnsavedChanges(
          [
            ...(currentKnowledgeSourceExclusions?.excludedConnectorIds ?? []),
          ].sort(),
          [...disabledKnowledgeSourceIds].sort(),
        )
      ) {
        await syncKnowledgeSourceExclusions.mutateAsync({
          agentId: savedAgentId,
          exclusions: { excludedConnectorIds: disabledKnowledgeSourceIds },
        });
      }

      // Edit mode only: the create step does not mount the skills editors.
      if (agent) {
        await savePublishedSkills(savedAgentId);
        // Last, so it is true of the whole save: the delegation, subagent and
        // skill writes above can each still be refused, and a toast before
        // them promised a save that had not happened yet.
        if (updateConfirmed) {
          toast.success(getSuccessMessage(agentType, true));
        }
        onSaved?.({ id: savedAgentId, name: trimmedName });
      }
      return true;
    } catch (error) {
      // Every write above rejects on failure, so nothing past the failure ran:
      // no success toast, no `onCreated`/`onSaved`, no follow-up writes.
      //
      // A write that reached the API has already had its refusal toasted by
      // the query layer, and repeating it here showed the user the same
      // sentence twice. What is left is the failures nothing has reported: the
      // tools editor's summary of an assignment the endpoint refused inside a
      // 200, and outright defects — those still need a line of their own.
      if (!isReportedApiError(error)) {
        toast.error(
          error instanceof Error && error.message
            ? error.message
            : `Failed to save ${agentTypeDisplayName[agentType] || "resource"}`,
        );
      }
      return false;
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
    llmSelectionChanged,
    identityProviderId,
    environmentId,
    environmentChanged,
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
    showConfigurationSections,
    showToolsSections,
    showAdvancedSections,
    advisorAgentId,
    deleteAgent,
    delegationTargetIdsToSave,
    currentDelegations,
    currentSubagentExclusions,
    disabledSubagentIdsToSave,
    updateAgent,
    createAgent,
    updateDefaultAgentId,
    personalDefault,
    personalDefaultChanged,
    syncDelegations,
    syncSubagentExclusions,
    currentKnowledgeSourceExclusions,
    disabledKnowledgeSourceIds,
    knowledgeSourceExclusionsLoaded,
    syncKnowledgeSourceExclusions,
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
    onSaved,
    supportsIdentityProvider,
    passthroughHeaders,
    toolExposureMode,
    missingCredentialBehavior,
    accessAllTools,
    accessAllSubagents,
    supportsEnvironment,
    supportsSubagents,
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

  const conflictingToolCount = environmentConflicts.conflictingToolIds.length;
  const removeConflictingToolsLabel = `Remove ${conflictingToolCount} incompatible tool${
    conflictingToolCount === 1 ? "" : "s"
  }`;

  // Clearing the conflict is two writes, and only the first one is undoable by
  // simply not saving: if the unassign fails there is nothing to save around,
  // and if it lands but the agent update does not, the tools are gone whatever
  // the user does next — so say so rather than leave them to rediscover it.
  const handleRemoveEnvironmentConflicts = useCallback(async () => {
    if (!(await environmentConflicts.removeConflictingTools())) return;
    if (await performSave()) return;
    toast.warning(
      "The incompatible tools were removed, but the environment change was not saved. Try saving again.",
    );
    refetchAgent();
  }, [environmentConflicts, performSave, refetchAgent]);

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
    missingCredentialBehavior,
    accessAllTools,
    accessAllSubagents,
  });
  const isDirty =
    !readOnly &&
    initialSnapshotRef.current !== null &&
    (hasUnsavedChanges(initialSnapshotRef.current, currentSnapshot) ||
      personalDefaultChanged ||
      hasPendingToolChanges ||
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
      // Same for the Auto-mode disabled-knowledge-sources set.
      hasUnsavedChanges(
        [
          ...(currentKnowledgeSourceExclusions?.excludedConnectorIds ?? []),
        ].sort(),
        [...disabledKnowledgeSourceIds].sort(),
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
  useEffect(() => {
    onDirtyChange?.(isDirty);
    // The page outlives the form: a wizard step that unmounts with edits still
    // in it would otherwise leave the host guarding navigation away from a
    // form that is no longer there.
    return () => onDirtyChange?.(false);
  }, [isDirty, onDirtyChange]);

  const canSubmit =
    !!name.trim() &&
    !isSaving &&
    !createAgent.isPending &&
    !updateAgent.isPending &&
    !requiresTeamSelection &&
    mcpEnvConflicts.length === 0 &&
    !environmentConflicts.blocksSave &&
    !(scope === "team" && hasNoAvailableTeams);
  const footerState: AgentFormFooterState = {
    isCreate: !agent,
    isSaving: isSaving || createAgent.isPending || updateAgent.isPending,
    isDirty,
    canSubmit,
  };
  // Where a read-only form's Cancel goes: the record it is showing, which is
  // where the editable footer's Cancel lands too. A legacy `profile` has no
  // family of its own, so it resolves to its canonical gateway route.
  const readOnlyExitHref = agent
    ? agentDetailHref(agentPageKindForType(agent.agentType), agent.id)
    : agentListHref(agentPageKindForType(agentType));
  return (
    <form
      className="flex flex-col"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        if (!submitEnabled) return;
        void handleSave();
      }}
    >
      <fieldset disabled={readOnly} className="contents">
        <div className="space-y-4">
          {showConfigurationSections && agentType === "profile" && (
            <Alert variant="warning">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                This is a legacy entity that works both as MCP Gateway and LLM
                Proxy. It appears on both tables and shares Name, Team, and
                Labels.
              </AlertDescription>
            </Alert>
          )}

          {/* One panel per step, its sections divided by a rule — the same
              shape the MCP server form uses, so a step reads as one thing to
              fill in rather than a stack of unrelated cards. A mounted panel
              that is not the active one is hidden, not unmounted: the create
              wizard walks every panel on this one form. */}
          {showConfigurationSections && (
            <div
              className={cn(
                "divide-y rounded-lg border bg-card",
                !isActiveSection("configuration") && "hidden",
              )}
            >
              {/* Section 1: what it is, where it runs, who can use it. */}
              {showPrimarySettingsCard && (
                <div className="space-y-4 p-4">
                  {/* Name + Icon (hidden for built-in agents, shown in dialog title) */}
                  {!isBuiltIn && (
                    <IdentityFields
                      icon={icon}
                      onIconChange={setIcon}
                      fallbackType={defaultIconType}
                    >
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
                    </IdentityFields>
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

                  {/* Environment assignment (below the description).
                      - Agent: binds the agent's code sandbox to a per-environment
                        Dagger engine + egress policy.
                      - LLM proxy / MCP gateway: assigns the deployment environment
                        so its usage falls under environment-scoped cost limits.
                      The advisor renders no selector: it is configured once for
                      the organization and reachable from every environment.
                      Shown on create as well as on edit — where a new record
                      runs is part of what is being created, and an org with
                      only the Default environment gets the same disabled
                      control the edit form shows rather than a silent field. */}
                  {showsEnvironmentSelector && (
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

                  {/* Visibility / Scope: who can use it, once it has a name and a
                    place to run. */}
                  {!isBuiltIn && (
                    <div>
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
                    </div>
                  )}

                  {/* Personal default (the caller's own personal chat agent) */}
                  {canTogglePersonalDefault && (
                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-0.5">
                        <Label
                          htmlFor="personal-default-agent"
                          className="text-sm font-medium cursor-pointer"
                        >
                          My default agent
                        </Label>
                        <p className="text-sm text-muted-foreground">
                          {isOrganizationDefault
                            ? "Your organization already starts everyone's chats on this agent, so pinning it changes nothing today — it keeps this agent yours if the organization default moves."
                            : "Your new chats start on this agent — from the composer, from an app you open in chat, anywhere a chat begins without naming one. Yours alone, one at a time, and ahead of the organization default."}
                        </p>
                      </div>
                      <Switch
                        id="personal-default-agent"
                        checked={personalDefault}
                        onCheckedChange={setPersonalDefaultOverride}
                        disabled={readOnly}
                        data-testid={E2eTestId.PersonalDefaultAgentSwitch}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Section 2: Instruction (Agent only) */}
              {isInternalAgent && (
                <div className="p-4">
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
                  <div>
                    {suggestedPrompts.length > 0 ? (
                      <CollapsibleTrigger className="flex w-full items-center justify-between p-4 transition-colors [&:hover:not(:has(button:hover))]:bg-muted/50 [&[data-state=open]>div>svg]:rotate-90">
                        <div className="text-left">
                          <h3 className="text-base font-semibold">
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
                          <h3 className="text-base font-semibold">
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

              {/* Model (Agent and Built-in) — the provider key and the
                model that answers, once the agent has been told what to do. */}
              {showsModelControl && (
                <div className="space-y-4 p-4">
                  <div className="space-y-1">
                    <h3 className="text-base font-semibold">Model</h3>
                    <p className="text-sm text-muted-foreground">
                      The provider key and model this{" "}
                      {agentTypeDisplayName[agentType] || "agent"} answers with.
                    </p>
                  </div>
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
                      {selectedApiKeyIsSubscription ? (
                        <Alert>
                          <InfoIcon className="h-4 w-4" />
                          <AlertDescription>
                            Each person using this agent must connect their own
                            subscription account. No credential is shared.
                          </AlertDescription>
                        </Alert>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {selectedApiKey && selectedApiKey.scope !== "org" ? (
                            <span>
                              Selected key will be available to everyone who has
                              access to this agent.
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
                          currentProvider={currentLlmProvider ?? undefined}
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
                                    // The model the organization default
                                    // resolves to today; the runtime's own
                                    // fallback when no default is set.
                                    placeholder={
                                      organizationDefaultModel.label ??
                                      undefined
                                    }
                                  />
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" className="text-xs">
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
                            &apos;s tools won&apos;t be used in its chats. Pick
                            a different model to use tools.
                          </span>
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Labels for built-in agents (the Advanced step that holds
                them for everyone else does not exist for a built-in). */}
              {isBuiltIn && (
                <div className="space-y-4 p-4">
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
          )}

          {showToolsSections && toolsPanelHasContent && (
            <div
              className={cn(
                "divide-y rounded-lg border bg-card",
                !isActiveSection("tools") && "hidden",
              )}
            >
              {/* Section 3: Tools & Knowledge Sources */}
              {showTools && (
                <div
                  className="space-y-4 p-4"
                  data-testid={E2eTestId.AgentToolsSection}
                >
                  <h3 className="text-base font-semibold">
                    Tools &amp; Knowledge Sources
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
                    {/* Auto and Custom are the same pair of fields inversed —
                        every tool and source minus a set, or exactly a set — so
                        they carry the same order, the same widgets and the same
                        counts, and differ only in what being listed means. Each
                        stays mounted while the other shows, so pending edits and
                        the save-time refs survive a tab flip. */}
                    <div
                      className={cn(
                        "space-y-3 pt-1",
                        !autoToolsMode && "hidden",
                      )}
                    >
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">
                          {/* No count until the editor has loaded: it opens on
                              a server-side pre-fill, so "(0)" would be a claim
                              that nothing is excluded rather than "not yet
                              known". */}
                          All tools except
                          {exclusionsState
                            ? ` (${exclusionsState.current.excludedToolIds.length})`
                            : ""}
                        </p>
                        <AgentToolExclusionsEditor
                          ref={agentToolExclusionsEditorRef}
                          agentId={agent?.id}
                          active={autoToolsMode}
                          seedDefaultExclusions={seedDefaultExclusions}
                          pendingAssignedToolIds={pendingSelectedToolIds}
                          onStateChange={setExclusionsState}
                        />
                      </div>
                      {canReadKnowledgeBase && (
                        <div className="space-y-2">
                          <p className="text-sm text-muted-foreground">
                            All knowledge sources except (
                            {disabledKnowledgeSourceIds.length})
                          </p>
                          {isKnowledgeConfigured ? (
                            <KnowledgeSourcesEditor
                              sources={environmentConnectors.map(
                                (connector) => ({
                                  id: connector.id,
                                  name: connector.name,
                                  description:
                                    connector.description ||
                                    connector.connectorType,
                                  connectorType: connector.connectorType,
                                }),
                              )}
                              selectedIds={disabledKnowledgeSourceIds}
                              onToggle={toggleDisabledKnowledgeSource}
                              tone="exclude"
                              label="Disable"
                              createAction={KNOWLEDGE_CONNECTOR_CREATE_ACTION}
                              testIds={{
                                container:
                                  E2eTestId.AgentKnowledgeSourceExclusions,
                                pill: E2eTestId.AgentKnowledgeSourceExclusionPill,
                                combobox:
                                  E2eTestId.AgentKnowledgeSourceExclusionsCombobox,
                              }}
                            />
                          ) : (
                            knowledgeNotConfiguredNotice
                          )}
                        </div>
                      )}
                    </div>
                    <div
                      className={cn(
                        "space-y-3 pt-1",
                        autoToolsMode && "hidden",
                      )}
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
                          onPendingChangesChange={setHasPendingToolChanges}
                          environmentScopingEnabled={environmentScopingEnabled}
                          agentEnvironmentId={environmentId ?? null}
                          agentEnvironmentName={agentEnvironmentName}
                          onConflictsChange={setMcpEnvConflicts}
                          openComboboxOnMount={openToolsCombobox}
                          includeAppCatalogs={shouldOfferAppCatalogs(agentType)}
                        />
                      </div>
                      {canReadKnowledgeBase && (
                        <div className="space-y-2">
                          <p className="text-sm text-muted-foreground">
                            Knowledge sources (
                            {assignedKnowledgeSourceIds.length})
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Assigning a source gives this{" "}
                            {agentType === "mcp_gateway" ? "gateway" : "agent"}{" "}
                            a <code>query_knowledge_sources</code> tool to
                            search it.
                          </p>
                          {isKnowledgeConfigured ? (
                            <KnowledgeSourcesEditor
                              sources={assignableKnowledgeSources}
                              selectedIds={assignedKnowledgeSourceIds}
                              onToggle={toggleAssignedKnowledgeSource}
                              tone="assign"
                              label="Add"
                              createAction={KNOWLEDGE_CONNECTOR_CREATE_ACTION}
                              testIds={{
                                container: E2eTestId.AgentKnowledgeSources,
                                pill: E2eTestId.AgentKnowledgeSourcePill,
                                combobox:
                                  E2eTestId.AgentKnowledgeSourcesCombobox,
                              }}
                            />
                          ) : (
                            knowledgeNotConfiguredNotice
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Auto mode is progressive loading — dynamic access only
                      works through the search/run dispatch surface, and the
                      backend coerces the mode to match on every write path. The
                      row used to be hidden there, which left the one setting
                      Auto decides for you invisible; it now shows in both
                      modes, on and locked in Auto. The row reads like the
                      detail page's: the setting's icon tinted by its state, and
                      a line on what the state means. */}
                  <div className="flex items-center gap-3">
                    <SettingIcon tone={progressiveToolLoading ? "on" : "off"}>
                      <PackageSearch className="size-4" />
                    </SettingIcon>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <Label htmlFor="load-tools-when-needed">
                        Progressive tool loading
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {/* Word for word the detail page's "Tools loaded"
                            row, so the setting reads the same where it is
                            chosen and where it is reported. */}
                        {progressiveToolLoading ? (
                          <>
                            The model starts with{" "}
                            <code>{TOOL_SEARCH_TOOLS_SHORT_NAME}</code> and{" "}
                            <code>{TOOL_RUN_TOOL_SHORT_NAME}</code> only, and
                            reaches the rest by searching for them
                            mid-conversation.
                          </>
                        ) : (
                          <>
                            Every assigned tool is in the model's context from
                            the first message.
                          </>
                        )}{" "}
                        {autoToolsMode && <>Auto mode always uses it. </>}
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
                      checked={progressiveToolLoading}
                      disabled={autoToolsMode}
                      onCheckedChange={(checked) =>
                        setToolExposureMode(
                          checked ? "search_and_run_only" : "full",
                        )
                      }
                    />
                  </div>

                  {/* Only meaningful for Custom mode: an Auto agent resolves
                      tools from what each caller can already reach, so no
                      caller can be missing a connection. */}
                  {!autoToolsMode && (
                    <div className="flex items-center gap-3">
                      <SettingIcon
                        tone={
                          MISSING_CREDENTIAL_TONE[missingCredentialBehavior]
                        }
                      >
                        <Unplug className="size-4" />
                      </SettingIcon>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <Label htmlFor="missing-credential-behavior">
                          Tool connections
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          {TOOL_CONNECTION_PROMPTING[missingCredentialBehavior]}{" "}
                          <ExternalDocsLink
                            href={toolConnectionsDocsUrl}
                            className="underline"
                            showIcon={false}
                          >
                            Learn more
                          </ExternalDocsLink>
                        </p>
                      </div>
                      <Select
                        value={missingCredentialBehavior}
                        onValueChange={(value) =>
                          setMissingCredentialBehavior(
                            value as MissingCredentialBehavior,
                          )
                        }
                      >
                        {/* Fixed width: the trigger is `w-fit` by default, so
                            the row would reflow by ~33px as the value changes. */}
                        <SelectTrigger
                          id="missing-credential-behavior"
                          className="w-[240px]"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        {/* `popper` is what makes `align` bind at all: the
                            default `item-aligned` positioning clamps only the
                            popover's left edge, so it ended flush with the
                            browser window — over 100px outside the wizard's
                            panel on a wide screen. Anchored to the trigger's
                            right edge it stays in the column, and 28rem keeps
                            every option's explainer at two lines. */}
                        <SelectContent
                          position="popper"
                          align="end"
                          className="w-[28rem] max-w-[calc(100vw-2rem)]"
                        >
                          {MISSING_CREDENTIAL_BEHAVIOR_OPTIONS.map((option) => (
                            <SelectItem
                              key={option.value}
                              value={option.value}
                              description={
                                TOOL_CONNECTION_PROMPTING[option.value]
                              }
                            >
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              )}

              {/* Section 4: Subagents */}
              {showSubagents && (
                <div className="space-y-4 p-4">
                  <h3 className="text-base font-semibold">Subagents</h3>
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
                              Disable specific agents below to keep them off the
                              delegation surface
                            </li>
                          </ul>
                          <div className="space-y-1.5">
                            <p className="text-sm text-muted-foreground">
                              All subagents except ({disabledSubagentCount})
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
                            Only the subagents you assign below can be delegated
                            to by this{" "}
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
                        <div className="flex items-center gap-3 border-t pt-4">
                          <SettingIcon tone={advisorEnabled ? "on" : "off"}>
                            <AgentIcon
                              icon={
                                allInternalAgents.find(
                                  (candidate) =>
                                    candidate.id === advisorAgentId,
                                )?.icon ?? null
                              }
                              fallbackType="agent"
                              size={16}
                            />
                          </SettingIcon>
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex items-center gap-2">
                              <Label htmlFor="consult-advisor">
                                Advisor Subagent
                              </Label>
                              <Badge
                                variant="secondary"
                                className="px-1.5 py-0 text-[10px]"
                              >
                                Beta
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {advisorEnabled
                                ? "Gets a second opinion from the Advisor before answering."
                                : "Answers without consulting the Advisor."}{" "}
                              <ExternalDocsLink
                                href={advisorDocsUrl}
                                className="underline"
                                showIcon={false}
                              >
                                Learn more
                              </ExternalDocsLink>
                            </p>
                          </div>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="shrink-0"
                                asChild
                              >
                                {/* New tab: this form holds unsaved edits
                                  that navigating away would discard. */}
                                <Link
                                  href={agentDetailHref(
                                    "agent",
                                    advisorAgentId,
                                  )}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <Settings2 className="size-4" />
                                  <span>Open Advisor</span>
                                  <span className="sr-only">
                                    (opens in new tab)
                                  </span>
                                </Link>
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-64">
                              Open the organization&apos;s shared Advisor to see
                              or change the model it uses.
                            </TooltipContent>
                          </Tooltip>
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

              {/* Section 5: Skills published over MCP (SEP-2640). Gateways
                  only, behind the draft-extension feature flag. */}
              {showSkills && (
                <div className="space-y-4 p-4">
                  <h3 className="text-base font-semibold">Published skills</h3>
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
                        {agentTypeDisplayName[agentType] || "agent"}. Close and
                        reopen to try again — the published set stays as it is,
                        and your other changes still save.
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
                              Publishes every organization-scoped skill in this{" "}
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
                              All skills except ({excludedSkillIds.length})
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
                            published, a personal skill only by its own author,
                            and a skill restricted to other environments not at
                            all.
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
                  available, since hooks run in its sandbox). Hooks staged on
                  a record that does not exist yet are written right after the
                  create. */}
              {showsHooks && (
                <div className="p-4">
                  <AgentHooksEditor
                    ref={agentHooksEditorRef}
                    agentId={agent?.id}
                  />
                </div>
              )}
            </div>
          )}

          {/* The Advanced step: labels, security, passthrough headers, the
              identity provider — the settings a record rarely needs, as one
              open section of their own. A built-in agent has none. */}
          {showAdvancedSections && !isBuiltIn && (
            <div
              className={cn(
                "divide-y rounded-lg border bg-card",
                !isActiveSection("advanced") && "hidden",
              )}
            >
              <div className="space-y-4 p-4">
                <div className="space-y-1">
                  <h3 className="text-base font-semibold">Advanced</h3>
                  <p className="text-sm text-muted-foreground">
                    Optional settings — {advancedSettingsSummary}.
                  </p>
                </div>
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
                          Treat context as sensitive from the start of chat
                        </Label>
                        <p className="text-sm text-muted-foreground">
                          When enabled, the context is always considered
                          sensitive. Only tools allowed to run in sensitive
                          context will be permitted.
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
                      Client request headers to pass through to downstream MCP
                      servers. Case-insensitive.
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
                    {passthroughHeaders.length < MAX_PASSTHROUGH_HEADERS && (
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
                          if (BLOCKED_PASSTHROUGH_HEADERS.has(value)) {
                            toast.error(
                              `"${value}" is a hop-by-hop or protocol-level header and cannot be forwarded`,
                            );
                            return;
                          }
                          if (passthroughHeaders.includes(value)) {
                            toast.error(`"${value}" is already in the list`);
                            return;
                          }
                          setPassthroughHeaders((prev) => [...prev, value]);
                          e.currentTarget.value = "";
                        }}
                      />
                    )}
                  </div>
                )}

                {/* Identity Provider for JWKS auth */}
                {supportsIdentityProvider && identityProviders.length > 0 && (
                  <div className="space-y-2">
                    <Label>
                      {agentType === "agent"
                        ? "Identity Provider (JWKS)"
                        : "Identity Provider (Enterprise/JWKS)"}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {agentType === "agent"
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
                        setIdentityProviderId(value === "none" ? null : value)
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
                          <SelectItem key={provider.id} value={provider.id}>
                            {provider.providerId} ({provider.issuer})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </fieldset>
      {!readOnly && environmentConflicts.conflicts.length > 0 && (
        <Alert variant="warning" className="mt-4">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {environmentConflicts.conflicts.length} MCP server
            {environmentConflicts.conflicts.length === 1 ? null : (
              <span>s</span>
            )}{" "}
            not in this environment
          </AlertTitle>
          <AlertDescription>
            <p>
              This agent&apos;s tools from{" "}
              <span className="font-medium text-foreground">
                {environmentConflicts.conflicts.map((c) => c.name).join(", ")}
              </span>{" "}
              stop working once it moves. Remove them or put the environment
              back before saving.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={environmentConflicts.isRemoving || isSaving}
              onClick={() => void handleRemoveEnvironmentConflicts()}
            >
              <span>{removeConflictingToolsLabel}</span>
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {!readOnly &&
        environmentConflicts.blocksSave &&
        environmentConflicts.conflicts.length === 0 && (
          <Alert variant="warning" className="mt-4">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {environmentConflicts.isVerifying
                ? "Checking which of this agent's tools work in the new environment…"
                : "Could not check which of this agent's tools work in the new environment, so the change cannot be saved yet."}
            </AlertDescription>
          </Alert>
        )}
      {!readOnly && mcpEnvConflicts.length > 0 && (
        <Alert variant="warning" className="mt-4">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {mcpEnvConflicts.length} MCP server
            {mcpEnvConflicts.length === 1 ? null : <span>s</span>} not in this
            environment
          </AlertTitle>
          <AlertDescription>
            <p>
              Remove {mcpEnvConflicts.length === 1 ? "it" : "them"} or change
              the environment before saving:{" "}
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
      {readOnly ? (
        // A read-only form disables every field and has nothing to save, but
        // it still needs an exit: with no footer at all, a viewer who reached
        // this page by URL could only leave it with the browser's back button.
        <WizardFooter>
          <Button type="button" variant="outline" asChild>
            <Link href={readOnlyExitHref}>Cancel</Link>
          </Button>
        </WizardFooter>
      ) : (
        footer(footerState)
      )}
    </form>
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
  missingCredentialBehavior: MissingCredentialBehavior;
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

// The Custom knowledge picker draws from two tables into one list, so an id in
// it carries which table it came from. Ids from either are opaque to the picker
// and only ever routed back by prefix, so the strings need only be distinct.
const KNOWLEDGE_BASE_ID_PREFIX = "knowledge-base:";
const CONNECTOR_ID_PREFIX = "connector:";

// Both knowledge fields are empty until an org has a source, so both offer the
// same way out of that.
const KNOWLEDGE_CONNECTOR_CREATE_ACTION = {
  label: "Add a connector",
  href: "/knowledge/connectors",
};
