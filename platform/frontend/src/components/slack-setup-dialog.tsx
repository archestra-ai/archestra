"use client";

import { ExternalLink, Info } from "lucide-react";
import * as React from "react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { SetupDialog } from "@/components/setup-dialog";
import { StepCard } from "@/components/step-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useChatOpsStatus } from "@/lib/chatops.query";
import { useUpdateSlackChatOpsConfig } from "@/lib/chatops-config.query";
import config from "@/lib/config";
import { useFeatures } from "@/lib/features.query";

interface SlackSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SlackSetupDialog({
  open,
  onOpenChange,
}: SlackSetupDialogProps) {
  const { data: features } = useFeatures();
  const ngrokDomain = features?.ngrokDomain ?? "";

  const mutation = useUpdateSlackChatOpsConfig();
  const { data: chatOpsProviders } = useChatOpsStatus();
  const slack = chatOpsProviders?.find((p) => p.id === "slack");
  const creds = slack?.credentials as Record<string, string> | undefined;

  const [saving, setSaving] = useState(false);

  // Shared credential state across steps
  const [sharedBotToken, setSharedBotToken] = useState("");
  const [sharedSigningSecret, setSharedSigningSecret] = useState("");
  const [sharedAppId, setSharedAppId] = useState("");

  const isLocalEnvOrQuickstart =
    features?.isQuickstart || config.environment === "development";

  const hasBotToken = Boolean(sharedBotToken || creds?.botToken);
  const hasSigningSecret = Boolean(sharedSigningSecret || creds?.signingSecret);
  const hasAppId = Boolean(sharedAppId || creds?.appId);
  const canSave = hasBotToken && hasSigningSecret && hasAppId;

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value);
    if (!value) {
      setSharedBotToken("");
      setSharedSigningSecret("");
      setSharedAppId("");
    }
  };

  const webhookUrl = ngrokDomain
    ? `https://${ngrokDomain}/api/webhooks/chatops/slack`
    : "<archestra-url>/api/webhooks/chatops/slack";
  const interactiveUrl = ngrokDomain
    ? `https://${ngrokDomain}/api/webhooks/chatops/slack/interactive`
    : "<archestra-url>/api/webhooks/chatops/slack/interactive";
  const slashCommandUrl = ngrokDomain
    ? `https://${ngrokDomain}/api/webhooks/chatops/slack/slash-command`
    : "<archestra-url>/api/webhooks/chatops/slack/slash-command";

  const steps = React.useMemo(() => {
    const slides: React.ReactNode[] = [
      // Step 1: Create Slack App from manifest
      <StepManifest
        key="manifest"
        stepNumber={1}
        webhookUrl={webhookUrl}
        interactiveUrl={interactiveUrl}
        slashCommandUrl={slashCommandUrl}
        ngrokDomain={ngrokDomain}
        appId={sharedAppId}
        signingSecret={sharedSigningSecret}
        onAppIdChange={setSharedAppId}
        onSigningSecretChange={setSharedSigningSecret}
      />,
      // Step 2: Install App to Workspace
      <StepInstall
        key="install"
        stepNumber={2}
        botToken={sharedBotToken}
        onBotTokenChange={setSharedBotToken}
      />,
      // Step 3: Customize App Appearance
      <StepSlide
        key="appearance"
        title="Customize App Appearance"
        stepNumber={3}
        instructions={[
          <>
            Go to <strong>Basic Information</strong> &rarr;{" "}
            <strong>Display Information</strong>
          </>,
          <>
            Upload an app icon (
            <a
              href="/logo-slack.png"
              download="archestra-logo.png"
              className="text-primary underline hover:no-underline"
            >
              download Archestra logo
            </a>
            )
          </>,
          <>Optionally set a background color and short description</>,
        ]}
      />,
    ];

    // Step 4: Connect to Archestra (last step)
    if (isLocalEnvOrQuickstart) {
      slides.push(
        <StepConfigForm
          key="connect"
          stepNumber={4}
          botToken={sharedBotToken}
          signingSecret={sharedSigningSecret}
          appId={sharedAppId}
          onBotTokenChange={setSharedBotToken}
          onSigningSecretChange={setSharedSigningSecret}
          onAppIdChange={setSharedAppId}
          creds={creds}
        />,
      );
    } else {
      slides.push(
        <StepEnvVarsInfo
          key="connect"
          botToken={sharedBotToken}
          signingSecret={sharedSigningSecret}
          appId={sharedAppId}
        />,
      );
    }

    return slides;
  }, [
    ngrokDomain,
    isLocalEnvOrQuickstart,
    sharedBotToken,
    sharedSigningSecret,
    sharedAppId,
    creds,
    webhookUrl,
    interactiveUrl,
    slashCommandUrl,
  ]);

  const lastStepAction = isLocalEnvOrQuickstart
    ? {
        label: saving ? "Connecting..." : "Connect",
        disabled: saving || !canSave,
        loading: saving,
        onClick: async () => {
          setSaving(true);
          try {
            const body: Record<string, unknown> = { enabled: true };
            if (sharedBotToken) body.botToken = sharedBotToken;
            if (sharedSigningSecret) body.signingSecret = sharedSigningSecret;
            if (sharedAppId) body.appId = sharedAppId;
            const updateResult = await mutation.mutateAsync(
              body as {
                enabled?: boolean;
                botToken?: string;
                signingSecret?: string;
                appId?: string;
              },
            );
            if (updateResult?.success) {
              handleOpenChange(false);
            }
          } finally {
            setSaving(false);
          }
        },
      }
    : undefined;

  return (
    <SetupDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Setup Slack"
      description={
        <>
          Follow these steps to connect your Archestra agents to Slack. Find out
          more in our{" "}
          <a
            href="https://archestra.ai/docs/platform-slack"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline hover:no-underline"
          >
            documentation
          </a>
          .
        </>
      }
      steps={steps}
      lastStepAction={lastStepAction}
    />
  );
}

function StepSlide({
  title,
  stepNumber,
  instructions,
}: {
  title: string;
  stepNumber: number;
  instructions?: React.ReactNode[];
}) {
  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard stepNumber={stepNumber} title={title}>
        {instructions && (
          <ol className="space-y-3">
            {instructions.map((instruction, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: items are static
              <li key={i} className="flex gap-3 text-sm leading-relaxed">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  {i + 1}
                </span>
                <span className="pt-0.5">{instruction}</span>
              </li>
            ))}
          </ol>
        )}
      </StepCard>
      <video
        src="/slack/slack-display-settings.mp4"
        controls
        muted
        autoPlay
        loop
        playsInline
        className="rounded-md w-full"
      />
    </div>
  );
}

function StepInstall({
  stepNumber,
  botToken,
  onBotTokenChange,
}: {
  stepNumber: number;
  botToken: string;
  onBotTokenChange: (v: string) => void;
}) {
  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard stepNumber={stepNumber} title="Install App to Workspace">
        <ol className="space-y-3">
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="pt-0.5">
              Go to <strong>Install App</strong> in the left sidebar
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              2
            </span>
            <span className="pt-0.5">
              Click{" "}
              <strong>
                Install to <i>Your Workspace</i>
              </strong>{" "}
              and authorize the requested permissions
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              3
            </span>
            <span className="pt-0.5 flex-1">
              Copy the <strong>Bot User OAuth Token</strong> (starts with{" "}
              <code className="bg-muted px-1 py-0.5 rounded text-xs">
                xoxb-
              </code>
              ) and paste it here
              <Input
                type="password"
                value={botToken}
                onChange={(e) => onBotTokenChange(e.target.value)}
                placeholder="Paste your Bot User OAuth Token"
                className="mt-1.5"
              />
            </span>
          </li>
        </ol>
      </StepCard>
      <video
        src="/slack/add-slack-app.mp4"
        controls
        muted
        autoPlay
        loop
        playsInline
        className="rounded-md w-full"
      />
    </div>
  );
}

function buildSlackManifest(params: {
  appName: string;
  webhookUrl: string;
  interactiveUrl: string;
  slashCommandUrl: string;
}): string {
  const { appName, webhookUrl, interactiveUrl, slashCommandUrl } = params;
  const manifest = {
    display_information: {
      name: appName,
      description: "Archestra AI Agent",
    },
    features: {
      bot_user: {
        display_name: appName,
        always_online: true,
      },
      slash_commands: [
        {
          command: "/archestra-select-agent",
          description: "Change which agent handles this channel",
          url: slashCommandUrl,
        },
        {
          command: "/archestra-status",
          description: "Show current agent for this channel",
          url: slashCommandUrl,
        },
        {
          command: "/archestra-help",
          description: "Show available commands",
          url: slashCommandUrl,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: [
          "commands",
          "app_mentions:read",
          "channels:history",
          "channels:read",
          "chat:write",
          "groups:history",
          "groups:read",
          "im:history",
          "users:read",
          "users:read.email",
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: webhookUrl,
        bot_events: [
          "app_mention",
          "message.channels",
          "message.groups",
          "message.im",
        ],
      },
      interactivity: {
        is_enabled: true,
        request_url: interactiveUrl,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
  return JSON.stringify(manifest, null, 2);
}

function StepManifest({
  stepNumber,
  webhookUrl,
  interactiveUrl,
  slashCommandUrl,
  ngrokDomain,
  appId,
  signingSecret,
  onAppIdChange,
  onSigningSecretChange,
}: {
  stepNumber: number;
  webhookUrl: string;
  interactiveUrl: string;
  slashCommandUrl: string;
  ngrokDomain: string;
  appId: string;
  signingSecret: string;
  onAppIdChange: (v: string) => void;
  onSigningSecretChange: (v: string) => void;
}) {
  const [appName, setAppName] = useState("Archestra");

  const manifest = buildSlackManifest({
    appName,
    webhookUrl,
    interactiveUrl,
    slashCommandUrl,
  });

  return (
    <div
      className="grid min-h-0 flex-1 gap-6"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard stepNumber={stepNumber} title="Create Slack App">
        <div className="space-y-2">
          <Label htmlFor="manifest-app-name">App Name</Label>
          <Input
            id="manifest-app-name"
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            placeholder="Archestra"
          />
          <p className="text-xs text-muted-foreground">
            The name will be injected into the manifest automatically.
          </p>
        </div>

        <ol className="space-y-3">
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="pt-0.5">
              Go to{" "}
              <StepLink href="https://api.slack.com/apps">
                api.slack.com/apps
              </StepLink>{" "}
              and click <strong>Create New App</strong>
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              2
            </span>
            <span className="pt-0.5">
              Choose <strong>From a manifest</strong> and select your workspace
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              3
            </span>
            <span className="pt-0.5">
              Paste the manifest from the right, and click{" "}
              <strong>Create</strong>
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              4
            </span>
            <span className="pt-0.5 flex-1">
              From <strong>Basic Information &rarr; App Credentials</strong>,
              copy the <strong>App ID</strong> and paste it here
              <Input
                value={appId}
                onChange={(e) => onAppIdChange(e.target.value)}
                placeholder="Paste your App ID"
                className="mt-1.5"
              />
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              5
            </span>
            <span className="pt-0.5 flex-1">
              From <strong>Basic Information &rarr; App Credentials</strong>,
              copy the <strong>Signing Secret</strong> and paste it here
              <Input
                type="password"
                value={signingSecret}
                onChange={(e) => onSigningSecretChange(e.target.value)}
                placeholder="Paste your Signing Secret"
                className="mt-1.5"
              />
            </span>
          </li>
        </ol>

        {!ngrokDomain && (
          <span className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-600">
            <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              The manifest uses placeholder URLs. After creating the app, update
              the Event Subscriptions and Interactivity URLs with your actual
              Archestra URL.
            </span>
          </span>
        )}
      </StepCard>

      <div className="flex min-h-0 flex-col gap-3 overflow-hidden rounded-lg border bg-muted/30 p-4">
        <div className="shrink-0 flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            App Manifest (JSON)
          </span>
          <CopyButton text={manifest} />
        </div>
        <pre className="min-h-0 flex-1 overflow-auto rounded bg-muted p-3 text-xs font-mono leading-relaxed">
          {manifest}
        </pre>
      </div>
    </div>
  );
}

function StepConfigForm({
  stepNumber,
  botToken,
  signingSecret,
  appId,
  onBotTokenChange,
  onSigningSecretChange,
  onAppIdChange,
  creds,
}: {
  stepNumber: number;
  botToken: string;
  signingSecret: string;
  appId: string;
  onBotTokenChange: (v: string) => void;
  onSigningSecretChange: (v: string) => void;
  onAppIdChange: (v: string) => void;
  creds?: Record<string, string>;
}) {
  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard stepNumber={stepNumber} title="Connect to Archestra">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Enter the credentials from your Slack App.
        </p>
        <ol className="space-y-3">
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="pt-0.5 flex-1">
              <strong>Bot Token</strong> — from OAuth &amp; Permissions (starts
              with xoxb-)
              <Input
                id="setup-bot-token"
                type="password"
                value={botToken}
                onChange={(e) => onBotTokenChange(e.target.value)}
                placeholder={
                  creds?.botToken
                    ? `Current: ${creds.botToken}`
                    : "xoxb-your-bot-token"
                }
                className="mt-1.5"
              />
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              2
            </span>
            <span className="pt-0.5 flex-1">
              <strong>Signing Secret</strong> — from Basic Information &rarr;
              App Credentials
              <Input
                id="setup-signing-secret"
                type="password"
                value={signingSecret}
                onChange={(e) => onSigningSecretChange(e.target.value)}
                placeholder={
                  creds?.signingSecret
                    ? `Current: ${creds.signingSecret}`
                    : "Your Signing Secret"
                }
                className="mt-1.5"
              />
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              3
            </span>
            <span className="pt-0.5 flex-1">
              <strong>App ID</strong> — from Basic Information
              <Input
                id="setup-app-id"
                value={appId}
                onChange={(e) => onAppIdChange(e.target.value)}
                placeholder={
                  creds?.appId ? `Current: ${creds.appId}` : "Slack App ID"
                }
                className="mt-1.5"
              />
            </span>
          </li>
        </ol>
      </StepCard>

      <EnvVarsInfo
        botToken={botToken}
        signingSecret={signingSecret}
        appId={appId}
      />
    </div>
  );
}

function EnvVarsInfo({
  botToken,
  signingSecret,
  appId,
}: {
  botToken: string;
  signingSecret: string;
  appId: string;
}) {
  const envVarsText = [
    "ARCHESTRA_CHATOPS_SLACK_ENABLED=true",
    `ARCHESTRA_CHATOPS_SLACK_BOT_TOKEN=${botToken || "<your-bot-token>"}`,
    `ARCHESTRA_CHATOPS_SLACK_SIGNING_SECRET=${signingSecret || "<your-signing-secret>"}`,
    `ARCHESTRA_CHATOPS_SLACK_APP_ID=${appId || "<your-app-id>"}`,
  ].join("\n");

  const maskedDisplay = [
    "ARCHESTRA_CHATOPS_SLACK_ENABLED=true",
    `ARCHESTRA_CHATOPS_SLACK_BOT_TOKEN=${botToken ? "********" : "<your-bot-token>"}`,
    `ARCHESTRA_CHATOPS_SLACK_SIGNING_SECRET=${signingSecret ? "********" : "<your-signing-secret>"}`,
    `ARCHESTRA_CHATOPS_SLACK_APP_ID=${appId || "<your-app-id>"}`,
  ].join("\n");

  return (
    <div className="flex items-start gap-2.5 rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2.5 text-sm text-muted-foreground">
      <Info className="h-4 w-4 shrink-0 text-blue-500 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p>
          Values set here are stored in memory and will be reset after server
          restart. For persistent configuration, set these environment
          variables:
        </p>
        <div className="relative mt-2">
          <pre className="bg-muted rounded-md px-3 py-2 text-xs font-mono leading-relaxed overflow-x-auto">
            {maskedDisplay}
          </pre>
          <div className="absolute top-1 right-1">
            <CopyButton text={envVarsText} />
          </div>
        </div>
      </div>
    </div>
  );
}

function StepEnvVarsInfo({
  botToken,
  signingSecret,
  appId,
}: {
  botToken?: string;
  signingSecret?: string;
  appId?: string;
}) {
  const envVarsText = [
    "ARCHESTRA_CHATOPS_SLACK_ENABLED=true",
    `ARCHESTRA_CHATOPS_SLACK_BOT_TOKEN=${botToken || "<Bot User OAuth Token>"}`,
    `ARCHESTRA_CHATOPS_SLACK_SIGNING_SECRET=${signingSecret || "<Signing Secret>"}`,
    `ARCHESTRA_CHATOPS_SLACK_APP_ID=${appId || "<App ID>"}`,
  ].join("\n");

  const maskedEnvVarsDisplay = [
    "ARCHESTRA_CHATOPS_SLACK_ENABLED=true",
    `ARCHESTRA_CHATOPS_SLACK_BOT_TOKEN=${botToken ? "********" : "<Bot User OAuth Token>"}`,
    `ARCHESTRA_CHATOPS_SLACK_SIGNING_SECRET=${signingSecret ? "********" : "<Signing Secret>"}`,
    `ARCHESTRA_CHATOPS_SLACK_APP_ID=${appId || "<App ID>"}`,
  ].join("\n");

  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard stepNumber={4} title="Configure Archestra">
        <ol className="space-y-3">
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="pt-0.5">
              Set the environment variables shown on the right
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              2
            </span>
            <span className="pt-0.5">
              <strong>Restart Archestra</strong> for changes to take effect
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              3
            </span>
            <span className="pt-0.5">
              Edit an agent and enable the <strong>Slack</strong> toggle
            </span>
          </li>
        </ol>
      </StepCard>

      <div className="flex flex-col justify-center gap-5 rounded-lg border bg-muted/30 p-6">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Set the following environment variables and restart Archestra to
          enable Slack integration.
        </p>
        <div className="relative rounded bg-muted px-4 py-3 font-mono text-sm leading-loose">
          <div className="absolute top-2 right-2">
            <CopyButton text={envVarsText} />
          </div>
          <pre className="text-xs leading-loose whitespace-pre-wrap">
            {maskedEnvVarsDisplay}
          </pre>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          After setting these variables, restart Archestra for the changes to
          take effect. The Slack toggle will then appear on agents.
        </p>
      </div>
    </div>
  );
}

function StepLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-primary underline hover:no-underline"
    >
      {children}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}
