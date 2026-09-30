"use client";

import {
  type archestraApiTypes,
  MESSAGING_CHANNEL_LABELS,
} from "@archestra/shared";
import {
  AlertTriangle,
  Cable,
  Globe,
  Info,
  Plus,
  Trash2,
  Waypoints,
} from "lucide-react";
import { useEffect, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { NgrokSetupDialog } from "@/components/ngrok-setup-dialog";
import { SlackSetupDialog } from "@/components/slack-setup-dialog";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useChatOpsStatus } from "@/lib/chatops/chatops.query";
import {
  useDeleteChatOpsBot,
  useUpdateSlackChatOpsConfig,
} from "@/lib/chatops/chatops-config.query";
import config from "@/lib/config/config";
import { useConfig, usePublicBaseUrl } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils/tailwind";
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

type SlackBotInfo = NonNullable<
  archestraApiTypes.GetChatOpsStatusResponses["200"]["providers"][number]["bots"]
>[number];

/** Slack App #1 keeps the original un-prefixed webhook URLs. */
const FIRST_APP_WEBHOOK_PATH = "/api/webhooks/chatops/slack";

function webhookPathFor({
  botId,
  isFirstApp,
}: {
  botId: string;
  isFirstApp: boolean;
}) {
  return isFirstApp
    ? FIRST_APP_WEBHOOK_PATH
    : `${FIRST_APP_WEBHOOK_PATH}/bots/${botId}`;
}

export default function SlackPage() {
  const { data: configData, isLoading: featuresLoading } = useConfig();
  const { data: chatOpsProviders, isLoading: statusLoading } =
    useChatOpsStatus();
  const { slack: allStepsCompleted } = useTriggerStatuses();

  const bots =
    chatOpsProviders?.find((p) => p.id === "slack")?.bots ??
    ([] as SlackBotInfo[]);
  // The Slack App being set up right now, before it exists: chosen up front
  // because a webhook-mode manifest embeds the app's own event URLs.
  const [draftBotId, setDraftBotId] = useState<string | null>(null);
  const [firstAppId] = useState(() => crypto.randomUUID());
  const isLoading = featuresLoading || statusLoading;

  return (
    <div className="flex flex-col gap-8">
      {bots.map((bot, index) => (
        <SlackAppSetup
          key={bot.id}
          bot={bot}
          isFirstApp={index === 0}
          isLoading={isLoading}
          allStepsCompleted={allStepsCompleted && bot.configured}
          configData={configData}
        />
      ))}
      {!isLoading && bots.length === 0 && (
        <SlackAppSetup
          key={firstAppId}
          newBotId={firstAppId}
          isFirstApp
          isLoading={isLoading}
          allStepsCompleted={false}
          configData={configData}
        />
      )}
      {draftBotId && (
        <SlackAppSetup
          key={draftBotId}
          newBotId={draftBotId}
          isFirstApp={false}
          isLoading={isLoading}
          allStepsCompleted={false}
          configData={configData}
          onCancel={() => setDraftBotId(null)}
          onCreated={() => setDraftBotId(null)}
        />
      )}
      {!isLoading && bots.length > 0 && !draftBotId && (
        <div>
          <Button
            variant="outline"
            onClick={() => setDraftBotId(crypto.randomUUID())}
          >
            <Plus />
            <span>Set up another Slack App</span>
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * One Slack App's Setup block: its own connection mode and credentials. An
 * existing app passes `bot`; an app that does not exist yet passes `newBotId`.
 */
function SlackAppSetup({
  bot,
  newBotId,
  isFirstApp,
  isLoading,
  allStepsCompleted,
  configData,
  onCancel,
  onCreated,
}: {
  bot?: SlackBotInfo;
  newBotId?: string;
  isFirstApp: boolean;
  isLoading: boolean;
  allStepsCompleted: boolean;
  configData: ReturnType<typeof useConfig>["data"];
  onCancel?: () => void;
  onCreated?: () => void;
}) {
  const appName = useAppName();
  const publicBaseUrl = usePublicBaseUrl();
  // The "I will expose myself" tile must show the instance's own origin, not
  // the ngrok tunnel URL that usePublicBaseUrl prefers when a tunnel is up.
  const manualWebhookBaseUrl = usePublicBaseUrl({ ignoreNgrok: true });
  const [slackSetupOpen, setSlackSetupOpen] = useState(false);
  const [ngrokDialogOpen, setNgrokDialogOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  const ngrokDomain = configData?.features.ngrokDomain;
  const [reachabilityMode, selectReachabilityMode] = useReachabilityMode();
  const slackCreds = bot?.credentials;

  const resetMutation = useUpdateSlackChatOpsConfig();
  const removeMutation = useDeleteChatOpsBot();

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

  const isLocalDev =
    configData?.features.isQuickstart || config.environment === "development";
  // What this organization calls the channel — the vendor's own product nouns
  // ("Slack App", the api.slack.com console) stay literal so the setup steps
  // remain followable.
  const channelLabel = MESSAGING_CHANNEL_LABELS.slack;

  const botId = bot?.id ?? newBotId ?? "";
  const webhookPath = webhookPathFor({ botId, isFirstApp });
  const agents = bot?.agents ?? [];
  const botUser = bot?.dmInfo?.botUserId;

  return (
    <>
      <SetupSection
        allStepsCompleted={allStepsCompleted}
        isLoading={isLoading}
        providerLabel={channelLabel}
        docsUrl={getFrontendDocsUrl("platform-slack")}
        title={
          bot
            ? `Setup · ${bot.name}`
            : isFirstApp
              ? "Setup"
              : "Setup · New Slack App"
        }
        description={
          bot ? (
            <>
              Connect {channelLabel} so agents can receive and respond to
              messages.{" "}
              {agents.length === 0 ? (
                <span>Not used by any agent yet.</span>
              ) : (
                <span>
                  Used by {agents.length}{" "}
                  {agents.length === 1 ? "agent" : "agents"}:{" "}
                  {agents.map((agent) => agent.name).join(", ")}.
                </span>
              )}
            </>
          ) : isFirstApp ? undefined : (
            <>
              Another Slack App in the same workspace. Same steps, same dialog.
            </>
          )
        }
        actions={
          bot && agents.length === 0 && !isFirstApp ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground"
              onClick={() => setRemoveOpen(true)}
            >
              <Trash2 />
              <span>Remove</span>
            </Button>
          ) : bot ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground"
              onClick={() => setRemoveOpen(true)}
            >
              <Trash2 />
              <span>Remove</span>
            </Button>
          ) : onCancel ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={onCancel}
            >
              <span>Cancel</span>
            </Button>
          ) : null
        }
      >
        {isFirstApp && <LlmKeySetupStep />}
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
                        {`${manualWebhookBaseUrl}${webhookPath}`}
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
                description={`${channelLabel} makes HTTP requests to ${appName}${isFirstApp ? "" : " at a URL specific to this app"}, requires a public URL`}
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
                  POST {`${publicBaseUrl}${webhookPath}`}
                </code>{" "}
                must be publicly accessible so {channelLabel} can deliver events
                to {appName}.
              </InlineNoticeText>
            </InlineNotice>
          )}
          {hasModeChange && bot && (
            <div className="mt-3 space-y-3">
              {bot.configured && (
                <InlineNotice>
                  <AlertTriangle />
                  <InlineNoticeText>
                    Changing the connection mode will reset this Slack App's
                    configuration. You will need to reconfigure {channelLabel}{" "}
                    with a new app manifest.
                  </InlineNoticeText>
                </InlineNotice>
              )}
              <Button
                size="sm"
                variant={bot.configured ? "destructive" : "default"}
                disabled={resetMutation.isPending}
                onClick={async () => {
                  await resetMutation.mutateAsync({
                    botId: bot.id,
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
                  : bot.configured
                    ? "Reset & switch mode"
                    : "Save"}
              </Button>
            </div>
          )}
        </SetupStep>
        <SetupStep
          title="Setup Slack"
          description={`Create a Slack App from manifest and connect it to ${appName}`}
          done={!!bot?.configured}
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
            {botUser && <CredentialField label="Bot user" value={botUser} />}
          </div>
        </SetupStep>
      </SetupSection>

      <SlackSetupDialog
        open={slackSetupOpen}
        onOpenChange={(open) => {
          setSlackSetupOpen(open);
          // The draft turns into a real block once the app exists.
          if (!open && !bot) onCreated?.();
        }}
        connectionMode={savedMode ?? selectedMode}
        bot={bot}
        newBotId={newBotId}
        webhookPath={webhookPath}
      />
      <NgrokSetupDialog
        open={ngrokDialogOpen}
        onOpenChange={setNgrokDialogOpen}
      />
      {bot && (
        <DeleteConfirmDialog
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          title={`Remove ${bot.name}?`}
          description={
            agents.length > 0
              ? `${bot.name} is still used by ${agents.map((agent) => agent.name).join(", ")}. Remove it from ${agents.length === 1 ? "that agent" : "those agents"} first.`
              : `${bot.name} stops answering in Slack and its channels are dropped. You can set it up again later.`
          }
          isPending={removeMutation.isPending}
          confirmLabel="Remove"
          pendingLabel="Removing..."
          onConfirm={async () => {
            const result = await removeMutation
              .mutateAsync(bot.id)
              .catch(() => null);
            if (result?.success) setRemoveOpen(false);
          }}
        />
      )}
    </>
  );
}
