"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { SetupDialog } from "@/components/setup-dialog";
import { StepCard } from "@/components/step-card";
import { Switch } from "@/components/ui/switch";
import { useProfiles, useUpdateProfile } from "@/lib/agent.query";

interface SlackAgentSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SlackAgentSetupDialog({
  open,
  onOpenChange,
}: SlackAgentSetupDialogProps) {
  const queryClient = useQueryClient();
  const { data: agents } = useProfiles({ filters: { agentType: "agent" } });

  const hasSlackAgent =
    agents?.some((a) =>
      Array.isArray(a.allowedChatops)
        ? a.allowedChatops.includes("slack")
        : false,
    ) ?? false;

  return (
    <SetupDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Connect Agents to Slack channels"
      description="Enable Slack on your agent, then bind it to a channel so it can receive and respond to messages."
      canProceed={(step) => {
        if (step === 0) return hasSlackAgent;
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
        <StepEnableSlack key="enable" />,
        <StepSelectAgentInSlack key="invite" />,
      ]}
    />
  );
}

function StepEnableSlack() {
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
      ? [...currentChatops, "slack"]
      : currentChatops.filter((id) => id !== "slack");

    updateAgent.mutate({
      id: agentId,
      data: { allowedChatops: newChatops as "slack"[] },
    });
  };

  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard stepNumber={1} title="Enable Slack on Agent">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Toggle Slack on for each agent that should be available in Slack. At
          least one agent must be enabled to proceed.
        </p>
        <div className="rounded-md border border-muted bg-muted/30 px-3 py-2 text-xs text-muted-foreground leading-relaxed mt-2">
          <strong>Access control:</strong> Only users who have access to the
          agent (via team membership) can interact with it through Slack. Make
          sure the relevant teams are assigned to the agent. Users are
          identified by email, so their Slack account email must match their
          Archestra email.
        </div>
      </StepCard>

      <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4 min-h-0 min-w-0">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium">Agents</h4>
          <span className="text-sm font-medium">Slack enabled</span>
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
              const isEnabled = chatops.includes("slack");
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
    </div>
  );
}

function StepSelectAgentInSlack() {
  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard stepNumber={2} title="Select default Agent for Slack channel">
        <ol className="space-y-3">
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="pt-0.5">
              Open Slack and navigate to the channel where the bot is installed
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
                /archestra-select-agent
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
      </StepCard>

      <video
        src="/slack/slack-agent-bind.mp4"
        controls
        muted
        autoPlay
        loop
        playsInline
        className="rounded-md w-full"
      />
    </div>
  );
}
