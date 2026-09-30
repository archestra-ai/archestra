"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { ExternalLink } from "lucide-react";
import * as React from "react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { SetupDialog } from "@/components/setup-dialog";
import { StepCard } from "@/components/step-card";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretInput } from "@/components/ui/secret-input";
import {
  useCreateSlackChatOpsBot,
  useUpdateSlackChatOpsConfig,
} from "@/lib/chatops/chatops-config.query";
import { usePublicBaseUrl } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useOrganization } from "@/lib/organization.query";
import { buildSlackManifest } from "@/lib/slack/slack-manifest";

type ConnectionMode = NonNullable<
  NonNullable<
    archestraApiTypes.UpdateSlackChatOpsConfigData["body"]
  >["connectionMode"]
>;

type SlackBotInfo = NonNullable<
  archestraApiTypes.GetChatOpsStatusResponses["200"]["providers"][number]["bots"]
>[number];

interface SlackSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionMode: ConnectionMode;
  /** The Slack App being reconfigured; omit to set up a new one. */
  bot?: SlackBotInfo;
  /**
   * Id the new Slack App will get. Webhook-mode manifests embed the app's own
   * event URLs, so the id is chosen before the app exists.
   */
  newBotId?: string;
  /**
   * Path the app's webhooks live under. Slack App #1 keeps the original
   * un-prefixed URLs; every other app has its own.
   */
  webhookPath: string;
  /**
   * The name offered for a brand-new app. Only the organization's first app
   * proposes the platform name; every further app must pick its own, since the
   * name is also its slash-command prefix.
   */
  defaultAppName?: string;
}

export function SlackSetupDialog({
  open,
  onOpenChange,
  connectionMode,
  bot,
  newBotId,
  webhookPath,
  defaultAppName = "",
}: SlackSetupDialogProps) {
  const docsUrl = getFrontendDocsUrl("platform-slack");
  const configuredAppName = useAppName();
  const publicBaseUrl = usePublicBaseUrl();

  const updateMutation = useUpdateSlackChatOpsConfig();
  const createMutation = useCreateSlackChatOpsBot();
  const creds = bot?.credentials;

  // A new app has no name yet: the admin picks one, and it is also the prefix
  // of the app's slash commands, so it must differ from the other apps.
  const [sharedAppName, setSharedAppName] = useState(
    bot?.name ?? defaultAppName,
  );

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
  const canSave =
    (bot ? true : sharedAppName.trim().length > 0) &&
    (isSocket
      ? hasBotToken && hasAppLevelToken && hasAppId
      : hasBotToken && hasSigningSecret && hasAppId);

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value);
    if (!value) {
      setSharedAppName(bot?.name ?? defaultAppName);
      setSharedBotToken("");
      setSharedSigningSecret("");
      setSharedAppLevelToken("");
      setSharedAppId("");
    }
  };

  const webhookUrl = `${publicBaseUrl}${webhookPath}`;
  const interactiveUrl = `${publicBaseUrl}${webhookPath}/interactive`;
  const slashCommandUrl = `${publicBaseUrl}${webhookPath}/slash-command`;

  const steps = React.useMemo(() => {
    if (isSocket) {
      return [
        <StepManifestSocket
          key="manifest-socket"
          stepNumber={1}
          appName={sharedAppName}
          onAppNameChange={setSharedAppName}
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
        appName={sharedAppName}
        onAppNameChange={setSharedAppName}
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
    sharedAppName,
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
        const credentials = {
          enabled: true,
          connectionMode,
          name: sharedAppName.trim() || undefined,
          ...(sharedBotToken && { botToken: sharedBotToken }),
          ...(sharedAppId && { appId: sharedAppId }),
          ...(isSocket
            ? sharedAppLevelToken && { appLevelToken: sharedAppLevelToken }
            : sharedSigningSecret && { signingSecret: sharedSigningSecret }),
        };
        const saved = bot
          ? await updateMutation.mutateAsync({ ...credentials, botId: bot.id })
          : await createMutation.mutateAsync({
              ...credentials,
              id: newBotId,
              name: sharedAppName.trim(),
              botToken: sharedBotToken,
            });
        if (saved) {
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
          Follow these steps to connect your {configuredAppName} agents to
          Slack.
          {docsUrl && (
            <>
              {" "}
              Find out more in our{" "}
              <ExternalDocsLink
                href={docsUrl}
                className="text-primary underline hover:no-underline"
              >
                documentation
              </ExternalDocsLink>
              .
            </>
          )}
        </>
      }
      steps={steps}
      lastStepAction={lastStepAction}
    />
  );
}

function StepAppearanceAndConnect({ stepNumber }: { stepNumber: number }) {
  const configuredAppName = useAppName();
  const { data: organization } = useOrganization();
  const logoUrl = organization?.iconLogo ?? "/logo-slack.png";
  return (
    <div
      className="grid flex-1 gap-4"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard
        stepNumber={stepNumber}
        title={`Customize App Appearance and connect ${configuredAppName}`}
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
                href={logoUrl}
                download={`${configuredAppName.toLowerCase()}-logo.png`}
                className="text-primary underline hover:no-underline"
              >
                download {configuredAppName} logo
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
      className="grid flex-1 gap-4"
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
              <SecretInput
                masked={false}
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
  const configuredAppName = useAppName();
  return (
    <div
      className="grid flex-1 gap-4"
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
              Name it (e.g., &ldquo;{configuredAppName.toLowerCase()}
              -socket&rdquo;) and add the{" "}
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
              <SecretInput
                masked={false}
                value={appLevelToken}
                onChange={(e) => onAppLevelTokenChange(e.target.value)}
                placeholder="Paste your App-Level Token"
                className="mt-1.5"
              />
            </span>
          </li>
        </ol>
      </StepCard>
      <video
        src="/slack/slack-app-level-token.mp4"
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

function StepManifestWebhook({
  stepNumber,
  appName,
  onAppNameChange,
  webhookUrl,
  interactiveUrl,
  slashCommandUrl,
  appId,
  signingSecret,
  onAppIdChange,
  onSigningSecretChange,
}: {
  stepNumber: number;
  appName: string;
  onAppNameChange: (v: string) => void;
  webhookUrl: string;
  interactiveUrl: string;
  slashCommandUrl: string;
  appId: string;
  signingSecret: string;
  onAppIdChange: (v: string) => void;
  onSigningSecretChange: (v: string) => void;
}) {
  const manifest = buildSlackManifest({
    appName: appName || NEW_APP_NAME_FALLBACK,
    connectionMode: "webhook",
    webhookUrl,
    interactiveUrl,
    slashCommandUrl,
  });

  return (
    <div
      className="grid min-h-0 flex-1 gap-4"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard stepNumber={stepNumber} title="Create Slack App">
        <div className="space-y-2">
          <Label htmlFor="manifest-app-name">App Name</Label>
          <FieldDescription>
            The name will be injected into the manifest automatically.
          </FieldDescription>
          <Input
            id="manifest-app-name"
            value={appName}
            onChange={(e) => onAppNameChange(e.target.value)}
            placeholder={NEW_APP_NAME_PLACEHOLDER}
          />
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
                aria-label="Slack App ID"
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
              <SecretInput
                masked={false}
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
  appName,
  onAppNameChange,
  appId,
  onAppIdChange,
}: {
  stepNumber: number;
  appName: string;
  onAppNameChange: (v: string) => void;
  appId: string;
  onAppIdChange: (v: string) => void;
}) {
  const manifest = buildSlackManifest({
    appName: appName || NEW_APP_NAME_FALLBACK,
    connectionMode: "socket",
    webhookUrl: "",
    interactiveUrl: "",
    slashCommandUrl: "",
  });

  return (
    <div
      className="grid min-h-0 flex-1 gap-4"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard stepNumber={stepNumber} title="Create Slack App">
        <div className="space-y-2">
          <Label htmlFor="manifest-app-name-socket">App Name</Label>
          <FieldDescription>
            The name will be injected into the manifest automatically.
          </FieldDescription>
          <Input
            id="manifest-app-name-socket"
            value={appName}
            onChange={(e) => onAppNameChange(e.target.value)}
            placeholder={NEW_APP_NAME_PLACEHOLDER}
          />
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
                aria-label="Slack App ID"
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

/** Manifest name while the field is still empty. */
const NEW_APP_NAME_FALLBACK = "New Slack App";
const NEW_APP_NAME_PLACEHOLDER = "e.g. Clode";
