"use client";

import { ArrowUpRight, Hash, Lock, Search } from "lucide-react";
import { useState } from "react";
import { ChannelDetailsDialog } from "@/app/settings/messaging-channels/_components/channel-details-dialog";
import { AgentSelector } from "@/components/agent-selector";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogBody } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useAgentOptionsByIds } from "@/lib/agent-options.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useAllChatOpsBindings,
  useUpdateChatOpsBinding,
} from "@/lib/chatops/chatops.query";
import {
  useJoinSlackAgentBotChannel,
  useJoinSlackRouterBotChannel,
  useSlackAgentBotChannels,
  useSlackRouterBotChannels,
} from "@/lib/chatops/chatops-config.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * Edit an agent's Slack bot: the channels it is in, each with its settings,
 * and adding it to more. In Slack every agent answers through its own bot, so
 * its Slack channels belong here rather than in the agent's channel list.
 * Without an agent it edits the router bot, whose channels each have a
 * default agent.
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
  /** null for the router bot. */
  agentId: string | null;
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
      description={
        agentId
          ? "Channels this bot is in."
          : "Channels this bot is in, with the agent that answers there by default."
      }
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

/** Past this many channels, the list gets a search field. */
const SEARCH_FROM = 6;

type Binding = NonNullable<
  ReturnType<typeof useAllChatOpsBindings>["data"]
>["bindings"][number];

function BotChannels({
  agentId,
  handle,
  reinstallUrl,
}: {
  agentId: string | null;
  handle: string;
  reinstallUrl: string | null;
}) {
  const isRouter = agentId === null;
  const agentChannelsQuery = useSlackAgentBotChannels(agentId ?? undefined);
  const routerChannelsQuery = useSlackRouterBotChannels(isRouter);
  const channelsQuery = isRouter ? routerChannelsQuery : agentChannelsQuery;
  const agentJoin = useJoinSlackAgentBotChannel(agentId ?? "");
  const routerJoin = useJoinSlackRouterBotChannel();
  const joinMutation = isRouter ? routerJoin : agentJoin;
  const updateBinding = useUpdateChatOpsBinding();
  const bindingsQuery = useAllChatOpsBindings();
  const { data: agents = [] } = useAgentOptionsByIds({
    ids: (bindingsQuery.data?.bindings ?? []).flatMap((binding) =>
      binding.agentId ? [binding.agentId] : [],
    ),
  });
  const { data: canEdit } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const [detailsFor, setDetailsFor] = useState<{
    binding: Binding;
    description: string | null;
  } | null>(null);
  const [query, setQuery] = useState("");

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
      !isRouter &&
      binding.provider === "slack" &&
      !binding.isDm &&
      binding.agentId === agentId &&
      !memberChannels.some(
        (channel) => channel.channelId === binding.channelId,
      ),
  );
  const joinable = channels.filter((channel) => !channel.isMember);
  const needle = query.trim().toLowerCase();
  const matches = (...texts: Array<string | null | undefined>) =>
    !needle || texts.some((text) => text?.toLowerCase().includes(needle));
  const shownMembers = memberChannels.filter((channel) =>
    matches(channel.channelName, channel.channelId, channel.description),
  );
  const shownMissing = missing.filter((binding) =>
    matches(binding.channelName, binding.channelId),
  );
  const detailsRepliesToAll = repliesToAllAgent(detailsFor?.binding);
  const slackBotSettings = detailsFor
    ? {
        handle,
        description: detailsFor.description,
        repliesToAll: detailsRepliesToAll === agentId,
        repliesToAllElsewhere:
          detailsRepliesToAll && detailsRepliesToAll !== agentId
            ? agentNameFor(detailsRepliesToAll)
            : null,
      }
    : undefined;

  return (
    <div className="flex flex-col gap-3">
      {memberChannels.length === 0 && missing.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Not in any channel yet. Add it to a public channel below, or type{" "}
          <span className="font-mono text-foreground">/invite @{handle}</span>{" "}
          in a Slack channel.
        </p>
      ) : (
        <>
          {memberChannels.length + missing.length > SEARCH_FROM && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search channels"
                placeholder="Search channels…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-8"
              />
            </div>
          )}
          {shownMembers.length + shownMissing.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No channels match “{query.trim()}”.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {shownMembers.map((channel) => {
                const binding = bindingFor(channel.channelId);
                if (isRouter) {
                  return (
                    <ChannelRow
                      key={channel.channelId}
                      name={channel.channelName ?? channel.channelId}
                      description={channel.description}
                      isPrivate={channel.isPrivate}
                      status={
                        binding?.agentId
                          ? `Default agent: ${agentNameFor(binding.agentId)}`
                          : "No default agent yet: the first message asks for one"
                      }
                      action={
                        binding && canEdit ? (
                          <AgentSelector
                            mode="single"
                            flat
                            compactTrigger
                            remote={{
                              filters: {
                                agentType: "agent",
                                excludeBuiltIn: true,
                              },
                            }}
                            value={binding.agentId ?? ""}
                            onValueChange={(nextAgentId) =>
                              updateBinding.mutate({
                                id: binding.id,
                                body: { agentId: nextAgentId },
                              })
                            }
                            placeholder="Pick an agent"
                            className="w-44"
                          />
                        ) : null
                      }
                    />
                  );
                }
                const repliesToAll = repliesToAllAgent(binding);
                return (
                  <ChannelRow
                    key={channel.channelId}
                    name={channel.channelName ?? channel.channelId}
                    description={channel.description}
                    isPrivate={channel.isPrivate}
                    status={
                      repliesToAll === agentId
                        ? "Replies to all messages"
                        : repliesToAll
                          ? `Replies when @mentioned · ${agentNameFor(repliesToAll)} replies to all`
                          : "Replies when @mentioned"
                    }
                    hasInstructions={!!binding?.channelInstructions}
                    action={
                      binding ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setDetailsFor({
                              binding,
                              description: channel.description,
                            })
                          }
                        >
                          Settings
                        </Button>
                      ) : null
                    }
                  />
                );
              })}
              {shownMissing.map((binding) => {
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
        </>
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
        binding={detailsFor?.binding ?? null}
        assignedAgent={null}
        slackBot={slackBotSettings}
        open={detailsFor !== null}
        readOnly={!canEdit}
        isSaving={updateBinding.isPending}
        onOpenChange={(open) => {
          if (!open) setDetailsFor(null);
        }}
        onSave={async ({ channelInstructions, answerAllMessages }) => {
          if (!detailsFor) return;
          const { binding } = detailsFor;
          const ours = binding.agentId === agentId;
          const saved = await updateBinding.mutateAsync({
            id: binding.id,
            // Replying to all belongs to the channel's agent, so turning it on
            // moves the channel to this one. Turning it off, or leaving it off
            // in another agent's channel, leaves that agent's setting alone.
            body: answerAllMessages
              ? { channelInstructions, answerAllMessages: true, agentId }
              : ours
                ? { channelInstructions, answerAllMessages: false }
                : binding.agentId
                  ? { channelInstructions }
                  : { channelInstructions, agentId },
          });
          if (saved) setDetailsFor(null);
        }}
      />
    </div>
  );
}

/**
 * The agent whose bot replies to every message in a channel, if any: the
 * setting only takes effect for the channel's own agent.
 */
function repliesToAllAgent(binding: Binding | null | undefined) {
  return binding?.answerAllMessages && binding.agentId ? binding.agentId : null;
}

function ChannelRow({
  name,
  description,
  isPrivate,
  status,
  hasInstructions,
  warn,
  action,
}: {
  name: string;
  description?: string | null;
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
        {description && (
          <span className="truncate text-xs italic text-muted-foreground">
            {description}
          </span>
        )}
        <span
          className={cn(
            "truncate text-xs",
            warn
              ? "text-amber-800 dark:text-amber-300"
              : "text-muted-foreground",
          )}
        >
          <span>{status}</span>
          {hasInstructions && <span> · custom instructions</span>}
        </span>
      </span>
      {action}
    </li>
  );
}
