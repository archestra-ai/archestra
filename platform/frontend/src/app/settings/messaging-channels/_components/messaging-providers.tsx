"use client";

import {
  MESSAGING_CHANNEL_LABELS,
  type MessagingChannelId,
} from "@archestra/shared";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChannelIcon } from "@/components/channel-icon";
import { SectionSubnavLink } from "@/components/section-nav";
import { useMessagingChannelCatalog } from "@/lib/integration-overrides";
import { cn } from "@/lib/utils/tailwind";
import { useTriggerStatuses } from "./use-trigger-statuses";

/** The providers this deployment offers, each with its page and whether it works. */
export function useMessagingProviders() {
  const catalog = useMessagingChannelCatalog();
  const statuses = useTriggerStatuses();
  return CHAT_PROVIDER_IDS.filter(
    (id) =>
      !catalog.isHidden(id) &&
      (id !== "telegram" || statuses.telegramAvailable),
  ).map((id) => ({
    id,
    label: MESSAGING_CHANNEL_LABELS[id],
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
}

/** The providers listed under Messaging Channels in the settings sidebar. */
export function MessagingProvidersSubnav() {
  const pathname = usePathname();
  const providers = useMessagingProviders();
  return (
    <div className="flex flex-col gap-0.5 pb-1">
      {providers.map((provider) => (
        <SectionSubnavLink
          key={provider.id}
          href={provider.href}
          active={pathname === provider.href}
          icon={<ChannelIcon channel={provider.id} className="size-4" />}
          label={provider.label}
          status={
            provider.active
              ? { label: "Active", ok: true }
              : { label: "Not set up", ok: false }
          }
        />
      ))}
    </div>
  );
}

/**
 * The same providers as a row, for widths where the settings sidebar is a
 * scrolling strip without room for its subnav.
 */
export function MessagingProvidersRow() {
  const pathname = usePathname();
  const providers = useMessagingProviders();
  return (
    <nav
      aria-label="Messaging providers"
      className="flex gap-2 overflow-x-auto lg:hidden"
    >
      {providers.map((provider) => (
        <Link
          key={provider.id}
          href={provider.href}
          aria-current={pathname === provider.href ? "page" : undefined}
          className={cn(
            "flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-sm",
            pathname === provider.href
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground",
          )}
        >
          <ChannelIcon channel={provider.id} className="size-4" />
          {provider.label}
        </Link>
      ))}
    </nav>
  );
}

const CHAT_PROVIDER_IDS = [
  "ms-teams",
  "slack",
  "telegram",
  "email",
] as const satisfies readonly MessagingChannelId[];
