"use client";

import {
  type AgentScope,
  type AgentToolAssignmentMode,
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
import { AgentIconSelector } from "@/components/agent-icon-selector";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { KnowledgeBaseSelector } from "@/components/knowledge-base-selector";
import { ProfileLabels, type ProfileLabelsRef } from "@/components/profile-labels";
import { TeamSelector } from "@/components/team-selector";
import { ToolSelector } from "@/components/tool-selector";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogForm,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useCreateProfile,
  useUpdateProfile,
} from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils";
import type { AgentIconVariant } from "@/components/agent-icon";

export function AgentDialog({
  agent,
  agentType,
  open,
  onOpenChange,
  onCreated,
  readOnly,
  initialValues,
}: {
  agent?: archestraApiTypes.GetAgentsResponses["200"]["data"][number];
  agentType: AgentType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (agent: archestraApiTypes.AgentProfile) => void;
  readOnly?: boolean;
  initialValues?: {
    name?: string;
    description?: string;
    systemPrompt?: string;
    model?: string;
  };
}) {
  const isEdit = !!agent;
  const { data: isAdmin } = useHasPermissions({ agent: ["admin"] });
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;
  const appName = useAppName();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [icon, setIcon] = useState<AgentIconVariant | undefined>(undefined);
  const [scope, setScope] = useState<AgentScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>([]);
  const [connectorIds, setConnectorIds] = useState<string[]>([]);
  const [toolIds, setToolIds] = useState<string[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [suggestedPrompts, setSuggestedPrompts] = useState<
    archestraApiTypes.AgentProfile["suggestedPrompts"]
  >([]);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [toolAssignmentMode, setToolAssignmentMode] =
    useState<AgentToolAssignmentMode>("manual");
  const [passthroughHeaders, setPassthroughHeaders] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  const agentLabelsRef = useRef<ProfileLabelsRef>(null);

  useEffect(() => {
    if (open && initialValues && !isEdit) {
      setName(initialValues.name ?? "");
      setDescription(initialValues.description ?? "");
      setSystemPrompt(initialValues.systemPrompt ?? "");
      if (initialValues.model) setModel(initialValues.model);
    }
  }, [open, initialValues, isEdit]);

  useEffect(() => {
    if (open && agent) {
      setName(agent.name);
      setDescription(agent.description ?? "");
      setSystemPrompt(agent.systemPrompt ?? "");
      setIcon(agent.icon);
      setScope(agent.scope);
      setTeamIds(agent.teams?.map((t) => t.id) ?? []);
      setKnowledgeBaseIds(agent.knowledgeBaseIds ?? []);
      setConnectorIds(agent.connectorIds ?? []);
      setToolIds(agent.tools.map((t) => t.id));
      setLabels(agent.labels ?? []);
      setSuggestedPrompts(agent.suggestedPrompts ?? []);
      setModel(agent.model ?? undefined);
      setToolAssignmentMode(agent.toolAssignmentMode ?? "manual");
      setPassthroughHeaders(agent.passthroughHeaders ?? []);
    } else if (open && !isEdit) {
      setName("");
      setDescription("");
      setSystemPrompt("");
      setIcon(undefined);
      setScope("personal");
      setTeamIds([]);
      setKnowledgeBaseIds([]);
      setConnectorIds([]);
      setToolIds([]);
      setLabels([]);
      setSuggestedPrompts([]);
      setModel(undefined);
      setToolAssignmentMode("manual");
      setPassthroughHeaders([]);
    }
  }, [open, agent, isEdit]);

  const createAgent = useCreateProfile();
  const updateAgent = useUpdateProfile();

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!name.trim() || isSaving) return;

      setIsSaving(true);
      try {
        const payload: archestraApiTypes.CreateAgentRequest = {
          name,
          description,
          systemPrompt,
          icon,
          scope,
          teamIds: scope === "team" ? teamIds : [],
          knowledgeBaseIds,
          connectorIds,
          toolIds,
          labels,
          suggestedPrompts,
          model,
          toolAssignmentMode,
          passthroughHeaders,
          agentType,
        };

        if (isEdit && agent) {
          await updateAgent.mutateAsync({ id: agent.id, ...payload });
          toast.success("Agent updated successfully");
        } else {
          const newAgent = await createAgent.mutateAsync(payload);
          toast.success("Agent created successfully");
          onCreated?.(newAgent as archestraApiTypes.AgentProfile);
        }
        handleClose();
      } catch (error) {
        // Error handled by query client
      } finally {
        setIsSaving(false);
      }
    },
    [
      name,
      description,
      systemPrompt,
      icon,
      scope,
      teamIds,
      knowledgeBaseIds,
      connectorIds,
      toolIds,
      labels,
      suggestedPrompts,
      model,
      toolAssignmentMode,
      passthroughHeaders,
      agentType,
      isEdit,
      agent,
      createAgent,
      updateAgent,
      onCreated,
      handleClose,
      isSaving,
    ],
  );

  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: userTeams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getTeams({
        query: { limit: 100, offset: 0 },
      });
      return data?.data || [];
    },
    enabled: !!canReadTeams,
  });

  const hasNoAvailableTeams = !userTeams || userTeams.length === 0;
  const requiresTeamSelection = scope === "team" && teamIds.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col p-0 overflow-hidden">
        <DialogForm onSubmit={handleSubmit} className="flex flex-col h-full">
          <DialogHeader className="p-6 pb-0">
            <DialogTitle>
              {readOnly ? "View Agent" : isEdit ? "Edit Agent" : "Create Agent"}
            </DialogTitle>
            <DialogDescription>
              {readOnly
                ? "View agent configuration and details."
                : "Configure your agent's identity, behavior, and capabilities."}
            </DialogDescription>
          </DialogHeader>

          <fieldset disabled={readOnly} className="flex-1 overflow-y-auto p-6">
            <div className="space-y-8">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="space-y-6">
                  <div className="space-y-2">
                    <Label htmlFor="agent-name">Name</Label>
                    <Input
                      id="agent-name"
                      placeholder="e.g. Support Assistant"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      data-testid={E2eTestId.AgentNameInput}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="agent-description">Description</Label>
                    <Textarea
                      id="agent-description"
                      placeholder="Briefly describe what this agent does..."
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={2}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Icon</Label>
                    <AgentIconSelector value={icon} onChange={setIcon} />
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="space-y-4">
                    <Label>Visibility & Scope</Label>
                    <div className="grid grid-cols-1 gap-2">
                      <Button
                        type="button"
                        variant={scope === "personal" ? "default" : "outline"}
                        className="justify-start h-auto py-3 px-4"
                        onClick={() => setScope("personal")}
                      >
                        <User className="mr-3 h-5 w-5" />
                        <div className="text-left">
                          <div className="font-semibold text-sm">Personal</div>
                          <div className="text-xs opacity-80">
                            Only you can see and use this agent
                          </div>
                        </div>
                        {scope === "personal" && (
                          <CheckIcon className="ml-auto h-4 w-4" />
                        )}
                      </Button>

                      <Tooltip
                        open={hasNoAvailableTeams && scope !== "team" ? undefined : false}
                      >
                        <TooltipTrigger asChild>
                          <div className="w-full">
                            <Button
                              type="button"
                              variant={scope === "team" ? "default" : "outline"}
                              className="justify-start h-auto py-3 px-4 w-full"
                              onClick={() => setScope("team")}
                              disabled={hasNoAvailableTeams}
                            >
                              <Users className="mr-3 h-5 w-5" />
                              <div className="text-left">
                                <div className="font-semibold text-sm">Team</div>
                                <div className="text-xs opacity-80">
                                  Shared with specific teams
                                </div>
                              </div>
                              {scope === "team" && (
                                <CheckIcon className="ml-auto h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </TooltipTrigger>
                        {hasNoAvailableTeams && (
                          <TooltipContent>
                            You must be a member of at least one team to create
                            team-scoped agents.
                          </TooltipContent>
                        )}
                      </Tooltip>

                      {isAdmin && (
                        <Button
                          type="button"
                          variant={scope === "org" ? "default" : "outline"}
                          className="justify-start h-auto py-3 px-4"
                          onClick={() => setScope("org")}
                        >
                          <Building2 className="mr-3 h-5 w-5" />
                          <div className="text-left">
                            <div className="font-semibold text-sm">Organization</div>
                            <div className="text-xs opacity-80">
                              Available to everyone in the organization
                            </div>
                          </div>
                          {scope === "org" && (
                            <CheckIcon className="ml-auto h-4 w-4" />
                          )}
                        </Button>
                      )}
                    </div>
                  </div>

                  {scope === "team" && (
                    <div className="space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
                      <Label>Select Teams</Label>
                      <TeamSelector
                        selectedTeamIds={teamIds}
                        onTeamIdsChange={setTeamIds}
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label htmlFor="system-prompt" className="text-base font-semibold">
                    System Prompt
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => setSystemPrompt("")}
                  >
                    <RotateCcw className="mr-1 h-3 w-3" /> Clear
                  </Button>
                </div>
                <Textarea
                  id="system-prompt"
                  placeholder="Instructions for the agent's behavior, personality, and constraints..."
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  className="min-h-[200px] font-mono text-sm leading-relaxed"
                  data-testid={E2eTestId.AgentSystemPromptInput}
                />
                <p className="text-xs text-muted-foreground italic">
                  Tip: Be specific about the agent's role, the tools it should
                  use, and how it should format its responses.
                </p>
              </div>

              <Tabs defaultValue="capabilities" className="w-full">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="capabilities">Capabilities</TabsTrigger>
                  <TabsTrigger value="advanced">Advanced</TabsTrigger>
                </TabsList>
                
                <TabsContent value="capabilities" className="space-y-6 pt-4">
                  <div className="space-y-4">
                    <Label className="text-base">Tools & Skills</Label>
                    <ToolSelector
                      selectedToolIds={toolIds}
                      onToolIdsChange={setToolIds}
                    />
                  </div>

                  <div className="space-y-4">
                    <Label className="text-base">Knowledge Bases</Label>
                    <KnowledgeBaseSelector
                      selectedIds={knowledgeBaseIds}
                      onChange={setKnowledgeBaseIds}
                    />
                  </div>
                </TabsContent>

                <TabsContent value="advanced" className="space-y-6 pt-4">
                   <div className="space-y-2">
                    <Label>Model Override (Optional)</Label>
                    <Input 
                      placeholder="e.g. gpt-4o, claude-3-opus"
                      value={model ?? ""}
                      onChange={(e) => setModel(e.target.value || undefined)}
                    />
                  </div>

                  <div className="space-y-4 pt-2">
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label>Tool Assignment Mode</Label>
                        <p className="text-xs text-muted-foreground">
                          Control how the agent selects tools for tasks.
                        </p>
                      </div>
                      <Select
                        value={toolAssignmentMode}
                        onValueChange={(v) => setToolAssignmentMode(v as any)}
                      >
                        <SelectTrigger className="w-[180px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="manual">Manual</SelectItem>
                          <SelectItem value="auto">Auto-Select</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>

              {!readOnly && (
                <div className="pt-4 border-t">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <Label className="text-base font-semibold">Labels</Label>
                      <p className="text-sm text-muted-foreground">
                        Organize and categorize your agents.
                      </p>
                      {agentType === "agent" && (
                        <ExternalDocsLink
                          href={getDocsUrl(DocsPage.PlatformAgents)}
                          showIcon={false}
                        >
                          Learn more
                        </ExternalDocsLink>
                      )}
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
