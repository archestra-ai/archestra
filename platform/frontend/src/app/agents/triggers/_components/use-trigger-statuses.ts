import { useInternalAgents } from "@/lib/agent.query";
import {
  useBundledChatOpsAdapters,
  useChatOpsStatus,
} from "@/lib/chatops/chatops.query";
import { useIncomingEmailStatus } from "@/lib/chatops/incoming-email.query";
import config from "@/lib/config/config";
import { useConfig } from "@/lib/config/config.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  buildBundledTriggerNavigation,
  getFirstTriggerHref,
} from "./bundled-trigger-navigation";

export function useTriggerStatuses() {
  const { data: chatOpsProviders, isLoading: chatOpsLoading } =
    useChatOpsStatus();
  const { data: bundledAdapters, isLoading: bundledLoading } =
    useBundledChatOpsAdapters();
  const { data: configData, isLoading: featuresLoading } = useConfig();
  const { data: emailStatus, isLoading: emailLoading } =
    useIncomingEmailStatus();
  const { data: chatApiKeys = [], isLoading: apiKeysLoading } =
    useLlmProviderApiKeys();
  const { data: internalAgents, isLoading: agentsLoading } = useInternalAgents({
    enabled: true,
  });

  const hasLlmKey = chatApiKeys.length > 0;
  const ngrokDomain = configData?.features.ngrokDomain;
  const isLocalDev =
    configData?.features.isQuickstart || config.environment === "development";

  const msTeams = chatOpsProviders?.find((p) => p.id === "ms-teams");
  const msTeamsActive = isLocalDev
    ? !!ngrokDomain && hasLlmKey && !!msTeams?.configured
    : hasLlmKey && !!msTeams?.configured;

  const slack = chatOpsProviders?.find((p) => p.id === "slack");
  const slackCreds = slack?.credentials as Record<string, string> | undefined;
  const isSlackSocket = (slackCreds?.connectionMode ?? "socket") === "socket";
  const slackActive = isSlackSocket
    ? hasLlmKey && !!slack?.configured
    : isLocalDev
      ? !!ngrokDomain && hasLlmKey && !!slack?.configured
      : hasLlmKey && !!slack?.configured;

  const emailActive =
    !!configData?.features.incomingEmail?.enabled && !!emailStatus?.isActive;

  // A2A surfaces existing agents over the A2A protocol — no provider config
  // step, so it's "active" whenever there's at least one agent to expose.
  const a2aActive = (internalAgents?.length ?? 0) > 0;

  const bundled = buildBundledTriggerNavigation(bundledAdapters);

  const fixedTriggers = [
    { active: msTeamsActive, href: "/agents/triggers/ms-teams" },
    { active: slackActive, href: "/agents/triggers/slack" },
    { active: emailActive, href: "/agents/triggers/email" },
    { active: a2aActive, href: "/agents/triggers/a2a" },
  ] as const;
  const firstActiveHref = getFirstTriggerHref(fixedTriggers, bundled);

  return {
    msTeams: msTeamsActive,
    slack: slackActive,
    email: emailActive,
    a2a: a2aActive,
    bundled,
    firstActiveHref,
    isLoading:
      chatOpsLoading ||
      bundledLoading ||
      featuresLoading ||
      emailLoading ||
      apiKeysLoading ||
      agentsLoading,
  };
}
