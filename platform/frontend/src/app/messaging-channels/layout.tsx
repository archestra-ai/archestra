"use client";

import {
  MESSAGING_CHANNEL_LABELS,
  type MessagingChannelId,
} from "@archestra/shared";
import { Bot, Mail } from "lucide-react";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { PageLayout } from "@/components/page-layout";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useMessagingChannelCatalog } from "@/lib/integration-overrides";
import { cn } from "@/lib/utils";
import { CHANNEL_ICON_SRC, CHANNEL_OPTIONS } from "./_components/channel-icons";
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
            label={MESSAGING_CHANNEL_LABELS["ms-teams"]}
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
            label={MESSAGING_CHANNEL_LABELS.slack}
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
                  label={MESSAGING_CHANNEL_LABELS.telegram}
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
            label={MESSAGING_CHANNEL_LABELS.email}
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
            label={MESSAGING_CHANNEL_LABELS.a2a}
            active={a2aActive}
          />
        ),
        href: "/messaging-channels/a2a",
        active: a2aActive,
      },
      // Channels the role excludes leave the page entirely — their routes
      // render a "not available" notice, so a bookmark cannot walk back in.
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

  // No channel left for this role: no tabs to show, nowhere for the index
  // route to land, and no channel page worth rendering — so the page collapses
  // to one explanation instead of a header describing an empty list.
  const noChannels = tabs.length === 0;

  return (
    <PageLayout
      title="Messaging Channels"
      description={
        noChannels
          ? "Your role has no messaging channels."
          : `Manage how agents are invoked through ${describeChannels(
              // Catalog order, not tab order: the tabs re-sort as channels
              // connect, and a sentence that reshuffles itself reads like a bug.
              CHANNEL_OPTIONS.filter((item) =>
                tabs.some((tab) => tab.id === item.id),
              ).map((item) => MESSAGING_CHANNEL_LABELS[item.id]),
            )}`
      }
      tabs={tabs}
    >
      {noChannels ? (
        <ChannelsOffNotice
          title="No messaging channels are available"
          body="Your role does not include any messaging channel. Agents can still be reached through the API."
        />
      ) : currentChannel && channelCatalog.isHidden(currentChannel) ? (
        <ChannelsOffNotice
          title={`${MESSAGING_CHANNEL_LABELS[currentChannel]} is not available to your role`}
          body="An administrator did not include this channel in your role, so it cannot be configured or used."
        />
      ) : (
        children
      )}
    </PageLayout>
  );
}

function ChannelsOffNotice({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
      <div className="font-medium text-foreground">{title}</div>
      <p className="mt-1">{body}</p>
    </div>
  );
}

/** "Slack, Microsoft Teams and A2A" from the channels still on the page. */
function describeChannels(labels: string[]): string {
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
