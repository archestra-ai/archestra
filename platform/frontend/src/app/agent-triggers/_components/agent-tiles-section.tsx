"use client";

import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { AgentDialog } from "@/components/agent-dialog";
import {
  AssignmentCombobox,
  type AssignmentComboboxItem,
} from "@/components/ui/assignment-combobox";
import { Button } from "@/components/ui/button";
import { useProfiles, useUpdateProfile } from "@/lib/agent.query";
import {
  useChatOpsBindings,
  useChatOpsStatus,
  useRefreshChatOpsChannelDiscovery,
  useUpdateChatOpsBinding,
} from "@/lib/chatops.query";
import { AgentTile } from "./agent-tile";
import { AgentTilesEmptyState } from "./agent-tiles-empty-state";
import { AgentTilesLoading } from "./agent-tiles-loading";
import type { ProviderConfig } from "./types";

export function AgentTilesSection({
  providerConfig,
  onRefreshSuccess,
}: {
  providerConfig: ProviderConfig;
  onRefreshSuccess?: () => void;
}) {
  const { data: bindings, isLoading } = useChatOpsBindings();
  const { data: agents } = useProfiles({ filters: { agentType: "agent" } });
  const { data: chatOpsProviders } = useChatOpsStatus();
  const updateMutation = useUpdateChatOpsBinding();
  const updateAgent = useUpdateProfile();
  const refreshMutation = useRefreshChatOpsChannelDiscovery();
  const [editingAgent, setEditingAgent] = useState<
    (typeof providerAgents)[number] | null
  >(null);

  const providerStatus =
    chatOpsProviders?.find((p) => p.id === providerConfig.provider) ?? null;

  const providerAgents =
    agents?.filter((a) =>
      Array.isArray(a.allowedChatops)
        ? a.allowedChatops.includes(providerConfig.provider)
        : false,
    ) ?? [];

  const providerBindings =
    bindings?.filter((b) => b.provider === providerConfig.provider) ?? [];

  // Channel counts for stats
  const totalChannelCount = providerBindings.filter((b) => !b.isDm).length;
  const assignedChannelCount = providerBindings.filter(
    (b) => !b.isDm && b.agentId,
  ).length;

  // Map agentId -> list of bindings
  const bindingsByAgentId = new Map<string, typeof providerBindings>();
  for (const b of providerBindings) {
    if (!b.agentId) continue;
    const list = bindingsByAgentId.get(b.agentId) ?? [];
    list.push(b);
    bindingsByAgentId.set(b.agentId, list);
  }

  // DM binding for current user
  const myDmBinding = providerBindings.find((b) => b.isDm);

  const handleDmClick = (agentId: string, deepLink: string) => {
    if (myDmBinding && myDmBinding.agentId !== agentId) {
      updateMutation.mutate({ id: myDmBinding.id, agentId });
    }
    window.open(deepLink, "_blank", "noopener,noreferrer");
  };

  // Channel combobox items for AssignmentCombobox inside each tile
  const channelComboboxItems: AssignmentComboboxItem[] = useMemo(
    () =>
      [...providerBindings]
        .sort((a, b) => (a.isDm === b.isDm ? 0 : a.isDm ? -1 : 1))
        .map((b) => ({
          id: b.id,
          name: b.isDm
            ? "Direct Messages"
            : `${b.channelName ?? b.channelId}${b.workspaceName ? ` (${b.workspaceName})` : ""}`,
        })),
    [providerBindings],
  );

  const handleToggleChannel = (agentId: string, bindingId: string) => {
    const agentBindings = bindingsByAgentId.get(agentId) ?? [];
    const isAssigned = agentBindings.some((b) => b.id === bindingId);
    updateMutation.mutate({
      id: bindingId,
      agentId: isAssigned ? null : agentId,
    });
  };

  const handleUnassignChannel = (bindingId: string) => {
    updateMutation.mutate({ id: bindingId, agentId: null });
  };

  // AssignmentCombobox data: all agents as items, enabled ones as selected
  const enabledAgentIds = useMemo(
    () => providerAgents.map((a) => a.id),
    [providerAgents],
  );

  const comboboxItems: AssignmentComboboxItem[] = useMemo(
    () =>
      (agents ?? []).map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description ?? undefined,
      })),
    [agents],
  );

  const handleToggleAgent = (agentId: string) => {
    const agent = agents?.find((a) => a.id === agentId);
    if (!agent) return;
    const currentChatops = Array.isArray(agent.allowedChatops)
      ? (agent.allowedChatops as string[])
      : [];
    const isEnabled = currentChatops.includes(providerConfig.provider);
    const newChatops = isEnabled
      ? currentChatops.filter((id) => id !== providerConfig.provider)
      : [...currentChatops, providerConfig.provider];
    updateAgent.mutate({
      id: agentId,
      data: {
        allowedChatops: newChatops as ("slack" | "ms-teams")[],
      },
    });
  };

  return (
    <section className="flex flex-col gap-4">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Agents ready to chat with</h2>
          <AssignmentCombobox
            items={comboboxItems}
            selectedIds={enabledAgentIds}
            onToggle={handleToggleAgent}
            placeholder="Search agents..."
            emptyMessage="No agents found."
            className="ml-2"
            label="Enable more"
          />
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Assign agents to channels using the Add button in agent tiles or use{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-xs">
            {providerConfig.slashCommand}
          </code>{" "}
          in {providerConfig.providerLabel}.
        </p>
      </div>

      {isLoading ? (
        <AgentTilesLoading />
      ) : providerAgents.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {providerAgents.map((agent) => {
            const agentBindings = bindingsByAgentId.get(agent.id) ?? [];
            const assignedIds = agentBindings.map((b) => b.id);
            return (
              <AgentTile
                key={agent.id}
                agent={agent}
                agentBindings={agentBindings}
                channelComboboxItems={channelComboboxItems}
                assignedChannelIds={assignedIds}
                totalChannelCount={totalChannelCount}
                providerConfig={providerConfig}
                providerStatus={providerStatus}
                onToggleChannel={(bindingId) =>
                  handleToggleChannel(agent.id, bindingId)
                }
                onUnassignChannel={handleUnassignChannel}
                onDmClick={handleDmClick}
                onEdit={() => setEditingAgent(agent)}
                isUpdating={updateMutation.isPending}
              />
            );
          })}
        </div>
      ) : (
        <AgentTilesEmptyState providerLabel={providerConfig.providerLabel} />
      )}

      {/* Channel stats + refresh */}
      {!isLoading && providerAgents.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            {assignedChannelCount} of {totalChannelCount} channels assigned to
            agents.
          </p>
          <p className="text-xs text-muted-foreground">
            Channels are discovered every 5 minutes.{" "}
            {refreshMutation.isPending ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                Refreshing…
              </span>
            ) : (
              <Button
                variant="link"
                className="h-auto p-0 text-xs"
                onClick={() =>
                  refreshMutation.mutate(providerConfig.provider, {
                    onSuccess: () => onRefreshSuccess?.(),
                  })
                }
              >
                Click here
              </Button>
            )}{" "}
            to refresh them now.
          </p>
        </div>
      )}

      <AgentDialog
        open={!!editingAgent}
        onOpenChange={(open) => !open && setEditingAgent(null)}
        agent={editingAgent}
        agentType="agent"
      />
    </section>
  );
}
