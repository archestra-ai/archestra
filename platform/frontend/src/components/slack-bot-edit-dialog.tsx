"use client";

import { ArrowUpRight, Hash, Lock } from "lucide-react";
import { useState } from "react";
import { ChannelDetailsDialog } from "@/app/settings/messaging-channels/_components/channel-details-dialog";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogBody } from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useInternalAgents } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useAllChatOpsBindings,
  useUpdateChatOpsBinding,
} from "@/lib/chatops/chatops.query";
import {
  useJoinSlackAgentBotChannel,
  useSlackAgentBotChannels,
} from "@/lib/chatops/chatops-config.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * Edit an agent's Slack bot: the channels it is in, each with its settings,
 * and adding it to more. In Slack every agent answers through its own bot, so
 * its Slack channels belong here rather than in the agent's channel list.
 */
export function SlackBotEditDialog({
  open,
  onOpenChange,
  agentId,
  handle,
  appId,
  installed,
  reinstallUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  handle: string;
  appId: string;
  installed: boolean;
  reinstallUrl: string | null;
}) {
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`@${handle}`}
      description="The channels this bot answers in."
      headerAction={
        <Button size="sm" variant="ghost" asChild>
          <a
            href={`https://api.slack.com/apps/${appId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>Open in Slack</span>
            <ArrowUpRight />
          </a>
        </Button>
      }
    >
      <DialogBody className="flex flex-col gap-4">
        {!installed ? (
          <p className="text-sm text-muted-foreground">
            Finish installing the bot first; then add it to channels here.
          </p>
        ) : (
          open && (
            <BotChannels
              agentId={agentId}
              handle={handle}
              reinstallUrl={reinstallUrl}
            />
          )
        )}
      </DialogBody>
    </FormDialog>
  );
}

// =============================================================================
// Internal Components
// =============================================================================

type Binding = NonNullable<
  ReturnType<typeof useAllChatOpsBindings>["data"]
>["bindings"][number];

function BotChannels({
  agentId,
  handle,
  reinstallUrl,
}: {
  agentId: string;
  handle: string;
  reinstallUrl: string | null;
}) {
  const channelsQuery = useSlackAgentBotChannels(agentId);
  const joinMutation = useJoinSlackAgentBotChannel(agentId);
  const updateBinding = useUpdateChatOpsBinding();
  const bindingsQuery = useAllChatOpsBindings();
  const { data: agents = [] } = useInternalAgents();
  const { data: canEdit } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const [detailsFor, setDetailsFor] = useState<Binding | null>(null);

  if (channelsQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading channels…</p>;
  }
  if (channelsQuery.isError || !channelsQuery.data) {
    return (
      <p className="text-sm text-muted-foreground">
        Slack did not list this bot's channels.{" "}
        <Button
          size="sm"
          variant="link"
          className="h-auto p-0"
          onClick={() => channelsQuery.refetch()}
        >
          Try again
        </Button>
      </p>
    );
  }

  const bindings = bindingsQuery.data?.bindings ?? [];
  const { channels, canJoin, workspaceId } = channelsQuery.data;
  const bindingFor = (channelId: string) =>
    bindings.find(
      (binding) =>
        binding.provider === "slack" &&
        binding.channelId === channelId &&
        (binding.workspaceId ?? null) === (workspaceId ?? null),
    ) ??
    bindings.find(
      (binding) =>
        binding.provider === "slack" && binding.channelId === channelId,
    );
  const agentNameFor = (id: string) =>
    agents.find((agent) => agent.id === id)?.name ?? "another agent";

  const memberChannels = channels.filter((channel) => channel.isMember);
  // Assigned to this agent (from before per-agent bots), but its bot is not
  // in them, so nobody answers as the agent there.
  const missing = bindings.filter(
    (binding) =>
      binding.provider === "slack" &&
      !binding.isDm &&
      binding.agentId === agentId &&
      !memberChannels.some(
        (channel) => channel.channelId === binding.channelId,
      ),
  );
  const joinable = channels.filter((channel) => !channel.isMember);

  return (
    <div className="flex flex-col gap-3">
      {memberChannels.length === 0 && missing.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Not in any channel yet. Add it to a public channel below, or type{" "}
          <span className="font-mono text-foreground">/invite @{handle}</span>{" "}
          in a Slack channel.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {memberChannels.map((channel) => {
            const binding = bindingFor(channel.channelId);
            const ownerId = binding?.agentId ?? null;
            const ours = ownerId === agentId;
            return (
              <ChannelRow
                key={channel.channelId}
                name={channel.channelName ?? channel.channelId}
                isPrivate={channel.isPrivate}
                status={
                  ownerId && !ours
                    ? `Answers when mentioned · belongs to ${agentNameFor(ownerId)}`
                    : binding?.answerAllMessages && ours
                      ? "Answers every message"
                      : "Answers when mentioned"
                }
                hasInstructions={!!binding?.channelInstructions}
                action={
                  !binding || !canEdit ? null : ownerId && !ours ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={updateBinding.isPending}
                      onClick={() =>
                        updateBinding.mutate({
                          id: binding.id,
                          body: { agentId },
                        })
                      }
                    >
                      Make it this agent's
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDetailsFor(binding)}
                    >
                      Settings
                    </Button>
                  )
                }
              />
            );
          })}
          {missing.map((binding) => {
            const channel = channels.find(
              (candidate) => candidate.channelId === binding.channelId,
            );
            // Slack lists every public channel, so one it does not list is
            // private (or gone).
            const isPrivate = channel?.isPrivate ?? true;
            return (
              <ChannelRow
                key={binding.id}
                name={binding.channelName ?? binding.channelId}
                isPrivate={isPrivate}
                status={
                  isPrivate
                    ? `The bot is not in it · type /invite @${handle} there`
                    : "The bot is not in it, so nobody answers as this agent"
                }
                warn
                action={
                  canEdit && !isPrivate && canJoin ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={joinMutation.isPending}
                      onClick={() => joinMutation.mutate(binding.channelId)}
                    >
                      Add bot
                    </Button>
                  ) : null
                }
              />
            );
          })}
        </ul>
      )}

      {canEdit &&
        (canJoin ? (
          joinable.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <SearchableSelect
                value=""
                onValueChange={(channelId) => {
                  if (channelId) joinMutation.mutate(channelId);
                }}
                placeholder={
                  joinMutation.isPending ? "Adding…" : "Add to a channel…"
                }
                ariaLabel="Add the bot to a Slack channel"
                searchPlaceholder="Search channels..."
                items={joinable.map((channel) => ({
                  value: channel.channelId,
                  label: `#${channel.channelName ?? channel.channelId}`,
                }))}
                className="w-full"
                disabled={joinMutation.isPending}
              />
              <span className="text-xs text-muted-foreground">
                Private channels: type{" "}
                <span className="font-mono">/invite @{handle}</span> there.
              </span>
            </div>
          )
        ) : (
          <p className="text-xs text-muted-foreground">
            To add the bot to channels from here, it needs Slack's permission to
            join them.{" "}
            {reinstallUrl ? (
              <a
                href={reinstallUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-foreground underline underline-offset-2"
              >
                Reinstall it in Slack
              </a>
            ) : (
              <span>Reinstall it in Slack.</span>
            )}{" "}
            Until then, type{" "}
            <span className="font-mono">/invite @{handle}</span> in a channel.
          </p>
        ))}

      <ChannelDetailsDialog
        binding={detailsFor}
        assignedAgent={
          detailsFor ? { id: agentId, name: agentNameFor(agentId) } : null
        }
        open={detailsFor !== null}
        readOnly={!canEdit}
        isSaving={updateBinding.isPending}
        onOpenChange={(open) => {
          if (!open) setDetailsFor(null);
        }}
        onSave={async ({ channelInstructions, answerAllMessages }) => {
          if (!detailsFor) return;
          const saved = await updateBinding.mutateAsync({
            id: detailsFor.id,
            // Saving a channel nobody owns makes it this agent's: answer-all
            // only applies to the channel's own agent.
            body: { channelInstructions, answerAllMessages, agentId },
          });
          if (saved) setDetailsFor(null);
        }}
      />
    </div>
  );
}

function ChannelRow({
  name,
  isPrivate,
  status,
  hasInstructions,
  warn,
  action,
}: {
  name: string;
  isPrivate: boolean;
  status: string;
  hasInstructions?: boolean;
  warn?: boolean;
  action: React.ReactNode;
}) {
  const Icon = isPrivate ? Lock : Hash;
  return (
    <li aria-label={name} className="flex items-center gap-3 px-3 py-2.5">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{name}</span>
        <span
          className={cn(
            "truncate text-xs",
            warn
              ? "text-amber-800 dark:text-amber-300"
              : "text-muted-foreground",
          )}
        >
          <span>{status}</span>
          {hasInstructions && <span> · has instructions</span>}
        </span>
      </span>
      {action}
    </li>
  );
}
