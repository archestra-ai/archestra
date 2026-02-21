export type ChatOpsProvider = "slack" | "ms-teams";

export interface ProviderConfig {
  provider: ChatOpsProvider;
  providerLabel: string;
  providerIcon: string;
  webhookPath: string;
  docsUrl: string;
  slashCommand: string;
  buildDeepLink: (binding: {
    channelId: string;
    channelName?: string | null;
    workspaceId?: string | null;
  }) => string;
  getDmDeepLink?: (
    providerStatus: {
      dmInfo?: {
        botUserId?: string;
        teamId?: string;
        appId?: string;
      } | null;
    },
    agentId: string,
  ) => string | null;
}
