import {
  MESSAGING_CHANNEL_LABELS,
  type MessagingChannelId,
} from "@archestra/shared";
import { Bot, Mail } from "lucide-react";
import type { ReactNode } from "react";

export const CHANNEL_ICON_SRC = {
  "ms-teams": "/icons/ms-teams.png",
  slack: "/icons/slack.png",
  telegram: "/icons/telegram.png",
} as const;

export const CHANNEL_ICONS: Record<MessagingChannelId, ReactNode> = {
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

/** The channel catalog as pickable options, in the order the tabs use. */
export const CHANNEL_OPTIONS = (
  Object.keys(MESSAGING_CHANNEL_LABELS) as MessagingChannelId[]
).map((id) => ({
  id,
  label: MESSAGING_CHANNEL_LABELS[id],
  icon: CHANNEL_ICONS[id],
}));
