"use client";

import {
  type archestraApiTypes,
  MESSAGING_CHANNEL_LABELS,
} from "@archestra/shared";
import { AlertTriangle, Cable, Globe, Info, Waypoints } from "lucide-react";
import { useEffect, useState } from "react";
import { NgrokSetupDialog } from "@/components/ngrok-setup-dialog";
import { SlackSetupDialog } from "@/components/slack-setup-dialog";
import { Button } from "@/components/ui/button";
import { useChatOpsStatus } from "@/lib/chatops/chatops.query";
import { useUpdateSlackChatOpsConfig } from "@/lib/chatops/chatops-config.query";
import config from "@/lib/config/config";
import { useConfig, usePublicBaseUrl } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils";
import { CredentialField } from "../_components/credential-field";
import { LlmKeySetupStep } from "../_components/llm-key-setup-step";
import { ModeTile } from "../_components/mode-tile";
import { NgrokStatus } from "../_components/ngrok-status";
import { SetupSection } from "../_components/setup-section";
import { SetupStep } from "../_components/setup-step";
import { useReachabilityMode } from "../_components/use-reachability-mode";
import { useTriggerStatuses } from "../_components/use-trigger-statuses";

type SlackConnectionMode = NonNullable<
  NonNullable<
    archestraApiTypes.UpdateSlackChatOpsConfigData["body"]
  >["connectionMode"]
>;

export default function SlackPage() {
  const appName = useAppName();
  const publicBaseUrl = usePublicBaseUrl();
  // The "I will expose myself" tile must show the instance's own origin, not
  // the ngrok tunnel URL that usePublicBaseUrl prefers when a tunnel is up.
  const manualWebhookBaseUrl = usePublicBaseUrl({ ignoreNgrok: true });
  const [slackSetupOpen, setSlackSetupOpen] = useState(false);
  const [ngrokDialogOpen, setNgrokDialogOpen] = useState(false);

  const { data: configData, isLoading: featuresLoading } = useConfig();
  const { data: chatOpsProviders, isLoading: statusLoading } =
    useChatOpsStatus();

  const ngrokDomain = configData?.features.ngrokDomain;
  const [reachabilityMode, selectReachabilityMode] = useReachabilityMode();
  const slack = chatOpsProviders?.find((p) => p.id === "slack");
  const slackCreds = slack?.credentials;

  const resetMutation = useUpdateSlackChatOpsConfig();

  // Connection mode: use saved value if configured, otherwise default to "socket"
  const savedMode = slackCreds?.connectionMode as
    | SlackConnectionMode
    | undefined;
  const [selectedMode, setSelectedMode] = useState<SlackConnectionMode>(
    savedMode ?? "socket",
  );
  // Sync local state when saved config loads or changes (e.g. after reset)
  useEffect(() => {
    if (savedMode) setSelectedMode(savedMode);
  }, [savedMode]);
  const isSocket = (savedMode ?? selectedMode) === "socket";
  const hasModeChange = savedMode != null && selectedMode !== savedMode;

  const setupDataLoading = featuresLoading || statusLoading;
  const isLocalDev =
    configData?.features.isQuickstart || config.environment === "development";
  const { slack: allStepsCompleted } = useTriggerStatuses();
  // What this organization calls the channel — the vendor's own product nouns
  // ("Slack App", the api.slack.com console) stay literal so the setup steps
  // remain followable.
  const channelLabel = MESSAGING_CHANNEL_LABELS.slack;

  return (
    <div className="flex flex-col gap-4">
      <SetupSection
        allStepsCompleted={allStepsCompleted}
        isLoading={setupDataLoading}
        providerLabel={channelLabel}
        docsUrl={getFrontendDocsUrl("platform-slack")}
      >
        <LlmKeySetupStep />
        <SetupStep
          title="Choose connection mode"
          description={`How ${channelLabel} delivers events to ${appName}`}
          done={
            !hasModeChange &&
            (isSocket ||
              !isLocalDev ||
              reachabilityMode === "manual" ||
              !!ngrokDomain)
          }
        >
          <div
            className={cn(
              "grid gap-2",
              isLocalDev ? "grid-cols-3" : "grid-cols-2",
            )}
          >
            <ModeTile
              selected={selectedMode === "socket"}
              onSelect={() => setSelectedMode("socket")}
              icon={Cable}
              title="WebSocket"
              badge="Recommended"
              description={`${appName} exchanges WebSocket messages with ${channelLabel} — no public URL needed`}
            />
            {isLocalDev ? (
              <>
                <ModeTile
                  selected={
                    selectedMode === "webhook" && reachabilityMode === "ngrok"
                  }
                  onSelect={() => {
                    setSelectedMode("webhook");
                    selectReachabilityMode("ngrok");
                    if (!ngrokDomain) setNgrokDialogOpen(true);
                  }}
                  icon={Waypoints}
                  title="Webhook via ngrok"
                  description={`${appName} opens a tunnel for you — best for local development`}
                />
                <ModeTile
                  selected={
                    selectedMode === "webhook" && reachabilityMode === "manual"
                  }
                  onSelect={() => {
                    setSelectedMode("webhook");
                    selectReachabilityMode("manual");
                  }}
                  icon={Globe}
                  title="Webhook"
                  description={
                    <>
                      I will expose{" "}
                      <code className="bg-muted px-1 py-0.5 rounded text-xs break-all">
                        {`${manualWebhookBaseUrl}/api/webhooks/chatops/slack`}
                      </code>{" "}
                      myself
                    </>
                  }
                />
              </>
            ) : (
              <ModeTile
                selected={selectedMode === "webhook"}
                onSelect={() => setSelectedMode("webhook")}
                icon={Globe}
                title="Webhook"
                description={`${channelLabel} makes HTTP requests to ${appName}, requires a public URL`}
              />
            )}
          </div>
          {selectedMode === "webhook" &&
            !hasModeChange &&
            isLocalDev &&
            reachabilityMode === "ngrok" &&
            ngrokDomain && (
              <div className="mt-3 text-xs text-muted-foreground">
                <NgrokStatus domain={ngrokDomain} />
              </div>
            )}
          {selectedMode === "webhook" && !hasModeChange && !isLocalDev && (
            <div className="flex items-start gap-3 rounded-lg border border-blue-500/30 bg-blue-500/5 px-3 py-2 mt-3">
              <Info className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
              <span className="text-muted-foreground text-xs">
                The webhook endpoint{" "}
                <code className="bg-muted px-1 py-0.5 rounded">
                  POST {`${publicBaseUrl}/api/webhooks/chatops/slack`}
                </code>{" "}
                must be publicly accessible so {channelLabel} can deliver events
                to {appName}.
              </span>
            </div>
          )}
          {hasModeChange && (
            <div className="mt-3 space-y-3">
              {slack?.configured && (
                <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                  <span className="text-muted-foreground text-xs">
                    Changing the connection mode will reset your Slack
                    configuration. You will need to reconfigure {channelLabel}
                    with a new app manifest.
                  </span>
                </div>
              )}
              <Button
                size="sm"
                variant={slack?.configured ? "destructive" : "default"}
                disabled={resetMutation.isPending}
                onClick={async () => {
                  await resetMutation.mutateAsync({
                    enabled: false,
                    connectionMode: selectedMode,
                    botToken: "",
                    signingSecret: "",
                    appLevelToken: "",
                    appId: "",
                  });
                }}
              >
                {resetMutation.isPending
                  ? "Saving..."
                  : slack?.configured
                    ? "Reset & switch mode"
                    : "Save"}
              </Button>
            </div>
          )}
        </SetupStep>
        <SetupStep
          title="Setup Slack"
          description={`Create a Slack App from manifest and connect it to ${appName}`}
          done={!!slack?.configured}
          ctaLabel="Setup Slack"
          onAction={() => setSlackSetupOpen(true)}
          doneActionLabel="Reconfigure"
          onDoneAction={() => setSlackSetupOpen(true)}
        >
          <div className="flex items-center flex-wrap gap-4">
            <CredentialField
              label="Mode"
              value={isSocket ? "Socket" : "Webhook"}
            />
            <CredentialField label="Bot Token" value={slackCreds?.botToken} />
            {isSocket ? (
              <CredentialField
                label="App-Level Token"
                value={slackCreds?.appLevelToken}
              />
            ) : (
              <CredentialField
                label="Signing Secret"
                value={slackCreds?.signingSecret}
              />
            )}
            <CredentialField label="App ID" value={slackCreds?.appId} />
          </div>
        </SetupStep>
      </SetupSection>

      <SlackSetupDialog
        open={slackSetupOpen}
        onOpenChange={setSlackSetupOpen}
        connectionMode={savedMode ?? selectedMode}
      />
      <NgrokSetupDialog
        open={ngrokDialogOpen}
        onOpenChange={setNgrokDialogOpen}
      />
    </div>
  );
}
