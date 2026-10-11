"use client";

import { MESSAGING_CHANNEL_LABELS, slackHandleFor } from "@archestra/shared";
import {
  Hash,
  MessageSquare,
  Monitor,
  Share2,
  TerminalSquare,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { channelDisplayName } from "@/app/settings/messaging-channels/_components/channel-details-dialog";
import { ChannelIcon } from "@/components/channel-icon";
import { SlackBotEditDialog } from "@/components/slack-bot-edit-dialog";
import { Button } from "@/components/ui/button";
import { useAgentRuntimePreflight } from "@/lib/agent-runtime.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAllChatOpsBindings } from "@/lib/chatops/chatops.query";
import {
  useSlackAgentBotChannels,
  useSlackAgentBots,
} from "@/lib/chatops/chatops-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useMessagingChannelCatalog } from "@/lib/integration-overrides";
import { cn } from "@/lib/utils/tailwind";
import { agentDetailHref } from "./agent-page-config";

/**
 * The top of an agent's General tab: the places people give it work, each
 * with the one action that gets them there. A container-runtime agent leads
 * with handoff from a laptop; an agent on the built-in harness offers its A2A
 * endpoint and the option of a dedicated runtime instead.
 */
export function AgentWorkSources({
  agentId,
  hasRuntime,
  runtimeAvailable,
  chatHref,
  showsA2a,
}: {
  agentId: string;
  hasRuntime: boolean;
  /** Whether a dedicated runtime can be set up on this deployment. */
  runtimeAvailable: boolean;
  chatHref: string | null;
  showsA2a: boolean;
}) {
  const appName = useAppName();
  const { data: canReadChannels } = useHasPermissions({
    organizationSettings: ["read"],
  });
  // The setup checklist above says what is missing; until it is settled
  // these routes lead to a run that cannot start, so they read as later.
  const preflight = useAgentRuntimePreflight(agentId, hasRuntime);
  const awaitingSetup = hasRuntime && preflight.data?.ready === false;
  return (
    <div className="space-y-4">
      <section
        aria-labelledby="agent-work-sources"
        className={cn("space-y-3", awaitingSetup && "opacity-60")}
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="agent-work-sources" className="text-base font-semibold">
            {hasRuntime ? "Give it work" : "Where people use it"}
          </h2>
          {awaitingSetup && (
            <span className="text-[13px] text-muted-foreground">
              Available once setup above is done.
            </span>
          )}
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <WorkSourceCard
            icon={<MessageSquare className="size-4" />}
            title={`In ${appName} chat`}
            action={
              chatHref ? (
                <Button size="sm" asChild>
                  <Link href={chatHref}>Open in chat</Link>
                </Button>
              ) : null
            }
          >
            {hasRuntime
              ? "Opens a chat with this agent. Watch the live terminal while it works."
              : "Answers in seconds. Tool calls, approvals and files show right in the conversation."}
          </WorkSourceCard>
          {hasRuntime ? (
            <WorkSourceCard
              icon={<Monitor className="size-4" />}
              title="From your laptop"
              action={
                <Button size="sm" variant="outline" asChild>
                  <Link href="/connection">Connect your local agent</Link>
                </Button>
              }
            >
              <span className="flex flex-col gap-2.5">
                <span>{`Add the ${appName} MCP gateway to Claude Code or Codex once. Then say "hand this over to ${appName}": your changes, files and credentials move into a run here. "Bring it back" returns a patch.`}</span>
                <span
                  role="img"
                  aria-label={`Example: hand this over to ${appName}`}
                  className="flex flex-col rounded-[10px] bg-[#16130F] px-3.5 py-3 font-mono text-xs leading-[1.7] text-[#D9D4CE]"
                >
                  <span>&gt; hand this over to {appName}</span>
                  <span className="text-[#9CC59F]">
                    ✓ Run started on this agent
                  </span>
                </span>
              </span>
            </WorkSourceCard>
          ) : (
            showsA2a && (
              <WorkSourceCard
                icon={<Share2 className="size-4" />}
                title="Other agents and apps"
                action={
                  <Button size="sm" variant="outline" asChild>
                    <Link href={agentDetailHref("agent", agentId, "connect")}>
                      A2A details
                    </Link>
                  </Button>
                }
              >
                Your other agents can hand it work as a subagent. Outside apps
                call it over A2A.
              </WorkSourceCard>
            )
          )}
          {canReadChannels && (
            <AgentChannelsCard agentId={agentId} hasRuntime={hasRuntime} />
          )}
        </div>
      </section>
      {!hasRuntime && runtimeAvailable && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted"
          >
            <TerminalSquare className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              Needs to write code or run long tasks?
            </p>
            <p className="text-xs text-muted-foreground">
              Give it a dedicated runtime: its own container with a terminal and
              files that persist.
            </p>
          </div>
          <Button size="sm" variant="outline" asChild>
            <Link href={agentDetailHref("agent", agentId, "runtime")}>
              Set up Agent Runtime
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}

function AgentChannelsCard({
  agentId,
  hasRuntime,
}: {
  agentId: string;
  hasRuntime: boolean;
}) {
  const appName = useAppName();
  const bindings = useAllChatOpsBindings();
  const catalog = useMessagingChannelCatalog();
  // Quiet: without the Slack settings, the card keeps its provider-neutral copy.
  const slackBots = useSlackAgentBots({ quiet: true });
  const [editingBot, setEditingBot] = useState(false);
  const slackOffered = !catalog.isHidden("slack");
  // With one bot per agent, Slack is reached through the agent's own bot, not
  // through channels assigned to it. A Slack app still routed by channel (not
  // yet converted) keeps the old meaning.
  const slackPerAgent =
    slackOffered && !!slackBots.data && slackBots.data.unassignedApp === null;
  const slackBot = slackBots.data?.bots.find((bot) => bot.agentId === agentId);
  const slackHandle = slackBot
    ? (slackBot.handle ?? slackHandleFor(appName, slackBot.agentName))
    : null;
  const botChannels = useSlackAgentBotChannels(
    slackBot?.installed ? agentId : undefined,
  );
  const botChannelCount = botChannels.data?.channels.filter(
    (channel) => channel.isMember,
  ).length;

  const assigned = (bindings.data?.bindings ?? []).filter(
    (binding) => binding.agentId === agentId,
  );
  const listed = slackPerAgent
    ? assigned.filter((binding) => binding.provider !== "slack")
    : assigned;
  // Assignments from before per-agent bots, left without a bot to answer.
  const slackWithoutBot =
    slackPerAgent &&
    !slackBot &&
    assigned.some((binding) => binding.provider === "slack" && !binding.isDm);
  const manageHref = agentDetailHref("agent", agentId, "messaging");
  const addBotHref = `/settings/messaging-channels/slack?addBot=${encodeURIComponent(agentId)}`;
  const reachable = listed.length > 0 || !!slackBot;

  return (
    <WorkSourceCard
      icon={<Hash className="size-4" />}
      title="In your channels"
      action={
        <span className="flex flex-wrap gap-2">
          {slackBot ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditingBot(true)}
            >
              Edit Slack bot
            </Button>
          ) : (
            slackPerAgent && (
              <Button size="sm" variant="outline" asChild>
                <Link href={addBotHref}>Add Slack bot</Link>
              </Button>
            )
          )}
          {(listed.length > 0 || !slackPerAgent) && (
            <Button size="sm" variant="outline" asChild>
              <Link href={manageHref}>
                {listed.length ? "Manage channels" : "Add a channel"}
              </Link>
            </Button>
          )}
        </span>
      }
    >
      {bindings.isPending ? (
        <span>Loading channels…</span>
      ) : reachable ? (
        <span className="flex flex-col gap-2">
          <ul className="divide-y rounded-md border">
            {slackBot && slackHandle && (
              <li className="flex min-w-0 items-center gap-2 px-3 py-2 text-foreground">
                <ChannelIcon channel="slack" className="size-4" />
                <span className="truncate">
                  <span className="font-mono">@{slackHandle}</span>
                  {botChannelCount !== undefined && (
                    <span className="text-muted-foreground">
                      {" "}
                      ·{" "}
                      {botChannelCount === 1
                        ? "1 channel"
                        : `${botChannelCount} channels`}
                    </span>
                  )}
                </span>
              </li>
            )}
            {listed.slice(0, slackBot ? 2 : 3).map((binding) => (
              <li
                key={binding.id}
                className="flex min-w-0 items-center gap-2 px-3 py-2 text-foreground"
              >
                <ChannelIcon channel={binding.provider} className="size-4" />
                <span className="truncate">
                  {MESSAGING_CHANNEL_LABELS[binding.provider]} ·{" "}
                  {channelDisplayName(binding)}
                </span>
              </li>
            ))}
          </ul>
          {listed.length > (slackBot ? 2 : 3) && (
            <span>+{listed.length - (slackBot ? 2 : 3)} more</span>
          )}
          {slackBot && slackHandle ? (
            <span>
              People mention{" "}
              <span className="font-mono text-foreground">@{slackHandle}</span>{" "}
              in Slack; it answers in the thread.
            </span>
          ) : (
            <span>People mention it there; it answers in the thread.</span>
          )}
          {slackWithoutBot && <SlackWithoutBotNotice href={addBotHref} />}
        </span>
      ) : (
        <span className="flex flex-col gap-2">
          <span>
            {slackPerAgent
              ? hasRuntime
                ? "Not reachable from chat apps yet. Give it a Slack bot and people @mention it with tasks; it answers in the thread. Or add a Teams or Telegram channel."
                : "Not reachable from chat apps yet. Give it a Slack bot and people @mention it. Or add a Teams or Telegram channel."
              : hasRuntime
                ? `Not in any channel yet. Add a ${slackOffered ? "Slack, Teams or Telegram" : "Teams or Telegram"} channel and people can give it tasks there; it answers in the thread.`
                : `Not in any channel yet. Add a ${slackOffered ? "Slack, Teams or Telegram" : "Teams or Telegram"} channel and people can ask it there.`}
          </span>
          {slackWithoutBot && <SlackWithoutBotNotice href={addBotHref} />}
        </span>
      )}
      {slackBot && slackHandle && (
        <SlackBotEditDialog
          open={editingBot}
          onOpenChange={setEditingBot}
          agentId={agentId}
          handle={slackHandle}
          appId={slackBot.appId}
          installed={slackBot.installed}
          reinstallUrl={slackBot.reinstallUrl}
        />
      )}
    </WorkSourceCard>
  );
}

function SlackWithoutBotNotice({ href }: { href: string }) {
  return (
    <span className="text-amber-800 dark:text-amber-300">
      Some Slack channels are assigned to this agent, but no bot answers as it
      there.{" "}
      <Link href={href} className="font-medium underline underline-offset-2">
        Add its Slack bot
      </Link>
    </span>
  );
}

function WorkSourceCard({
  icon,
  title,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted"
        >
          {icon}
        </span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="text-sm text-muted-foreground">{children}</div>
      {action && <div className="mt-auto pt-1">{action}</div>}
    </div>
  );
}
