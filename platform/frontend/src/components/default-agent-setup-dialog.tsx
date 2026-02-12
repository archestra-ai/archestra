"use client";

import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Globe, Loader2 } from "lucide-react";
import { useState } from "react";
import { SetupDialog } from "@/components/setup-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useProfiles, useUpdateProfile } from "@/lib/agent.query";
import { useHasPlaywrightMcpTools } from "@/lib/chat.query";
import { useChatOpsBindings } from "@/lib/chatops.query";
import { useFeatureFlag } from "@/lib/features.hook";

interface DefaultAgentSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DefaultAgentSetupDialog({
  open,
  onOpenChange,
}: DefaultAgentSetupDialogProps) {
  const queryClient = useQueryClient();
  const { data: agents } = useProfiles({ filters: { agentType: "agent" } });

  const hasMsTeamsAgent =
    agents?.some((a) =>
      Array.isArray(a.allowedChatops)
        ? a.allowedChatops.includes("ms-teams")
        : false,
    ) ?? false;

  return (
    <SetupDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Connect Agents to MS Teams channels"
      description="Enable MS Teams on your agent, then bind it to a channel so it can receive and respond to messages."
      canProceed={(step) => {
        if (step === 0) return hasMsTeamsAgent;
        return true;
      }}
      lastStepAction={{
        label: "Done",
        onClick: () => {
          queryClient.invalidateQueries({ queryKey: ["agents"] });
          queryClient.invalidateQueries({ queryKey: ["chatops", "bindings"] });
          onOpenChange(false);
        },
      }}
      steps={[
        <StepEnableMsTeams key="enable" />,
        <StepSelectAgentInTeams key="invite" />,
      ]}
    />
  );
}

function StepEnableMsTeams() {
  const { data: agents, isLoading } = useProfiles({
    filters: { agentType: "agent" },
  });
  const updateAgent = useUpdateProfile();

  const handleToggle = (
    agentId: string,
    currentChatops: string[],
    checked: boolean,
  ) => {
    const newChatops = checked
      ? [...currentChatops, "ms-teams"]
      : currentChatops.filter((id) => id !== "ms-teams");

    updateAgent.mutate({
      id: agentId,
      data: { allowedChatops: newChatops as "ms-teams"[] },
    });
  };

  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "6fr 4fr" }}
    >
      <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4 min-h-0">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium">Agents</h4>
          <span className="text-sm font-medium">Teams enabled</span>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : agents && agents.length > 0 ? (
          <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
            {agents.map((agent) => {
              const chatops = Array.isArray(agent.allowedChatops)
                ? (agent.allowedChatops as string[])
                : [];
              const isEnabled = chatops.includes("ms-teams");
              const isPending =
                updateAgent.isPending && updateAgent.variables?.id === agent.id;

              return (
                <div
                  key={agent.id}
                  className="flex items-center justify-between rounded-md border bg-background px-3 py-2.5"
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium truncate">
                      {agent.name}
                    </span>
                    {agent.description && (
                      <span className="text-xs text-muted-foreground truncate">
                        {agent.description}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    {isPending && (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                    )}
                    <Switch
                      checked={isEnabled}
                      onCheckedChange={(checked) =>
                        handleToggle(agent.id, chatops, checked)
                      }
                      disabled={isPending}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              No agents found. Create an agent first.
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 py-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            Step 1
          </Badge>
          <h3 className="text-lg font-semibold">Enable MS Teams on Agent</h3>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Toggle MS Teams on for each agent that should be available in
          Microsoft Teams. At least one agent must be enabled to proceed.
        </p>
        <div className="rounded-md border border-muted bg-muted/30 px-3 py-2 text-xs text-muted-foreground leading-relaxed mt-2">
          <strong>Access control:</strong> Only users who have access to the
          agent (via team membership) can interact with it through Teams. Make
          sure the relevant teams are assigned to the agent. Users are
          identified by email, so their Microsoft account email must match their
          Archestra email.
        </div>
      </div>
    </div>
  );
}

function StepSelectAgentInTeams() {
  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "6fr 4fr" }}
    >
      <div className="flex justify-center items-center rounded-lg border bg-muted/30 p-2 relative">
        <video
          src="/ms-teams/agent-bound.mp4"
          controls
          muted
          autoPlay
          loop
          playsInline
          className="rounded-md w-full h-full object-contain"
        />
      </div>

      <div className="flex flex-col gap-4 py-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            Step 2
          </Badge>
          <h3 className="text-lg font-semibold">
            Select default Agent for Teams channel
          </h3>
        </div>
        <ol className="space-y-3">
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="pt-0.5">
              Open Microsoft Teams and navigate to the channel where the bot is
              installed
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              2
            </span>
            <span className="pt-0.5">
              Mention the bot (e.g., <strong>@Archestra</strong>) or type{" "}
              <code className="bg-muted px-1 py-0.5 rounded text-xs">
                /select-agent
              </code>
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              3
            </span>
            <span className="pt-0.5">
              Choose an agent from the selection card that appears
            </span>
          </li>
        </ol>
      </div>
    </div>
  );
}

export function StepStartChatting({
  showStepHeader = true,
}: {
  showStepHeader?: boolean;
} = {}) {
  const isK8sEnabled = useFeatureFlag("orchestrator-k8s-runtime");
  const { data: bindings } = useChatOpsBindings();
  const { data: agents } = useProfiles({ filters: { agentType: "agent" } });

  // Build list of agents that are bound to at least one MS Teams channel
  const boundAgentIds = new Set(
    bindings?.map((b) => b.agentId).filter(Boolean) ?? [],
  );
  const boundAgents = agents?.filter((a) => boundAgentIds.has(a.id)) ?? [];

  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(
    undefined,
  );
  // Auto-select first bound agent when data loads
  const effectiveAgentId =
    selectedAgentId ?? (boundAgents.length > 0 ? boundAgents[0].id : undefined);

  const {
    hasPlaywrightMcpTools,
    isInstalling,
    installBrowser,
    reinstallRequired,
    installationFailed,
    playwrightServerId,
    reinstallBrowser,
    assignToolsToAgent,
    isAssigningTools,
    isPlaywrightInstalledByCurrentUser,
  } = useHasPlaywrightMcpTools(effectiveAgentId);

  const browserReady =
    hasPlaywrightMcpTools &&
    isPlaywrightInstalledByCurrentUser &&
    !reinstallRequired &&
    !installationFailed;

  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "6fr 4fr" }}
    >
      <div className="flex flex-col gap-5 rounded-lg border bg-muted/30 p-6">
        <h4 className="text-sm font-medium">Example: Browse the web</h4>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Your agent can browse the web on your behalf when the Browser tool is
          installed. Try asking it something like:
        </p>
        <div className="rounded-md border bg-background px-4 py-3">
          <p className="text-sm text-muted-foreground">
            <strong>@Archestra</strong>{" "}
            <span className="italic">
              What are the latest headlines on bbc.com?
            </span>
          </p>
        </div>
        <div className="rounded-md border bg-background px-4 py-3">
          <p className="text-sm text-muted-foreground">
            <strong>@Archestra</strong>{" "}
            <span className="italic">
              Summarize the front page of techcrunch.com
            </span>
          </p>
        </div>
        <p className="text-xs text-muted-foreground mt-auto">
          These are just examples — your agent can use any tools assigned to it
          in the profile settings.
        </p>
      </div>

      <div className="flex flex-col gap-4 py-2">
        {showStepHeader && (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono text-xs">
              Step 4
            </Badge>
            <h3 className="text-lg font-semibold">
              Start chatting with your agent
            </h3>
          </div>
        )}
        <p className="text-sm text-muted-foreground leading-relaxed">
          You&apos;re all set! Mention the bot in your Teams channel and start
          chatting. Your agent will respond using its configured tools and
          prompts.
        </p>

        {isK8sEnabled && (
          <div className="flex flex-col gap-3 mt-2">
            <h4 className="text-sm font-medium">Browser tools</h4>
            {browserReady ? (
              <div className="flex items-center gap-2 rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2.5 text-sm">
                <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                <span>Browser tools are installed and ready to use.</span>
              </div>
            ) : !effectiveAgentId ? (
              <p className="text-xs text-muted-foreground leading-relaxed">
                Bind an agent to a Teams channel first to install browser tools.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Install the Browser tools so your agent can browse websites
                  and retrieve live content when asked. Select agent that will
                  have browser tools assigned.
                </p>
                {boundAgents.length > 0 && (
                  <Select
                    value={effectiveAgentId}
                    onValueChange={setSelectedAgentId}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select an agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {boundAgents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {isPlaywrightInstalledByCurrentUser &&
                !hasPlaywrightMcpTools ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isAssigningTools}
                    onClick={() =>
                      assignToolsToAgent({ agentId: effectiveAgentId })
                    }
                  >
                    {isAssigningTools ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Assigning tools...
                      </>
                    ) : (
                      <>
                        <Globe className="h-4 w-4 mr-2" />
                        Assign tools to agent
                      </>
                    )}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isInstalling}
                    onClick={() => {
                      if (
                        (reinstallRequired || installationFailed) &&
                        playwrightServerId
                      ) {
                        reinstallBrowser(playwrightServerId);
                      } else {
                        installBrowser(effectiveAgentId);
                      }
                    }}
                  >
                    {isInstalling ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Installing...
                      </>
                    ) : reinstallRequired || installationFailed ? (
                      <>
                        <Globe className="h-4 w-4 mr-2" />
                        Reinstall Browser
                      </>
                    ) : (
                      <>
                        <Globe className="h-4 w-4 mr-2" />
                        Install Browser
                      </>
                    )}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
