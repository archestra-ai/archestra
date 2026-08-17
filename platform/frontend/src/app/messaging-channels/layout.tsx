"use client";

import {
  MESSAGING_CHANNEL_LABELS,
  type MessagingChannelId,
} from "@archestra/shared";
import { Bot, Mail } from "lucide-react";
import { usePathname } from "next/navigation";
import { type ReactNode, useMemo } from "react";
import { IntegrationSettingsDialog } from "@/components/integration-settings-dialog";
import { PageLayout } from "@/components/page-layout";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useMessagingChannelCatalog } from "@/lib/integration-overrides";
import { cn } from "@/lib/utils";
import { useTriggerStatuses } from "./_components/use-trigger-statuses";

function TabLabel({
  iconSrc,
  icon: Icon,
  label,
  active,
}: {
  iconSrc?: string;
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      {iconSrc ? (
        <img src={iconSrc} alt="" className="h-4 w-4" />
      ) : Icon ? (
        <Icon className="h-4 w-4" />
      ) : null}
      {/* The span keeps the label an element: when the icon branch above
          changes (e.g. connection status loads), React inserts the new icon
          before this sibling — inserting before a bare text node crashes
          after Chrome page-translate re-parents it into a <font> wrapper
          (facebook/react#11538). */}
      <span>{label}</span>
      {active !== undefined && (
        <span
          className={cn(
            "text-[11px] px-1.5 py-0.5 rounded-full font-normal",
            active
              ? "bg-green-500/10 text-green-600 dark:text-green-400"
              : "bg-muted text-muted-foreground",
          )}
        >
          {active ? "Active" : "Configure"}
        </span>
      )}
    </span>
  );
}

/** Tab icons, kept next to the labels the admin can override. */
const CHANNEL_ICON_SRC = {
  "ms-teams": "/icons/ms-teams.png",
  slack: "/icons/slack.png",
  telegram: "/icons/telegram.png",
} as const;

const CHANNEL_ICONS: Record<MessagingChannelId, ReactNode> = {
  "ms-teams": (
    <img
      src={CHANNEL_ICON_SRC["ms-teams"]}
      alt=""
      className="h-[18px] w-[18px]"
    />
  ),
  slack: (
    <img src={CHANNEL_ICON_SRC.slack} alt="" className="h-[18px] w-[18px]" />
  ),
  telegram: (
    <img src={CHANNEL_ICON_SRC.telegram} alt="" className="h-[18px] w-[18px]" />
  ),
  email: <Mail className="h-[18px] w-[18px]" />,
  a2a: <Bot className="h-[18px] w-[18px]" />,
};

const CHANNEL_SETTINGS_ITEMS = (
  Object.keys(MESSAGING_CHANNEL_LABELS) as MessagingChannelId[]
).map((id) => ({
  id,
  label: MESSAGING_CHANNEL_LABELS[id],
  icon: CHANNEL_ICONS[id],
}));

export default function AgentTriggersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: canReadTriggers } = useHasPermissions({
    agentTrigger: ["read"],
  });
  const {
    msTeams: msTeamsActive,
    slack: slackActive,
    telegram: telegramActive,
    telegramAvailable,
    email: emailActive,
    a2a: a2aActive,
  } = useTriggerStatuses();
  const channelCatalog = useMessagingChannelCatalog();
  const pathname = usePathname();
  const currentChannel = (
    Object.keys(MESSAGING_CHANNEL_LABELS) as MessagingChannelId[]
  ).find((id) => pathname === `/messaging-channels/${id}`);

  const tabs = useMemo(() => {
    const channelTabs = [
      {
        id: "ms-teams" as const,
        label: (
          <TabLabel
            iconSrc={CHANNEL_ICON_SRC["ms-teams"]}
            label={channelCatalog.label("ms-teams")}
            active={msTeamsActive}
          />
        ),
        href: "/messaging-channels/ms-teams",
        active: msTeamsActive,
      },
      {
        id: "slack" as const,
        label: (
          <TabLabel
            iconSrc={CHANNEL_ICON_SRC.slack}
            label={channelCatalog.label("slack")}
            active={slackActive}
          />
        ),
        href: "/messaging-channels/slack",
        active: slackActive,
      },
      // Telegram is hidden unless the deployment enables the feature flag
      ...(telegramAvailable
        ? [
            {
              id: "telegram" as const,
              label: (
                <TabLabel
                  iconSrc={CHANNEL_ICON_SRC.telegram}
                  label={channelCatalog.label("telegram")}
                  active={telegramActive}
                />
              ),
              href: "/messaging-channels/telegram",
              active: telegramActive,
            },
          ]
        : []),
      {
        id: "email" as const,
        label: (
          <TabLabel
            icon={Mail}
            label={channelCatalog.label("email")}
            active={emailActive}
          />
        ),
        href: "/messaging-channels/email",
        active: emailActive,
      },
    ];

    // Sort channel tabs by active first, then pin A2A as the final option.
    return [
      ...channelTabs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0)),
      {
        id: "a2a" as const,
        label: (
          <TabLabel
            icon={Bot}
            label={channelCatalog.label("a2a")}
            active={a2aActive}
          />
        ),
        href: "/messaging-channels/a2a",
        active: a2aActive,
      },
      // Channels the admins turned off leave the page entirely — their routes
      // render a "turned off" notice, so a bookmark cannot walk back in.
    ].filter((tab) => !channelCatalog.isHidden(tab.id));
  }, [
    msTeamsActive,
    slackActive,
    telegramActive,
    telegramAvailable,
    emailActive,
    a2aActive,
    channelCatalog,
  ]);

  if (canReadTriggers === false) {
    return null;
  }

  return (
    <PageLayout
      title="Messaging Channels"
      description={`Manage how agents are invoked through ${describeChannels(
        // Catalog order, not tab order: the tabs re-sort as channels connect,
        // and a sentence that reshuffles itself reads like a bug.
        CHANNEL_SETTINGS_ITEMS.filter((item) =>
          tabs.some((tab) => tab.id === item.id),
        ).map((item) => channelCatalog.label(item.id)),
      )}`}
      tabs={tabs}
      actionButton={
        <IntegrationSettingsDialog
          field="messagingChannelOverrides"
          title="Messaging channel settings"
          description="Admin only — turn off the channels your organization does not allow, and rename the ones it does. A turned-off channel stops listening and disappears from this page."
          entityNamePlural="channels"
          items={CHANNEL_SETTINGS_ITEMS}
          overrides={channelCatalog.overrides}
          testId="messaging-channel-page-settings"
        />
      }
    >
      {currentChannel && channelCatalog.isHidden(currentChannel) ? (
        <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          <div className="font-medium text-foreground">
            {channelCatalog.label(currentChannel)} is turned off
          </div>
          <p className="mt-1">
            An administrator turned this channel off for your organization, so
            it cannot be configured or used.
          </p>
        </div>
      ) : (
        children
      )}
    </PageLayout>
  );
}

/** "Slack, Microsoft Teams and A2A" from the channels still on the page. */
function describeChannels(labels: string[]): string {
  if (labels.length === 0) return "no channels — every channel is turned off";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
