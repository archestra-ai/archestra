import { useInternalAgents } from "@/lib/agent.query";
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
  const { data: internalAgents, isLoading: agentsLoading } = useInternalAgents({
    enabled: true,
  });

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

  // A2A surfaces existing agents over the A2A protocol — no provider config
  // step, so it's "active" whenever there's at least one agent to expose.
  const a2aActive = (internalAgents?.length ?? 0) > 0;

  // Landing candidates are the channels that actually have a tab: one the
  // admins turned off, or that this deployment never enabled, would otherwise
  // be a redirect straight onto a dead page.
  const triggers = (
    [
      { id: "ms-teams", active: msTeamsActive, available: true },
      { id: "slack", active: slackActive, available: true },
      { id: "telegram", active: telegramActive, available: telegramAvailable },
      { id: "email", active: emailActive, available: true },
      { id: "a2a", active: a2aActive, available: true },
    ] as const
  )
    .filter(({ id, available }) => available && !channelCatalog.isHidden(id))
    .map(({ id, active }) => ({
      active,
      href: `/messaging-channels/${id}`,
    }));
  // Null when every channel is off — there is nowhere to send anyone, so the
  // index route stays put and renders the empty state instead.
  const firstActiveHref =
    triggers.find((t) => t.active)?.href ?? triggers[0]?.href ?? null;

  return {
    msTeams: msTeamsActive,
    slack: slackActive,
    telegram: telegramActive,
    telegramAvailable,
    email: emailActive,
    a2a: a2aActive,
    firstActiveHref,
    isLoading:
      chatOpsLoading ||
      featuresLoading ||
      emailLoading ||
      apiKeysLoading ||
      agentsLoading,
  };
}
