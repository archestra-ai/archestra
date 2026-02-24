"use client";

import { useMemo } from "react";
import { useProfiles } from "@/lib/agent.query";
import {
  useChatOpsBindings,
  useChatOpsStatus,
  useRefreshChatOpsChannelDiscovery,
  useUpdateChatOpsBinding,
} from "@/lib/chatops.query";
import { ChannelTile } from "./channel-tile";
import { ChannelTilesEmptyState } from "./channel-tiles-empty-state";
import { ChannelTilesLoading } from "./channel-tiles-loading";
import { StartDmTile } from "./start-dm-tile";
import type { ProviderConfig } from "./types";

export function ChannelTilesSection({
  providerConfig,
}: {
  providerConfig: ProviderConfig;
}) {
  const { data: bindings, isLoading } = useChatOpsBindings();
  const { data: agents } = useProfiles({ filters: { agentType: "agent" } });
  const { data: chatOpsProviders } = useChatOpsStatus();
  const updateMutation = useUpdateChatOpsBinding();
  const refreshMutation = useRefreshChatOpsChannelDiscovery();

  const providerStatus =
    chatOpsProviders?.find((p) => p.id === providerConfig.provider) ?? null;

  const providerBindings = useMemo(
    () => bindings?.filter((b) => b.provider === providerConfig.provider) ?? [],
    [bindings, providerConfig.provider],
  );

  // Sort: DMs first, then channels alphabetically
  const sortedBindings = useMemo(
    () =>
      [...providerBindings].sort((a, b) => {
        if (a.isDm && !b.isDm) return -1;
        if (!a.isDm && b.isDm) return 1;
        const nameA = a.channelName ?? a.channelId;
        const nameB = b.channelName ?? b.channelId;
        return nameA.localeCompare(nameB);
      }),
    [providerBindings],
  );

  // Agent list for picker
  const agentList = useMemo(
    () => (agents ?? []).map((a) => ({ id: a.id, name: a.name })),
    [agents],
  );

  // Show "Start DM" tile when no DM binding exists and we can build a deep link
  const hasDmBinding = providerBindings.some((b) => b.isDm);
  const dmDeepLink =
    !hasDmBinding && providerStatus
      ? (providerConfig.getDmDeepLink?.(providerStatus) ?? null)
      : null;

  // Stats
  const totalCount = providerBindings.length;
  const assignedCount = providerBindings.filter((b) => b.agentId).length;

  const handleAssignAgent = (bindingId: string, agentId: string | null) => {
    updateMutation.mutate({ id: bindingId, agentId });
  };

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Channels</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Assign a default agent to each channel. Use the picker on each channel
          card or{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-xs">
            {providerConfig.slashCommand}
          </code>{" "}
          in {providerConfig.providerLabel}.
        </p>
      </div>

      {isLoading ? (
        <ChannelTilesLoading />
      ) : sortedBindings.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {dmDeepLink && (
            <StartDmTile
              providerConfig={providerConfig}
              deepLink={dmDeepLink}
            />
          )}
          {sortedBindings.map((binding) => {
            const assignedAgent = binding.agentId
              ? agentList.find((a) => a.id === binding.agentId)
              : undefined;
            return (
              <ChannelTile
                key={binding.id}
                binding={binding}
                agents={agentList}
                assignedAgent={assignedAgent}
                providerConfig={providerConfig}
                providerStatus={providerStatus}
                onAssignAgent={handleAssignAgent}
                isUpdating={updateMutation.isPending}
              />
            );
          })}
        </div>
      ) : (
        <ChannelTilesEmptyState
          onRefresh={() => refreshMutation.mutate(providerConfig.provider)}
          isRefreshing={refreshMutation.isPending}
          provider={providerConfig.provider}
        />
      )}

      {/* Stats + refresh */}
      {!isLoading && sortedBindings.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            {assignedCount} of {totalCount} channels assigned.
          </p>
          <p className="text-xs text-muted-foreground">
            New channels appear after adding the bot to a channel and the first
            interaction with it.
          </p>
        </div>
      )}
    </section>
  );
}
