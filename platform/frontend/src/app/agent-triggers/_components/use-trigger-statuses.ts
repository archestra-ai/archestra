import { useChatOpsStatus } from "@/lib/chatops.query";
import config from "@/lib/config";
import { useFeatures } from "@/lib/config.query";
import { useIncomingEmailStatus } from "@/lib/incoming-email.query";

export function useTriggerStatuses() {
  const { data: chatOpsProviders, isLoading: chatOpsLoading } =
    useChatOpsStatus();
  const { data: features, isLoading: featuresLoading } = useFeatures();
  const { data: emailStatus, isLoading: emailLoading } =
    useIncomingEmailStatus();

  const ngrokDomain = features?.ngrokDomain;
  const isLocalDev =
    features?.isQuickstart || config.environment === "development";

  const msTeams = chatOpsProviders?.find((p) => p.id === "ms-teams");
  const msTeamsActive = isLocalDev
    ? !!ngrokDomain && !!msTeams?.configured
    : !!msTeams?.configured;

  const slack = chatOpsProviders?.find((p) => p.id === "slack");
  const slackCreds = slack?.credentials as Record<string, string> | undefined;
  const isSlackSocket = (slackCreds?.connectionMode ?? "socket") === "socket";
  const slackActive = isSlackSocket
    ? !!slack?.configured
    : isLocalDev
      ? !!ngrokDomain && !!slack?.configured
      : !!slack?.configured;

  const emailActive =
    !!features?.incomingEmail?.enabled && !!emailStatus?.isActive;

  return {
    msTeams: msTeamsActive,
    slack: slackActive,
    email: emailActive,
    isLoading: chatOpsLoading || featuresLoading || emailLoading,
  };
}
