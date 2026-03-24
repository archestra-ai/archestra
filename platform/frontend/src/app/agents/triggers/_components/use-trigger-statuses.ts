import { useChatApiKeys } from "@/lib/chat/chat-settings.query";
import { useChatOpsStatus } from "@/lib/chatops/chatops.query";
import { useIncomingEmailStatus } from "@/lib/chatops/incoming-email.query";
import config from "@/lib/config/config";
import { useConfig } from "@/lib/config/config.query";

export function useTriggerStatuses() {
  const { data: chatOpsProviders, isLoading: chatOpsLoading } =
    useChatOpsStatus();
  const { data: configData, isLoading: featuresLoading } = useConfig();
  const { data: emailStatus, isLoading: emailLoading } =
    useIncomingEmailStatus();
  const { data: chatApiKeys = [], isLoading: apiKeysLoading } =
    useChatApiKeys();

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

  const triggers = [
    { active: msTeamsActive, href: "/agents/triggers/ms-teams" },
    { active: slackActive, href: "/agents/triggers/slack" },
    { active: emailActive, href: "/agents/triggers/email" },
  ] as const;
  const firstActiveHref =
    triggers.find((t) => t.active)?.href ?? triggers[0].href;

  return {
    msTeams: msTeamsActive,
    slack: slackActive,
    email: emailActive,
    firstActiveHref,
    isLoading:
      chatOpsLoading || featuresLoading || emailLoading || apiKeysLoading,
  };
}
