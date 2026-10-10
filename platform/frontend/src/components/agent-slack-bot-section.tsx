"use client";

import { slackHandleFor } from "@archestra/shared";
import { ArrowUpRight, Plus } from "lucide-react";
import Link from "next/link";
import { AgentIcon } from "@/components/agent-icon";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { useSlackAgentBots } from "@/lib/chatops/chatops-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils/tailwind";

const SLACK_SETTINGS_PATH = "/settings/messaging-channels/slack";

/**
 * The agent's own Slack bot, if it has one: people @mention it by name in any
 * channel it is invited to. Bots are managed on the Slack settings page; this
 * shows the agent's and links there. Hidden for people who cannot read
 * messaging settings.
 */
export function AgentSlackBotSection({
  agentId,
  agentName,
  agentIcon,
}: {
  agentId: string;
  agentName: string;
  agentIcon?: string | null;
}) {
  const { data, isError, isLoading } = useSlackAgentBots();
  if (isError || isLoading || !data) return null;
  return (
    <SlackBotSectionBody
      bot={data.bots.find((candidate) => candidate.agentId === agentId)}
      agentId={agentId}
      agentName={agentName}
      agentIcon={agentIcon}
    />
  );
}

type AgentBot = NonNullable<
  ReturnType<typeof useSlackAgentBots>["data"]
>["bots"][number];

function SlackBotSectionBody({
  bot,
  agentId,
  agentName,
  agentIcon,
}: {
  bot: AgentBot | undefined;
  agentId: string;
  agentName: string;
  agentIcon?: string | null;
}) {
  const appName = useAppName();
  const handle = bot?.handle ?? slackHandleFor(appName, agentName);

  return (
    <SettingsSection
      title="Slack bot"
      description="People @mention this agent by name, in any channel the bot is in."
    >
      {bot ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border px-4 py-3">
          <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
            <AgentIcon icon={agentIcon} size={24} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate font-mono text-sm font-medium">
              @{handle}
            </span>
            <BotStatusLine bot={bot} />
          </div>
          <Button size="sm" variant="outline" asChild>
            <Link href={SLACK_SETTINGS_PATH}>
              <span>Manage</span>
              <ArrowUpRight />
            </Link>
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed px-4 py-3">
          <p className="flex-1 text-sm text-muted-foreground">
            No Slack bot yet. With one, people type{" "}
            <span className="font-mono text-foreground">@{handle}</span> to
            reach this agent.
          </p>
          <Button size="sm" variant="outline" asChild>
            <Link
              href={`${SLACK_SETTINGS_PATH}?addBot=${encodeURIComponent(agentId)}`}
            >
              <Plus />
              <span>Add Slack bot</span>
            </Link>
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}

function BotStatusLine({
  bot,
}: {
  bot: NonNullable<
    ReturnType<typeof useSlackAgentBots>["data"]
  >["bots"][number];
}) {
  const status = !bot.installed
    ? { label: "Not installed", tone: "text-muted-foreground" }
    : bot.needsAppLevelToken || bot.reinstallUrl
      ? {
          label: bot.reinstallUrl ? "Needs reinstall" : "Needs app-level token",
          tone: "text-amber-800 dark:text-amber-300",
        }
      : bot.connected
        ? { label: "Connected", tone: "text-green-700 dark:text-green-400" }
        : { label: "Not connected", tone: "text-muted-foreground" };
  return <span className={cn("text-xs", status.tone)}>{status.label}</span>;
}
