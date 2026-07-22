import type React from "react";

export type ChatOpsProvider = "slack" | "ms-teams" | "telegram";

export interface ProviderConfig {
  provider: ChatOpsProvider;
  providerLabel: string;
  providerIcon: string;
  /** Absent for providers with no inbound webhook (e.g. Telegram, which is polled). */
  webhookPath?: string;
  /**
   * Hide the placeholder DM row shown before a DM binding exists. Telegram
   * turns it off — its DM binding is created by the account-linking flow,
   * not by assigning an agent first.
   */
  showVirtualDmRow?: boolean;
  docsUrl: string | null;
  slashCommand: string;
  /**
   * Overrides the default "when do channels appear here" line above the
   * channels table. Telegram uses it: groups appear the moment the bot is
   * added (my_chat_member updates), not after the first interaction — plus
   * the Group Privacy steps needed for the bot to hear group conversation.
   */
  channelsAppearNote?: React.ReactNode;
  /** Web link to open a channel, or null when the provider has none (e.g. Telegram groups). */
  buildDeepLink: (binding: {
    channelId: string;
    channelName?: string | null;
    workspaceId?: string | null;
  }) => string | null;
  getDmDeepLink?: (
    providerStatus: {
      dmInfo?: {
        botUserId?: string;
        teamId?: string;
        appId?: string;
        botUsername?: string;
      } | null;
    },
    /**
     * The DM binding row, when one exists. Telegram uses it to build the
     * account-linking deep link (t.me/<bot>?start=<bindingId>) for pending
     * bindings; Slack/Teams ignore it.
     */
    binding?: { id: string; channelId: string },
  ) => string | null;
}
