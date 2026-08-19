import type { MessagingChannelId } from "@archestra/shared";
import { Bot, Mail } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Icon for a messaging channel. Shared by the Messaging Channels tabs and the
 * availability control on Agent settings, so a channel looks the same wherever
 * it is offered.
 */
export function ChannelIcon({
  channel,
  className,
}: {
  channel: MessagingChannelId;
  className?: string;
}) {
  const size = cn("h-[18px] w-[18px]", className);
  const src = CHANNEL_ICON_SRC[channel];
  if (src) {
    return <img src={src} alt="" className={size} />;
  }
  return channel === "email" ? (
    <Mail className={size} />
  ) : (
    <Bot className={size} />
  );
}

export const CHANNEL_ICON_SRC: Partial<Record<MessagingChannelId, string>> = {
  "ms-teams": "/icons/ms-teams.png",
  slack: "/icons/slack.png",
  telegram: "/icons/telegram.png",
};
