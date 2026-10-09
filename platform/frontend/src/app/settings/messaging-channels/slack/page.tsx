"use client";

import {
  type archestraApiTypes,
  MESSAGING_CHANNEL_LABELS,
} from "@archestra/shared";
import { AlertTriangle, Cable, Globe, Info, Waypoints } from "lucide-react";
import { useEffect, useState } from "react";
import { NgrokSetupDialog } from "@/components/ngrok-setup-dialog";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useChatOpsStatus } from "@/lib/chatops/chatops.query";
import { useUpdateSlackChatOpsConfig } from "@/lib/chatops/chatops-config.query";
import config from "@/lib/config/config";
import { useConfig, usePublicBaseUrl } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils/tailwind";
import { ModeTile } from "../_components/mode-tile";
import { NgrokStatus } from "../_components/ngrok-status";
import { useReachabilityMode } from "../_components/use-reachability-mode";
import { SlackAgentBotsSection } from "./slack-agent-bots-section";

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
  const [ngrokDialogOpen, setNgrokDialogOpen] = useState(false);

  const { data: configData } = useConfig();
  const { data: chatOpsProviders } = useChatOpsStatus();

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
  const hasModeChange = savedMode != null && selectedMode !== savedMode;

  const isLocalDev =
    configData?.features.isQuickstart || config.environment === "development";
  // What this organization calls the channel — the vendor's own product nouns
  // ("Slack App", the api.slack.com console) stay literal so the setup steps
  // remain followable.
  const channelLabel = MESSAGING_CHANNEL_LABELS.slack;

  // A rare setting: it lives under Advanced in the bots section.
  const connectionModeSettings = (
    <div className="flex flex-col">
      <div
        className={cn("grid gap-2", isLocalDev ? "grid-cols-3" : "grid-cols-2")}
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
        <InlineNotice variant="info" className="mt-3">
          <Info />
          <InlineNoticeText>
            The webhook endpoint{" "}
            <code className="bg-muted px-1 py-0.5 rounded">
              POST {`${publicBaseUrl}/api/webhooks/chatops/slack`}
            </code>{" "}
            must be publicly accessible so {channelLabel} can deliver events to{" "}
            {appName}.
          </InlineNoticeText>
        </InlineNotice>
      )}
      {hasModeChange && (
        <div className="mt-3 space-y-3">
          {slack?.configured && (
            <InlineNotice>
              <AlertTriangle />
              <InlineNoticeText>
                Changing the connection mode will reset your Slack
                configuration. You will need to reconfigure {channelLabel}
                with a new app manifest.
              </InlineNoticeText>
            </InlineNotice>
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
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <SlackAgentBotsSection
        connectionMode={savedMode ?? selectedMode}
        connectionModeSettings={connectionModeSettings}
      />

      <NgrokSetupDialog
        open={ngrokDialogOpen}
        onOpenChange={setNgrokDialogOpen}
      />
    </div>
  );
}
