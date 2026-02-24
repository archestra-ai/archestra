"use client";

import { AlertTriangle, ExternalLink, Info } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import Divider from "@/components/divider";
import { SlackSetupDialog } from "@/components/slack-setup-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useChatOpsStatus } from "@/lib/chatops.query";
import { useUpdateSlackChatOpsConfig } from "@/lib/chatops-config.query";
import config from "@/lib/config";
import { useFeatures } from "@/lib/config.query";
import { usePublicBaseUrl } from "@/lib/features.hook";
import { ChannelTilesSection } from "../_components/channel-tiles-section";
import { CollapsibleSetupSection } from "../_components/collapsible-setup-section";
import { CredentialField } from "../_components/credential-field";
import { SetupStep } from "../_components/setup-step";
import type { ProviderConfig } from "../_components/types";

const slackProviderConfig: ProviderConfig = {
  provider: "slack",
  providerLabel: "Slack",
  providerIcon: "/icons/slack.png",
  webhookPath: "/api/webhooks/chatops/slack",
  docsUrl: "https://archestra.ai/docs/platform-slack",
  slashCommand: "/select-agent",
  buildDeepLink: (binding) => {
    if (binding.workspaceId) {
      return `slack://channel?team=${binding.workspaceId}&id=${binding.channelId}`;
    }
    return `slack://channel?id=${binding.channelId}`;
  },
  getDmDeepLink: (providerStatus) => {
    const { botUserId, teamId } = providerStatus.dmInfo ?? {};
    if (!botUserId || !teamId) return null;
    return `slack://user?team=${teamId}&id=${botUserId}`;
  },
};

export default function SlackPage() {
  const publicBaseUrl = usePublicBaseUrl();
  const [slackSetupOpen, setSlackSetupOpen] = useState(false);
  const [ngrokDialogOpen, setNgrokDialogOpen] = useState(false);

  const { data: features, isLoading: featuresLoading } = useFeatures();
  const { data: chatOpsProviders, isLoading: statusLoading } =
    useChatOpsStatus();

  const ngrokDomain = features?.ngrokDomain;
  const slack = chatOpsProviders?.find((p) => p.id === "slack");
  const slackCreds = slack?.credentials as Record<string, string> | undefined;

  const resetMutation = useUpdateSlackChatOpsConfig();

  // Connection mode: use saved value if configured, otherwise default to "socket"
  const savedMode = slackCreds?.connectionMode as
    | "socket"
    | "webhook"
    | undefined;
  const [selectedMode, setSelectedMode] = useState<"socket" | "webhook">(
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
    features?.isQuickstart || config.environment === "development";

  // Socket mode doesn't require ngrok or a public URL
  const allStepsCompleted = isSocket
    ? !!slack?.configured
    : isLocalDev
      ? !!ngrokDomain && !!slack?.configured
      : !!slack?.configured;

  return (
    <div className="flex flex-col gap-6">
      <CollapsibleSetupSection
        allStepsCompleted={allStepsCompleted}
        isLoading={setupDataLoading}
        providerLabel="Slack"
        docsUrl="https://archestra.ai/docs/platform-slack"
      >
        <SetupStep
          title="Choose connection mode"
          description="How Slack delivers events to Archestra"
          done={
            !hasModeChange && (isSocket || (isLocalDev ? !!ngrokDomain : true))
          }
          ctaLabel={
            !isSocket && isLocalDev && !ngrokDomain && !hasModeChange
              ? "Configure ngrok"
              : undefined
          }
          onAction={() => setNgrokDialogOpen(true)}
        >
          <RadioGroup
            value={selectedMode}
            onValueChange={(v) => setSelectedMode(v as "socket" | "webhook")}
            className="flex gap-6"
          >
            {/* biome-ignore lint/a11y/noLabelWithoutControl: RadioGroupItem renders an input */}
            <label className="flex items-center gap-2 cursor-pointer">
              <RadioGroupItem value="socket" />
              <span className="text-sm">
                WebSocket{" "}
                <span className="text-muted-foreground">
                  — Archestra exchanges WebSocket messages with Slack, no public
                  URL needed
                </span>
              </span>
            </label>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: RadioGroupItem renders an input */}
            <label className="flex items-center gap-2 cursor-pointer">
              <RadioGroupItem value="webhook" />
              <span className="text-sm">
                Webhook{" "}
                <span className="text-muted-foreground">
                  — Slack makes HTTP requests to Archestra, requires a public
                  URL
                </span>
              </span>
            </label>
          </RadioGroup>
          {selectedMode === "webhook" && !hasModeChange && (
            <div className="flex items-start gap-3 rounded-lg border border-blue-500/30 bg-blue-500/5 px-3 py-2 mt-3">
              <Info className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
              <span className="text-muted-foreground text-xs">
                {isLocalDev && ngrokDomain ? (
                  <>
                    Ngrok domain{" "}
                    <code className="bg-muted px-1 py-0.5 rounded">
                      {ngrokDomain}
                    </code>{" "}
                    is configured.
                  </>
                ) : (
                  <>
                    The webhook endpoint{" "}
                    <code className="bg-muted px-1 py-0.5 rounded">
                      POST {`${publicBaseUrl}/api/webhooks/chatops/slack`}
                    </code>{" "}
                    must be publicly accessible so Slack can deliver events to
                    Archestra.
                    {isLocalDev &&
                      " Configure ngrok or deploy to a public URL."}
                  </>
                )}
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
                    configuration. You will need to reconfigure Slack with a new
                    app manifest.
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
          description="Create a Slack App from manifest and connect it to Archestra"
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
      </CollapsibleSetupSection>

      <Divider />

      <ChannelTilesSection providerConfig={slackProviderConfig} />

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

function NgrokSetupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [authToken, setAuthToken] = useState("");

  const ngrokCommand = `ngrok http --authtoken=${authToken || "<your-ngrok-auth-token>"} 9000`;
  const envCommand =
    "ARCHESTRA_NGROK_DOMAIN=<your-ngrok-domain>.ngrok-free.dev";

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value);
    if (!value) {
      setStep(1);
      setAuthToken("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {step === 1 ? (
          <>
            <DialogHeader>
              <DialogTitle>Enter your ngrok auth token</DialogTitle>
              <DialogDescription>
                Get one at{" "}
                <Link
                  href="https://dashboard.ngrok.com/get-started/your-authtoken"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  ngrok.com
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <Input
                placeholder="ngrok auth token"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
              />
              <Button
                className="w-full"
                disabled={!authToken.trim()}
                onClick={() => setStep(2)}
              >
                Continue
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Run ngrok for Slack webhooks</DialogTitle>
              <DialogDescription>
                Start an ngrok tunnel to make Archestra reachable from Slack.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="space-y-2 text-sm">
                <p>1. Start an ngrok tunnel:</p>
                <div className="relative">
                  <pre className="bg-muted rounded-md p-4 text-xs overflow-x-auto whitespace-pre">
                    {ngrokCommand}
                  </pre>
                  <div className="absolute top-2 right-2">
                    <CopyButton text={ngrokCommand} />
                  </div>
                </div>
              </div>
              <div className="space-y-2 text-sm">
                <p>
                  2. Set the ngrok domain in your{" "}
                  <code className="bg-muted px-1 py-0.5 rounded text-xs">
                    .env
                  </code>{" "}
                  file:
                </p>
                <div className="relative">
                  <pre className="bg-muted rounded-md p-4 text-xs overflow-x-auto whitespace-pre">
                    {envCommand}
                  </pre>
                  <div className="absolute top-2 right-2">
                    <CopyButton text={envCommand} />
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Then restart Archestra with{" "}
                <code className="bg-muted px-1 py-0.5 rounded">tilt up</code>
              </p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
