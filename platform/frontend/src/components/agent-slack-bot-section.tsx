"use client";

import { slackHandleFor } from "@archestra/shared";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import { SettingsSection } from "@/components/settings-section";
import { SlackBotEditDialog } from "@/components/slack-bot-edit-dialog";
import { Button } from "@/components/ui/button";
import { useAllChatOpsBindings } from "@/lib/chatops/chatops.query";
import { useSlackAgentBots } from "@/lib/chatops/chatops-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils/tailwind";

const SLACK_SETTINGS_PATH = "/settings/messaging-channels/slack";

/**
 * The agent's own Slack bot. In Slack every agent answers through its own
 * bot, so its Slack channels are edited with the bot (see SlackBotEditDialog).
 * Hidden for people who cannot read messaging settings.
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
  // Quiet: someone who cannot read messaging settings just sees no section.
  const { data, isError, isLoading } = useSlackAgentBots({ quiet: true });
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

// =============================================================================
// Internal Components
// =============================================================================

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
  const [editing, setEditing] = useState(false);
  const handle = bot?.handle ?? slackHandleFor(appName, agentName);
  const bindings = useAllChatOpsBindings();
  // Slack channels assigned to this agent: from before per-agent bots, or
  // claimed by its bot.
  const ownedChannels = (bindings.data?.bindings ?? []).filter(
    (binding) =>
      binding.provider === "slack" &&
      !binding.isDm &&
      binding.agentId === agentId,
  );

  return (
    <SettingsSection
      title="Slack"
      description="People @mention this agent's bot in any channel it is in."
    >
      {bot ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3 rounded-md border px-4 py-3">
            <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
              <AgentIcon icon={agentIcon} size={24} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-mono text-sm font-medium">
                @{handle}
              </span>
              <span className="text-xs">
                <BotStatusLine bot={bot} />
                {ownedChannels.length > 0 && (
                  <span className="text-muted-foreground">
                    {" "}
                    ·{" "}
                    {ownedChannels.length === 1
                      ? "1 channel"
                      : `${ownedChannels.length} channels`}
                  </span>
                )}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          </div>
          <SlackBotEditDialog
            open={editing}
            onOpenChange={setEditing}
            agentId={agentId}
            handle={handle}
            appId={bot.appId}
            installed={bot.installed}
            reinstallUrl={bot.reinstallUrl}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed px-4 py-3">
          <p className="flex-1 text-sm text-muted-foreground">
            {ownedChannels.length > 0 ? (
              <span>
                {ownedChannels.length}{" "}
                {ownedChannels.length === 1
                  ? "Slack channel is"
                  : "Slack channels are"}{" "}
                assigned to this agent, but no bot answers as it there. Add its
                bot, then add the bot to them.
              </span>
            ) : (
              <span>
                No Slack bot yet. With one, people type{" "}
                <span className="font-mono text-foreground">@{handle}</span> to
                reach this agent.
              </span>
            )}
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

function BotStatusLine({ bot }: { bot: AgentBot }) {
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
