import { useChatOpsStatus } from "@/lib/chatops/chatops.query";
import { useIncomingEmailStatus } from "@/lib/chatops/incoming-email.query";
import config from "@/lib/config/config";
import { useConfig } from "@/lib/config/config.query";
import { useMessagingChannelCatalog } from "@/lib/integration-overrides";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useReachabilityMode } from "./use-reachability-mode";

export function useTriggerStatuses() {
  const { data: chatOpsProviders, isLoading: chatOpsLoading } =
    useChatOpsStatus();
  const { data: configData, isLoading: featuresLoading } = useConfig();
  const { data: emailStatus, isLoading: emailLoading } =
    useIncomingEmailStatus();
  const { data: chatApiKeys = [], isLoading: apiKeysLoading } =
    useLlmProviderApiKeys();
  const channelCatalog = useMessagingChannelCatalog();

  const hasLlmKey = chatApiKeys.length > 0;
  const [reachabilityMode] = useReachabilityMode();
  // "manual" means the user exposes the instance themselves — trust them.
  const reachable =
    reachabilityMode === "manual" || !!configData?.features.ngrokDomain;
  const isLocalDev =
    configData?.features.isQuickstart || config.environment === "development";

  const msTeams = chatOpsProviders?.find((p) => p.id === "ms-teams");
  const msTeamsActive = isLocalDev
    ? reachable && hasLlmKey && !!msTeams?.configured
    : hasLlmKey && !!msTeams?.configured;

  const slack = chatOpsProviders?.find((p) => p.id === "slack");
  const slackCreds = slack?.credentials as Record<string, string> | undefined;
  const isSlackSocket = (slackCreds?.connectionMode ?? "socket") === "socket";
  const slackActive = isSlackSocket
    ? hasLlmKey && !!slack?.configured
    : isLocalDev
      ? reachable && hasLlmKey && !!slack?.configured
      : hasLlmKey && !!slack?.configured;

  // Telegram is on by default; ARCHESTRA_CHATOPS_TELEGRAM_ENABLED=false is
  // the operator opt-out that hides the channel entirely. It uses long
  // polling — no public URL needed, so no reachability gate.
  const telegramAvailable = !!configData?.features.chatopsTelegramEnabled;
  const telegram = chatOpsProviders?.find((p) => p.id === "telegram");
  const telegramActive =
    telegramAvailable && hasLlmKey && !!telegram?.configured;

  const emailActive =
    !!configData?.features.incomingEmail?.enabled && !!emailStatus?.isActive;

  // Landing candidates are the providers that actually have a tab. A provider
  // that admins turned off, or that this deployment never enabled, must not be
  // selected as the Settings landing page.
  const providerTriggers = (
    [
      { id: "ms-teams", active: msTeamsActive, available: true },
      { id: "slack", active: slackActive, available: true },
      { id: "telegram", active: telegramActive, available: telegramAvailable },
      { id: "email", active: emailActive, available: true },
    ] as const
  )
    .filter(({ id, available }) => available && !channelCatalog.isHidden(id))
    .map(({ id, active }) => ({
      id,
      active,
      href: `/settings/messaging-channels/${id}`,
    }));
  const firstProviderHref =
    providerTriggers.find((trigger) => trigger.active)?.href ??
    providerTriggers[0]?.href ??
    null;

  return {
    msTeams: msTeamsActive,
    slack: slackActive,
    telegram: telegramActive,
    telegramAvailable,
    email: emailActive,
    firstProviderHref,
    isLoading:
      chatOpsLoading || featuresLoading || emailLoading || apiKeysLoading,
  };
}
