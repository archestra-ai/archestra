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
import { useSettingsAreaAccess } from "@/app/_parts/use-settings-area-access";
import { channelDisplayName } from "@/app/settings/messaging-channels/_components/channel-details-dialog";
import { ChannelIcon } from "@/components/channel-icon";
import { SettingsLink } from "@/components/settings-link";
import { SlackBotEditDialog } from "@/components/slack-bot-edit-dialog";
import { Button } from "@/components/ui/button";
import { useAgentRuntimePreflight } from "@/lib/agent-runtime.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useAllChatOpsBindings,
  useChatOpsStatus,
} from "@/lib/chatops/chatops.query";
import {
  useSlackAgentBotChannels,
  useSlackAgentBots,
} from "@/lib/chatops/chatops-config.query";
import { useConfig } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useMessagingChannelCatalog } from "@/lib/integration-overrides";
import { agentEditHref } from "./agent-page-config";

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
  onShowA2a,
}: {
  agentId: string;
  hasRuntime: boolean;
  /** Whether a dedicated runtime can be set up on this deployment. */
  runtimeAvailable: boolean;
  chatHref: string | null;
  /** Opens the A2A connection details; unset when the reader may not see them. */
  onShowA2a?: () => void;
}) {
  const appName = useAppName();
  const { data: canReadChannels } = useHasPermissions({
    organizationSettings: ["read"],
  });
  // The setup section above says what is missing. Every route here still
  // works before then (setting up a channel or a laptop is preparation, and
  // chat explains what is missing), so they stay at full strength and only
  // the caption says runs wait.
  const preflight = useAgentRuntimePreflight(agentId, hasRuntime);
  const awaitingSetup = hasRuntime && preflight.data?.ready === false;
  return (
    <div className="space-y-4">
      <section aria-labelledby="agent-work-sources" className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="agent-work-sources" className="text-base font-semibold">
            {hasRuntime ? "Give it work" : "Where people use it"}
          </h2>
          {awaitingSetup && (
            <span className="text-[13px] text-muted-foreground">
              Runs start once setup above is done.
            </span>
          )}
        </div>
        {/* The ways that are a click away are equal cards; handoff needs a
            one-time setup and a sample to explain it, so it gets a strip of
            its own rather than stretching one card beside half-empty ones. */}
        <div className="grid gap-4 md:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
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
              ? "Chat with it and watch the live terminal while it works."
              : "Answers in seconds. Tool calls, approvals and files show right in the conversation."}
          </WorkSourceCard>
          {canReadChannels && (
            <AgentChannelsCard agentId={agentId} hasRuntime={hasRuntime} />
          )}
          {onShowA2a && (
            <WorkSourceCard
              icon={<Share2 className="size-4" />}
              title="From other agents"
              action={
                <Button size="sm" variant="outline" onClick={onShowA2a}>
                  Show A2A details
                </Button>
              }
            >
              Subagents and outside apps send it tasks over A2A.
            </WorkSourceCard>
          )}
        </div>
        {hasRuntime && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-4 rounded-xl border bg-card p-5">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted"
            >
              <Monitor className="size-4" />
            </span>
            <div className="min-w-0 flex-[1_1_18rem] space-y-1">
              <h3 className="text-sm font-semibold">From your laptop</h3>
              <p className="text-sm text-muted-foreground">
                {`Add the ${appName} MCP gateway to Claude Code or Codex once. Your changes, files and credentials move into a run here; "bring it back" returns a patch.`}
              </p>
            </div>
            <span
              role="img"
              aria-label={`Example: hand this over to ${appName}`}
              className="flex min-w-0 flex-[0_1_20rem] flex-col rounded-[10px] bg-[#16130F] px-3.5 py-3 font-mono text-xs leading-[1.7] text-[#D9D4CE]"
            >
              <span>&gt; hand this over to {appName}</span>
              <span className="text-[#9CC59F]">
                ✓ Run started on this agent
              </span>
            </span>
            <Button size="sm" variant="outline" asChild>
              <Link href="/connection">Connect your local agent</Link>
            </Button>
          </div>
        )}
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
            <Link href={agentEditHref(agentId)}>Set up managed agent</Link>
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
  const providerStatus = useChatOpsStatus();
  const { data: config } = useConfig();
  // The chat apps this deployment offers, and of those the ones the
  // organization has connected: the card offers only what can work.
  const offeredApps = CHAT_APPS.filter(
    (provider) =>
      !catalog.isHidden(provider) &&
      (provider !== "telegram" ||
        config?.features.chatopsTelegramEnabled === true),
  );
  const connectedApps = offeredApps.filter((provider) =>
    providerStatus.data?.some(
      (status) => status.id === provider && status.configured,
    ),
  );
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
  // Only a bot Archestra named follows the default handle; guessing one for
  // a converted app shows a name nobody can @mention.
  const slackHandle = slackBot
    ? (slackBot.handle ??
      (slackBot.createdByArchestra
        ? slackHandleFor(appName, slackBot.agentName)
        : null))
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
  // Every input that picks the buttons, so they appear once, not one by one
  // ("Add Slack channel" turning into "Add Slack bot").
  const loading =
    bindings.isPending ||
    providerStatus.isPending ||
    (slackOffered && slackBots.isPending);
  const manageHref = agentEditHref(agentId, "messaging");
  const addBotHref = `/settings/messaging-channels/slack?addBot=${encodeURIComponent(agentId)}`;
  const reachable = listed.length > 0 || !!slackBot;

  return (
    <WorkSourceCard
      icon={<Hash className="size-4" />}
      title="In your channels"
      action={
        <span className="flex flex-wrap gap-2">
          {loading ? null : !reachable ? (
            <EmptyChannelActions
              connectedApps={connectedApps}
              slackPerAgent={slackPerAgent}
              addBotHref={addBotHref}
              manageHref={manageHref}
            />
          ) : slackBot ? (
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
          {!loading && reachable && (listed.length > 0 || !slackPerAgent) && (
            <Button size="sm" variant="outline" asChild>
              <Link href={manageHref}>
                {listed.length ? "Manage channels" : "Add a channel"}
              </Link>
            </Button>
          )}
        </span>
      }
    >
      {loading ? (
        <span>Loading channels…</span>
      ) : reachable ? (
        <span className="flex flex-col gap-1.5">
          <span className="flex flex-wrap items-center gap-1.5">
            {slackBot && slackHandle && (
              <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                <ChannelIcon channel="slack" className="size-3.5" />
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
              </span>
            )}
            {listed.slice(0, slackBot ? 2 : 3).map((binding) => (
              <span
                key={binding.id}
                className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground"
              >
                <ChannelIcon channel={binding.provider} className="size-3.5" />
                <span className="truncate">
                  {MESSAGING_CHANNEL_LABELS[binding.provider]} ·{" "}
                  {channelDisplayName(binding)}
                </span>
              </span>
            ))}
            {listed.length > (slackBot ? 2 : 3) && (
              <span className="text-xs">
                +{listed.length - (slackBot ? 2 : 3)} more
              </span>
            )}
          </span>
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
            {connectedApps.length > 0
              ? `Not reachable from chat apps yet. Add it to ${listAppNames(connectedApps, "or")} and people can @mention it ${hasRuntime ? "with tasks" : "there"}; it answers in the thread.`
              : `Not reachable from chat apps yet. Once ${listAppNames(offeredApps, "or")} is connected, people can @mention it there.`}
          </span>
          {slackWithoutBot && <SlackWithoutBotNotice href={addBotHref} />}
        </span>
      )}
      {slackBot && (
        <SlackBotEditDialog
          open={editingBot}
          onOpenChange={setEditingBot}
          agentId={agentId}
          handle={slackHandle ?? slackBot.agentName}
          appId={slackBot.appId}
          installed={slackBot.installed}
          reinstallUrl={slackBot.reinstallUrl}
        />
      )}
    </WorkSourceCard>
  );
}

const CHAT_APPS = [
  "slack",
  "ms-teams",
  "telegram",
] as const satisfies readonly (keyof typeof MESSAGING_CHANNEL_LABELS)[];
type ChatApp = (typeof CHAT_APPS)[number];

/**
 * One way in per connected chat app. A per-agent Slack bot is set up on the
 * Slack settings page; channels in the other apps are assigned on the agent's
 * Messaging tab. With none connected, the way in is connecting one.
 */
function EmptyChannelActions({
  connectedApps,
  slackPerAgent,
  addBotHref,
  manageHref,
}: {
  connectedApps: ChatApp[];
  slackPerAgent: boolean;
  addBotHref: string;
  manageHref: string;
}) {
  // Chat apps and Slack bots are set up in Settings, which not everyone sees.
  const canSeeSettings = useSettingsAreaAccess() === true;
  if (connectedApps.length === 0) {
    if (!canSeeSettings) return null;
    return (
      <Button size="sm" variant="outline" asChild>
        <Link href="/settings/messaging-channels">Set up a chat app</Link>
      </Button>
    );
  }
  return (
    <>
      {connectedApps
        .filter(
          (provider) =>
            canSeeSettings || !(provider === "slack" && slackPerAgent),
        )
        .map((provider) => (
          <Button key={provider} size="sm" variant="outline" asChild>
            <Link
              href={
                provider === "slack" && slackPerAgent ? addBotHref : manageHref
              }
            >
              <ChannelIcon channel={provider} className="size-4" />
              {provider === "slack" && slackPerAgent
                ? "Add Slack bot"
                : `Add ${MESSAGING_CHANNEL_LABELS[provider]} channel`}
            </Link>
          </Button>
        ))}
    </>
  );
}

function listAppNames(apps: ChatApp[], conjunction: string): string {
  const names = apps.map((provider) => MESSAGING_CHANNEL_LABELS[provider]);
  if (names.length <= 1) return names[0] ?? "a chat app";
  return `${names.slice(0, -1).join(", ")} ${conjunction} ${names.at(-1)}`;
}

function SlackWithoutBotNotice({ href }: { href: string }) {
  return (
    <span className="text-amber-800 dark:text-amber-300">
      Some Slack channels are assigned to this agent, but no bot answers as it
      there.{" "}
      <SettingsLink
        href={href}
        className="font-medium underline underline-offset-2"
      >
        Add its Slack bot
      </SettingsLink>
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
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-5">
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
      {action && <div className="mt-auto pt-2">{action}</div>}
    </div>
  );
}
