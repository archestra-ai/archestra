"use client";

import { ExternalLink } from "lucide-react";
import * as React from "react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { SetupDialog } from "@/components/setup-dialog";
import { StepCard } from "@/components/step-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useChatOpsStatus } from "@/lib/chatops.query";
import { useUpdateSlackChatOpsConfig } from "@/lib/chatops-config.query";
import { usePublicBaseUrl } from "@/lib/features.hook";

type ConnectionMode = "webhook" | "socket";

interface SlackSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionMode: ConnectionMode;
}

export function SlackSetupDialog({
  open,
  onOpenChange,
  connectionMode,
}: SlackSetupDialogProps) {
  const publicBaseUrl = usePublicBaseUrl();

  const mutation = useUpdateSlackChatOpsConfig();
  const { data: chatOpsProviders } = useChatOpsStatus();
  const slack = chatOpsProviders?.find((p) => p.id === "slack");
  const creds = slack?.credentials as Record<string, string> | undefined;

  const [saving, setSaving] = useState(false);

  // Shared credential state across steps
  const [sharedBotToken, setSharedBotToken] = useState("");
  const [sharedSigningSecret, setSharedSigningSecret] = useState("");
  const [sharedAppLevelToken, setSharedAppLevelToken] = useState("");
  const [sharedAppId, setSharedAppId] = useState("");

  const isSocket = connectionMode === "socket";

  const hasBotToken = Boolean(sharedBotToken || creds?.botToken);
  const hasSigningSecret = Boolean(sharedSigningSecret || creds?.signingSecret);
  const hasAppLevelToken = Boolean(sharedAppLevelToken || creds?.appLevelToken);
  const hasAppId = Boolean(sharedAppId || creds?.appId);
  const canSave = isSocket
    ? hasBotToken && hasAppLevelToken && hasAppId
    : hasBotToken && hasSigningSecret && hasAppId;

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value);
    if (!value) {
      setSharedBotToken("");
      setSharedSigningSecret("");
      setSharedAppLevelToken("");
      setSharedAppId("");
    }
  };

  const webhookUrl = `${publicBaseUrl}/api/webhooks/chatops/slack`;
  const interactiveUrl = `${publicBaseUrl}/api/webhooks/chatops/slack/interactive`;
  const slashCommandUrl = `${publicBaseUrl}/api/webhooks/chatops/slack/slash-command`;

  const steps = React.useMemo(() => {
    if (isSocket) {
      return [
        <StepManifestSocket
          key="manifest-socket"
          stepNumber={1}
          appId={sharedAppId}
          onAppIdChange={setSharedAppId}
        />,
        <StepAppLevelToken
          key="app-level-token"
          stepNumber={2}
          appLevelToken={sharedAppLevelToken}
          onAppLevelTokenChange={setSharedAppLevelToken}
        />,
        <StepInstall
          key="install"
          stepNumber={3}
          botToken={sharedBotToken}
          onBotTokenChange={setSharedBotToken}
        />,
        <StepAppearanceAndConnect
          key="appearance-and-connect"
          stepNumber={4}
        />,
      ];
    }

    return [
      <StepManifestWebhook
        key="manifest-webhook"
        stepNumber={1}
        webhookUrl={webhookUrl}
        interactiveUrl={interactiveUrl}
        slashCommandUrl={slashCommandUrl}
        appId={sharedAppId}
        signingSecret={sharedSigningSecret}
        onAppIdChange={setSharedAppId}
        onSigningSecretChange={setSharedSigningSecret}
      />,
      <StepInstall
        key="install"
        stepNumber={2}
        botToken={sharedBotToken}
        onBotTokenChange={setSharedBotToken}
      />,
      <StepAppearanceAndConnect key="appearance-and-connect" stepNumber={3} />,
    ];
  }, [
    isSocket,
    sharedBotToken,
    sharedSigningSecret,
    sharedAppLevelToken,
    sharedAppId,
    webhookUrl,
    interactiveUrl,
    slashCommandUrl,
  ]);

  const lastStepAction = {
    label: saving ? "Connecting..." : "Connect",
    disabled: saving || !canSave,
    loading: saving,
    onClick: async () => {
      setSaving(true);
      try {
        const body: Record<string, unknown> = {
          enabled: true,
          connectionMode,
        };
        if (sharedBotToken) body.botToken = sharedBotToken;
        if (sharedAppId) body.appId = sharedAppId;
        if (isSocket) {
          if (sharedAppLevelToken) body.appLevelToken = sharedAppLevelToken;
        } else {
          if (sharedSigningSecret) body.signingSecret = sharedSigningSecret;
        }
        const updateResult = await mutation.mutateAsync(
          body as {
            enabled?: boolean;
            botToken?: string;
            signingSecret?: string;
            appId?: string;
            connectionMode?: "webhook" | "socket";
            appLevelToken?: string;
          },
        );
        if (updateResult?.success) {
          handleOpenChange(false);
        }
      } finally {
        setSaving(false);
      }
    },
  };

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

function StepAppearanceAndConnect({ stepNumber }: { stepNumber: number }) {
  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard
        stepNumber={stepNumber}
        title="Customize App Appearance and connect Archestra"
      >
        <ol className="space-y-3">
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="pt-0.5">
              Go to <strong>Basic Information</strong> &rarr;{" "}
              <strong>Display Information</strong>
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              2
            </span>
            <span className="pt-0.5">
              Upload an app icon (
              <a
                href="/logo-slack.png"
                download="archestra-logo.png"
                className="text-primary underline hover:no-underline"
              >
                download Archestra logo
              </a>
              )
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              3
            </span>
            <span className="pt-0.5">
              Optionally set a background color and short description
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              4
            </span>
            <span className="pt-0.5 flex-1">
              Click <strong>Connect</strong> in the bottom right corner
            </span>
          </li>
        </ol>
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
              )
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

function StepAppLevelToken({
  stepNumber,
  appLevelToken,
  onAppLevelTokenChange,
}: {
  stepNumber: number;
  appLevelToken: string;
  onAppLevelTokenChange: (v: string) => void;
}) {
  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard stepNumber={stepNumber} title="Generate App-Level Token">
        <ol className="space-y-3">
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="pt-0.5">
              Go to <strong>Basic Information</strong> &rarr;{" "}
              <strong>App-Level Tokens</strong>
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              2
            </span>
            <span className="pt-0.5">
              Click <strong>Generate Token and Scopes</strong>
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              3
            </span>
            <span className="pt-0.5">
              Name it (e.g., &ldquo;archestra-socket&rdquo;) and add the{" "}
              <code className="bg-muted px-1 py-0.5 rounded text-xs">
                connections:write
              </code>{" "}
              scope
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              4
            </span>
            <span className="pt-0.5 flex-1">
              Copy the token (starts with{" "}
              <code className="bg-muted px-1 py-0.5 rounded text-xs">
                xapp-
              </code>
              )
              <Input
                type="password"
                value={appLevelToken}
                onChange={(e) => onAppLevelTokenChange(e.target.value)}
                placeholder="Paste your App-Level Token"
                className="mt-1.5"
              />
            </span>
          </li>
        </ol>
      </StepCard>
      <div className="flex items-center justify-center rounded-lg border bg-muted/30 p-6">
        <p className="text-sm text-muted-foreground text-center max-w-xs">
          The App-Level Token enables Socket Mode, allowing Archestra to connect
          to Slack via an outbound WebSocket — no public URL needed.
        </p>
      </div>
    </div>
  );
}

function buildSlackManifest(params: {
  appName: string;
  connectionMode: ConnectionMode;
  webhookUrl: string;
  interactiveUrl: string;
  slashCommandUrl: string;
}): string {
  const {
    appName,
    connectionMode,
    webhookUrl,
    interactiveUrl,
    slashCommandUrl,
  } = params;
  const isSocket = connectionMode === "socket";

  // biome-ignore lint/suspicious/noExplicitAny: Manifest shape varies by mode
  const manifest: any = {
    display_information: {
      name: appName,
      description: "Archestra AI Agent",
    },
    features: {
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: appName,
        always_online: true,
      },
      slash_commands: isSocket
        ? [
            {
              command: "/archestra-select-agent",
              description: "Change which agent handles this channel",
            },
            {
              command: "/archestra-status",
              description: "Show current agent for this channel",
            },
            {
              command: "/archestra-help",
              description: "Show available commands",
            },
          ]
        : [
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
          "im:read",
          "im:write",
          "users:read",
          "users:read.email",
        ],
      },
    },
    settings: {
      event_subscriptions: isSocket
        ? {
            bot_events: [
              "app_mention",
              "message.channels",
              "message.groups",
              "message.im",
            ],
          }
        : {
            request_url: webhookUrl,
            bot_events: [
              "app_mention",
              "message.channels",
              "message.groups",
              "message.im",
            ],
          },
      interactivity: isSocket
        ? { is_enabled: true }
        : { is_enabled: true, request_url: interactiveUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: isSocket,
      token_rotation_enabled: false,
    },
  };
  return JSON.stringify(manifest, null, 2);
}

function StepManifestWebhook({
  stepNumber,
  webhookUrl,
  interactiveUrl,
  slashCommandUrl,
  appId,
  signingSecret,
  onAppIdChange,
  onSigningSecretChange,
}: {
  stepNumber: number;
  webhookUrl: string;
  interactiveUrl: string;
  slashCommandUrl: string;
  appId: string;
  signingSecret: string;
  onAppIdChange: (v: string) => void;
  onSigningSecretChange: (v: string) => void;
}) {
  const [appName, setAppName] = useState("Archestra");

  const manifest = buildSlackManifest({
    appName,
    connectionMode: "webhook",
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
              copy the <strong>App ID</strong>
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
              copy the <strong>Signing Secret</strong>
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

function StepManifestSocket({
  stepNumber,
  appId,
  onAppIdChange,
}: {
  stepNumber: number;
  appId: string;
  onAppIdChange: (v: string) => void;
}) {
  const [appName, setAppName] = useState("Archestra");

  const manifest = buildSlackManifest({
    appName,
    connectionMode: "socket",
    webhookUrl: "",
    interactiveUrl: "",
    slashCommandUrl: "",
  });

  return (
    <div
      className="grid min-h-0 flex-1 gap-6"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard stepNumber={stepNumber} title="Create Slack App">
        <div className="space-y-2">
          <Label htmlFor="manifest-app-name-socket">App Name</Label>
          <Input
            id="manifest-app-name-socket"
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
              copy the <strong>App ID</strong>
              <Input
                value={appId}
                onChange={(e) => onAppIdChange(e.target.value)}
                placeholder="Paste your App ID"
                className="mt-1.5"
              />
            </span>
          </li>
        </ol>
      </StepCard>

      <div className="flex min-h-0 flex-col gap-3 overflow-hidden rounded-lg border bg-muted/30 p-4">
        <div className="shrink-0 flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            App Manifest (JSON) — Socket Mode
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
