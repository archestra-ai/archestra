"use client";
import { Info } from "lucide-react";
import { useState } from "react";
import Divider from "@/components/divider";
import { MsTeamsSetupDialog } from "@/components/ms-teams-setup-dialog";
import { NgrokSetupDialog } from "@/components/ngrok-setup-dialog";
import { useChatOpsStatus } from "@/lib/chatops/chatops.query";
import config from "@/lib/config/config";
import { useConfig, usePublicBaseUrl } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { ChannelsSection } from "../_components/channels-section";
import { CollapsibleSetupSection } from "../_components/collapsible-setup-section";
import { CredentialField } from "../_components/credential-field";
import { LlmKeySetupStep } from "../_components/llm-key-setup-step";
import { NgrokStatus } from "../_components/ngrok-status";
import { SetupStep } from "../_components/setup-step";
import type { ProviderConfig } from "../_components/types";
import { useTriggerStatuses } from "../_components/use-trigger-statuses";

const msTeamsProviderConfig: ProviderConfig = {
  provider: "ms-teams",
  providerLabel: "MS Teams",
  providerIcon: "/icons/ms-teams.png",
  webhookPath: "/api/webhooks/chatops/ms-teams",
  docsUrl: getFrontendDocsUrl("platform-ms-teams"),
  slashCommand: "/select-agent",
  buildDeepLink: (binding) => {
    const channelName = encodeURIComponent(
      binding.channelName ?? binding.channelId,
    );
    const base = `https://teams.microsoft.com/l/channel/${encodeURIComponent(binding.channelId)}/${channelName}`;
    if (binding.workspaceId) {
      return `${base}?groupId=${encodeURIComponent(binding.workspaceId)}`;
    }
    return base;
  },
  getDmDeepLink: (providerStatus) => {
    const appId = providerStatus.dmInfo?.appId;
    if (!appId) return null;
    return `https://teams.microsoft.com/l/chat/0/0?users=28:${appId}`;
  },
};

export default function MsTeamsPage() {
  const configuredAppName = useAppName();
  const publicBaseUrl = usePublicBaseUrl();
  const [msTeamsSetupOpen, setMsTeamsSetupOpen] = useState(false);
  const [ngrokDialogOpen, setNgrokDialogOpen] = useState(false);

  const { data: configData, isLoading: featuresLoading } = useConfig();
  const { data: chatOpsProviders, isLoading: statusLoading } =
    useChatOpsStatus();

  const ngrokDomain = configData?.features.ngrokDomain;
  const msTeams = chatOpsProviders?.find((p) => p.id === "ms-teams");

  const setupDataLoading = featuresLoading || statusLoading;
  const isLocalDev =
    configData?.features.isQuickstart || config.environment === "development";
  const { msTeams: allStepsCompleted } = useTriggerStatuses();

  return (
    <div className="flex flex-col gap-4">
      <CollapsibleSetupSection
        allStepsCompleted={allStepsCompleted}
        isLoading={setupDataLoading}
        providerLabel="Microsoft Teams"
        docsUrl={getFrontendDocsUrl("platform-ms-teams")}
      >
        {isLocalDev ? (
          <SetupStep
            title={`Make ${configuredAppName} reachable from the Internet`}
            description={`The MS Teams bot needs to connect to an ${configuredAppName} webhook — your instance must be publicly accessible`}
            done={!!ngrokDomain}
            ctaLabel="Configure ngrok"
            onAction={() => setNgrokDialogOpen(true)}
          >
            {ngrokDomain ? (
              <NgrokStatus domain={ngrokDomain} />
            ) : (
              <>
                Expose {configuredAppName} at a public URL, or configure ngrok
                to create a tunnel.
              </>
            )}
          </SetupStep>
        ) : (
          <div className="flex items-start gap-3 rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-3">
            <Info className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
            <div className="flex flex-col gap-1">
              <span className="font-medium text-sm">
                {configuredAppName}'s webhook must be reachable from the
                Internet
              </span>
              <span className="text-muted-foreground text-xs">
                The webhook endpoint{" "}
                <code className="bg-muted px-1 py-0.5 rounded text-xs">
                  POST {`${publicBaseUrl}/api/webhooks/chatops/ms-teams`}
                </code>{" "}
                must be publicly accessible so MS Teams can deliver messages to
                {configuredAppName}
              </span>
            </div>
          </div>
        )}
        <LlmKeySetupStep />
        <SetupStep
          title="Setup MS Teams"
          description={`Register a Teams bot application and connect it to ${configuredAppName}`}
          done={!!msTeams?.configured}
          ctaLabel="Setup MS Teams"
          onAction={() => setMsTeamsSetupOpen(true)}
          doneActionLabel="Reconfigure"
          onDoneAction={() => setMsTeamsSetupOpen(true)}
        >
          <div className="flex items-center flex-wrap gap-4">
            <CredentialField
              label="App ID"
              value={msTeams?.credentials?.appId}
            />
            <CredentialField
              label="App Secret"
              value={msTeams?.credentials?.appSecret}
            />
            <CredentialField
              label="Tenant ID"
              value={msTeams?.credentials?.tenantId}
              optional
            />
          </div>
        </SetupStep>
      </CollapsibleSetupSection>

      {allStepsCompleted && (
        <>
          <Divider />
          <ChannelsSection providerConfig={msTeamsProviderConfig} />
        </>
      )}

      <MsTeamsSetupDialog
        open={msTeamsSetupOpen}
        onOpenChange={setMsTeamsSetupOpen}
      />
      <NgrokSetupDialog
        open={ngrokDialogOpen}
        onOpenChange={setNgrokDialogOpen}
      />
    </div>
  );
}
