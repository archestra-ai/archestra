"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useProfiles, useUpdateProfile } from "@/lib/agent.query";

interface EnableAgentsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: "slack" | "ms-teams";
}

export function EnableAgentsDialog({
  open,
  onOpenChange,
  provider,
}: EnableAgentsDialogProps) {
  const { data: agents, isLoading } = useProfiles({
    filters: { agentType: "agent" },
  });
  const updateAgent = useUpdateProfile();

  const providerLabel = provider === "slack" ? "Slack" : "MS Teams";

  const handleToggle = (
    agentId: string,
    currentChatops: string[],
    checked: boolean,
  ) => {
    const newChatops = checked
      ? [...currentChatops, provider]
      : currentChatops.filter((id) => id !== provider);

    updateAgent.mutate({
      id: agentId,
      data: { allowedChatops: newChatops as ("slack" | "ms-teams")[] },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Enable {providerLabel} on Agents</DialogTitle>
          <DialogDescription>
            Toggle {providerLabel} on for each agent that should be available in{" "}
            {providerLabel}.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1 max-h-[50vh] overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : agents && agents.length > 0 ? (
            agents.map((agent) => {
              const chatops = Array.isArray(agent.allowedChatops)
                ? (agent.allowedChatops as string[])
                : [];
              const isEnabled = chatops.includes(provider);
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
            })
          ) : (
            <div className="flex items-center justify-center py-8">
              <p className="text-sm text-muted-foreground">
                No agents found. Create an agent first.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
