"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { SetupDialog } from "@/components/setup-dialog";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useProfiles, useUpdateProfile } from "@/lib/agent.query";

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
      <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4 min-h-0 min-w-0">
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
              Mention the bot (e.g., <strong>@Archestra</strong>) and send any
              message to it or use{" "}
              <code className="bg-muted px-1 py-0.5 rounded text-xs">
                /select-agent
              </code>{" "}
              command
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
