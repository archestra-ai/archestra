"use client";

import {
  MESSAGING_CHANNEL_LABELS,
  type MessagingChannelId,
} from "@archestra/shared";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChannelIcon } from "@/components/channel-icon";
import { useMessagingChannelCatalog } from "@/lib/integration-overrides";
import { cn } from "@/lib/utils";
import { useTriggerStatuses } from "./_components/use-trigger-statuses";

const CHAT_PROVIDER_IDS = [
  "ms-teams",
  "slack",
  "telegram",
  "email",
] as const satisfies readonly MessagingChannelId[];

export default function MessagingChannelSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const catalog = useMessagingChannelCatalog();
  const statuses = useTriggerStatuses();
  const tabs = CHAT_PROVIDER_IDS.filter(
    (id) =>
      !catalog.isHidden(id) &&
      (id !== "telegram" || statuses.telegramAvailable),
  ).map((id) => ({
    id,
    href: `/settings/messaging-channels/${id}`,
    active:
      id === "ms-teams"
        ? statuses.msTeams
        : id === "slack"
          ? statuses.slack
          : id === "telegram"
            ? statuses.telegram
            : statuses.email,
  }));

  if (tabs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        <div className="font-medium text-foreground">
          No messaging providers are available
        </div>
        <p className="mt-1">
          Enable a messaging channel under Settings → Agents to configure its
          provider.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <nav
        aria-label="Messaging providers"
        className="flex gap-4 overflow-x-auto border-b"
      >
        {tabs.map((tab) => {
          const selected = pathname === tab.href;
          return (
            <Link
              key={tab.id}
              href={tab.href}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "relative flex shrink-0 items-center gap-2 pb-3 text-sm font-medium transition-colors",
                selected
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <ChannelIcon channel={tab.id} className="size-4" />
              <span>{MESSAGING_CHANNEL_LABELS[tab.id]}</span>
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[11px] font-normal",
                  tab.active
                    ? "bg-green-500/10 text-green-600 dark:text-green-400"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {tab.active ? "Active" : "Configure"}
              </span>
              {selected && (
                <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
              )}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
