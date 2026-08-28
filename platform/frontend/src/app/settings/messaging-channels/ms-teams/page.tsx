"use client";

import { MESSAGING_CHANNEL_LABELS } from "@archestra/shared";
import { Globe, Info, Waypoints } from "lucide-react";
import { useState } from "react";
import { MsTeamsSetupDialog } from "@/components/ms-teams-setup-dialog";
import { NgrokSetupDialog } from "@/components/ngrok-setup-dialog";
import { useChatOpsStatus } from "@/lib/chatops/chatops.query";
import config from "@/lib/config/config";
import { useConfig, usePublicBaseUrl } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { CredentialField } from "../_components/credential-field";
import { LlmKeySetupStep } from "../_components/llm-key-setup-step";
import { ModeTile } from "../_components/mode-tile";
import { NgrokStatus } from "../_components/ngrok-status";
import { SetupSection } from "../_components/setup-section";
import { SetupStep } from "../_components/setup-step";
import { useReachabilityMode } from "../_components/use-reachability-mode";
import { useTriggerStatuses } from "../_components/use-trigger-statuses";

export default function MsTeamsPage() {
  const configuredAppName = useAppName();
  const publicBaseUrl = usePublicBaseUrl();
  // The "I will expose myself" tile must show the instance's own origin, not
  // the ngrok tunnel URL that usePublicBaseUrl prefers when a tunnel is up.
  const manualWebhookBaseUrl = usePublicBaseUrl({ ignoreNgrok: true });
  const [msTeamsSetupOpen, setMsTeamsSetupOpen] = useState(false);
  const [ngrokDialogOpen, setNgrokDialogOpen] = useState(false);

  const { data: configData, isLoading: featuresLoading } = useConfig();
  const { data: chatOpsProviders, isLoading: statusLoading } =
    useChatOpsStatus();

  const ngrokDomain = configData?.features.ngrokDomain;
  const [reachabilityMode, selectReachabilityMode] = useReachabilityMode();
  const msTeams = chatOpsProviders?.find((p) => p.id === "ms-teams");

  const setupDataLoading = featuresLoading || statusLoading;
  const isLocalDev =
    configData?.features.isQuickstart || config.environment === "development";
  const { msTeams: allStepsCompleted } = useTriggerStatuses();
  const channelLabel = MESSAGING_CHANNEL_LABELS["ms-teams"];

  return (
    <div className="flex flex-col gap-4">
      <SetupSection
        allStepsCompleted={allStepsCompleted}
        isLoading={setupDataLoading}
        providerLabel={channelLabel}
        docsUrl={getFrontendDocsUrl("platform-ms-teams")}
      >
        <LlmKeySetupStep />
        {isLocalDev ? (
          <SetupStep
            title={`Make ${configuredAppName} reachable from the Internet`}
            done={reachabilityMode === "manual" || !!ngrokDomain}
          >
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2">
                <ModeTile
                  selected={reachabilityMode === "manual"}
                  onSelect={() => selectReachabilityMode("manual")}
                  icon={Globe}
                  title="Manual"
                  description={
                    <>
                      I will expose{" "}
                      <code className="bg-muted px-1 py-0.5 rounded text-xs break-all">
                        {`${manualWebhookBaseUrl}/api/webhooks/chatops/ms-teams`}
                      </code>{" "}
                      myself
                    </>
                  }
                />
                <ModeTile
                  selected={reachabilityMode === "ngrok"}
                  onSelect={() => {
                    selectReachabilityMode("ngrok");
                    if (!ngrokDomain) setNgrokDialogOpen(true);
                  }}
                  icon={Waypoints}
                  title="ngrok tunnel"
                  description={`${configuredAppName} opens a tunnel for you — best for local development`}
                />
              </div>
              {reachabilityMode === "ngrok" && ngrokDomain && (
                <NgrokStatus domain={ngrokDomain} />
              )}
            </div>
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
                must be publicly accessible so {channelLabel} can deliver
                messages to
                {configuredAppName}
              </span>
            </div>
          </div>
        )}
        <SetupStep
          title={`Setup ${channelLabel}`}
          description={`Register a Teams bot application and connect it to ${configuredAppName}`}
          done={!!msTeams?.configured}
          ctaLabel={`Setup ${channelLabel}`}
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
      </SetupSection>

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
