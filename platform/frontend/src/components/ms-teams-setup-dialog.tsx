"use client";

import JSZip from "jszip";
import {
  Download,
  ExternalLink,
  Info,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { SetupDialog } from "@/components/setup-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useChatOpsStatus } from "@/lib/chatops.query";
import { useUpdateChatOpsConfigInQuickstart } from "@/lib/chatops-config.query";
import config from "@/lib/config";
import { useFeatures } from "@/lib/features.query";

interface MsTeamsSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MsTeamsSetupDialog({
  open,
  onOpenChange,
}: MsTeamsSetupDialogProps) {
  const { data: features } = useFeatures();
  const ngrokDomain = features?.ngrokDomain ?? "";

  const mutation = useUpdateChatOpsConfigInQuickstart();
  const { data: chatOpsProviders } = useChatOpsStatus();
  const msTeams = chatOpsProviders?.find((p) => p.id === "ms-teams");
  const creds = msTeams?.credentials;

  const [saving, setSaving] = useState(false);

  // Shared credential state across steps (in-memory only)
  const [sharedAppId, setSharedAppId] = useState("");
  const [sharedAppSecret, setSharedAppSecret] = useState("");
  const [sharedTenantId, setSharedTenantId] = useState("");

  const isLocalEnvOrQuickstart =
    features?.isQuickstart || config.environment === "development";

  const hasAppId = Boolean(sharedAppId || creds?.appId);
  const hasAppSecret = Boolean(sharedAppSecret || creds?.appSecret);
  const canSave = hasAppId && hasAppSecret;

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value);
    if (!value) {
      setSharedAppId("");
      setSharedAppSecret("");
      setSharedTenantId("");
    }
  };

  const stepContents = React.useMemo(() => {
    const slides = buildSteps();
    return slides.map((step, index) => {
      if (step.component === "credentials") {
        return (
          <StepBotSettings
            key={step.title}
            stepNumber={index + 1}
            video={step.video}
            ngrokDomain={ngrokDomain}
            appId={sharedAppId}
            appSecret={sharedAppSecret}
            tenantId={sharedTenantId}
            onAppIdChange={setSharedAppId}
            onAppSecretChange={setSharedAppSecret}
            onTenantIdChange={setSharedTenantId}
          />
        );
      }
      if (step.component === "manifest") {
        return (
          <StepManifest
            key={step.title}
            stepNumber={index + 1}
            prefillAppId={sharedAppId}
          />
        );
      }
      if (index < slides.length - 1) {
        return (
          <StepSlide
            key={step.title}
            title={step.title}
            stepNumber={index + 1}
            video={step.video}
            instructions={step.instructions}
          />
        );
      }
      // Last step
      if (isLocalEnvOrQuickstart) {
        return (
          <StepConfigForm
            key={step.title}
            appId={sharedAppId}
            appSecret={sharedAppSecret}
            tenantId={sharedTenantId}
            onAppIdChange={setSharedAppId}
            onAppSecretChange={setSharedAppSecret}
            onTenantIdChange={setSharedTenantId}
            creds={creds}
          />
        );
      }
      return (
        <StepEnvVarsInfo
          key={step.title}
          appId={sharedAppId}
          appSecret={sharedAppSecret}
          tenantId={sharedTenantId}
        />
      );
    });
  }, [
    ngrokDomain,
    isLocalEnvOrQuickstart,
    sharedAppId,
    sharedAppSecret,
    sharedTenantId,
    creds,
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
            if (sharedAppId) body.appId = sharedAppId;
            if (sharedAppSecret) body.appSecret = sharedAppSecret;
            if (sharedTenantId) body.tenantId = sharedTenantId;
            const updateResult = await mutation.mutateAsync(
              body as {
                enabled?: boolean;
                appId?: string;
                appSecret?: string;
                tenantId?: string;
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
      title="Setup Microsoft Teams"
      description={
        <>
          Follow these steps to connect your Archestra agents to Microsoft
          Teams. Find out more in our{" "}
          <a
            href="https://archestra.ai/docs/platform-ms-teams"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline hover:no-underline"
          >
            documentation
          </a>
          .
        </>
      }
      steps={stepContents}
      lastStepAction={lastStepAction}
    />
  );
}

function buildSteps() {
  return [
    {
      title: "Create Azure Bot",
      video: "/ms-teams/create-azure-bot.mp4",
      instructions: [
        <>
          Go to{" "}
          <StepLink href="https://portal.azure.com">portal.azure.com</StepLink>{" "}
          and click <strong>Create a resource</strong>, then search for{" "}
          <strong>Azure Bot</strong>
        </>,
        <>
          Fill in <strong>bot handle</strong>, <strong>subscription</strong>,
          and <strong>resource group</strong> (create one if needed)
        </>,
        <>
          Under <strong>Type of App</strong>, choose{" "}
          <strong>Multi Tenant</strong> (default) or{" "}
          <strong>Single Tenant</strong> for your organization only
        </>,
        <>
          Under <strong>Microsoft App ID</strong>, select{" "}
          <strong>Create new Microsoft App ID</strong>
        </>,
        <>
          Click <strong>Review + create</strong> and create the new resource
        </>,
      ],
    },
    {
      title: "Configure Bot Settings",
      component: "credentials" as const,
      video: "/ms-teams/bot-settings.mp4",
    },
    {
      title: "Add Teams Channel",
      video: "/ms-teams/team-channel.mp4",
      instructions: [
        <>
          In your Azure Bot resource, go to <strong>Channels</strong>
        </>,
        <>
          Click <strong>Add Microsoft Teams</strong> as a channel
        </>,
        <>
          Accept the terms and save — this enables your bot to communicate with
          Teams
        </>,
      ],
    },
    {
      title: "Create App Manifest",
      component: "manifest" as const,
    },
    {
      title: "Install in Teams",
      video: "/ms-teams/ms-teams-upload-app.mp4",
      instructions: [
        <>
          In Teams, go to <strong>Apps</strong> →{" "}
          <strong>Manage your apps</strong> → <strong>Upload an app</strong>
        </>,
        <>
          Select your <strong>archestra-teams-app.zip</strong> file
        </>,
        <>
          <strong>Add the app</strong> to a team or channel
        </>,
      ],
    },
    {
      title: "Connect to Archestra",
    },
  ];
}

function StepSlide({
  title,
  stepNumber,
  video,
  instructions,
}: {
  title: string;
  stepNumber: number;
  video?: string;
  instructions?: React.ReactNode[];
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);

  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "6fr 4fr" }}
    >
      {video && (
        <div className="flex justify-center items-center rounded-lg border bg-muted/30 p-2 relative">
          <video
            ref={videoRef}
            src={video}
            controls
            muted
            autoPlay
            loop
            playsInline
            className="rounded-md w-full h-full object-contain"
          />
        </div>
      )}

      <div className="flex flex-col gap-4 py-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            Step {stepNumber}
          </Badge>
          <h3 className="text-lg font-semibold">{title}</h3>
        </div>
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
      </div>
    </div>
  );
}

function StepBotSettings({
  stepNumber,
  video,
  ngrokDomain,
  appId,
  appSecret,
  tenantId,
  onAppIdChange,
  onAppSecretChange,
  onTenantIdChange,
}: {
  stepNumber: number;
  video?: string;
  ngrokDomain: string;
  appId: string;
  appSecret: string;
  tenantId: string;
  onAppIdChange: (v: string) => void;
  onAppSecretChange: (v: string) => void;
  onTenantIdChange: (v: string) => void;
}) {
  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "6fr 4fr" }}
    >
      {video && (
        <div className="flex justify-center items-center rounded-lg border bg-muted/30 p-2 relative">
          <video
            src={video}
            controls
            muted
            autoPlay
            loop
            playsInline
            className="rounded-md w-full h-full object-contain"
          />
        </div>
      )}

      <div className="flex flex-col gap-4 py-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            Step {stepNumber}
          </Badge>
          <h3 className="text-lg font-semibold">Configure Bot Settings</h3>
        </div>

        <ol className="space-y-3">
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="pt-0.5">
              After creation, go to newly created <strong>resource</strong> and
              then to <strong>Settings</strong> → <strong>Configuration</strong>
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              2
            </span>
            <span className="pt-0.5">
              <WebhookUrlInstruction ngrokDomain={ngrokDomain} />
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              3
            </span>
            <span className="pt-0.5 flex-1">
              Copy the <strong>Microsoft App ID</strong> and paste it here
              <Input
                value={appId}
                onChange={(e) => onAppIdChange(e.target.value)}
                placeholder="Paste your Microsoft App ID"
                className="h-7 text-xs mt-1.5"
              />
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              4
            </span>
            <span className="pt-0.5 flex-1">
              Copy <strong>App Tenant ID</strong>{" "}
              <span className="text-muted-foreground">(optional)</span> — for
              single-tenant bots
              <Input
                value={tenantId}
                onChange={(e) => onTenantIdChange(e.target.value)}
                placeholder="Paste your Tenant ID"
                className="h-7 text-xs mt-1.5"
              />
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              5
            </span>
            <span className="pt-0.5 flex-1">
              Click <strong>Manage Password</strong> →{" "}
              <strong>New client secret</strong> → copy the secret value and
              paste it here
              <Input
                type="password"
                value={appSecret}
                onChange={(e) => onAppSecretChange(e.target.value)}
                placeholder="Paste your client secret"
                className="h-7 text-xs mt-1.5"
              />
            </span>
          </li>
        </ol>
      </div>
    </div>
  );
}

function StepConfigForm({
  appId,
  appSecret,
  tenantId,
  onAppIdChange,
  onAppSecretChange,
  onTenantIdChange,
  creds,
}: {
  appId: string;
  appSecret: string;
  tenantId: string;
  onAppIdChange: (v: string) => void;
  onAppSecretChange: (v: string) => void;
  onTenantIdChange: (v: string) => void;
  creds?: { appId?: string; appSecret?: string; tenantId?: string };
}) {
  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "6fr 4fr" }}
    >
      <div className="flex flex-col gap-5 rounded-lg border bg-muted/30 p-6">
        <div className="space-y-2">
          <Label htmlFor="setup-app-id">App ID</Label>
          <Input
            id="setup-app-id"
            value={appId}
            onChange={(e) => onAppIdChange(e.target.value)}
            placeholder={
              creds?.appId ? `Current: ${creds.appId}` : "Azure Bot App ID"
            }
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="setup-app-secret">App Secret</Label>
          <Input
            id="setup-app-secret"
            type="password"
            value={appSecret}
            onChange={(e) => onAppSecretChange(e.target.value)}
            placeholder={
              creds?.appSecret
                ? `Current: ${creds.appSecret}`
                : "Azure Bot App Secret"
            }
          />
        </div>

        <div className="space-y-2 mb-8">
          <Label htmlFor="setup-tenant-id">
            Tenant ID{" "}
            <span className="text-muted-foreground font-normal">
              (optional)
            </span>
          </Label>
          <Input
            id="setup-tenant-id"
            value={tenantId}
            onChange={(e) => onTenantIdChange(e.target.value)}
            placeholder={
              creds?.tenantId
                ? `Current: ${creds.tenantId}`
                : "Azure AD Tenant ID — only for single-tenant bots"
            }
          />
        </div>

        <EnvVarsInfo appId={appId} appSecret={appSecret} tenantId={tenantId} />
      </div>

      <div className="flex flex-col gap-4 py-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            Step 6
          </Badge>
          <h3 className="text-lg font-semibold">Connect to Archestra</h3>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Enter the credentials you copied from the Azure Bot resource.
        </p>
        <ol className="space-y-3">
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="pt-0.5">
              <strong>App ID</strong> — from the Azure Bot Configuration page
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              2
            </span>
            <span className="pt-0.5">
              <strong>App Secret</strong> — the client secret you created
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              3
            </span>
            <span className="pt-0.5">
              <strong>Tenant ID</strong> — only needed for single-tenant bots
            </span>
          </li>
        </ol>
      </div>
    </div>
  );
}

function EnvVarsInfo({
  appId,
  appSecret,
  tenantId,
}: {
  appId: string;
  appSecret: string;
  tenantId: string;
}) {
  const envVarsText = [
    "ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED=true",
    `ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID=${appId || "<your-app-id>"}`,
    `ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET=${appSecret || "<your-app-secret>"}`,
    tenantId
      ? `ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID=${tenantId}`
      : "ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID=<your-tenant-id>",
  ].join("\n");

  const maskedDisplay = [
    "ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED=true",
    `ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID=${appId || "<your-app-id>"}`,
    `ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET=${appSecret ? "********" : "<your-app-secret>"}`,
    tenantId
      ? `ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID=${tenantId}`
      : "ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID=<your-tenant-id>",
  ].join("\n");

  return (
    <div className="flex items-start gap-2.5 rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2.5 text-sm text-muted-foreground">
      <Info className="h-4 w-4 shrink-0 text-blue-500 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p>
          Values that are set or edited here are stored in memory and will be
          reset after server restart. For persistent configuration, set these
          environment variables:
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
  appId,
  appSecret,
  tenantId,
}: {
  appId?: string;
  appSecret?: string;
  tenantId?: string;
}) {
  const envVarsText = [
    "ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED=true",
    `ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID=${appId || "<Microsoft App ID>"}`,
    `ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET=${appSecret || "<Client Secret>"}`,
    `ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID=${tenantId || "<Tenant ID>"}`,
  ].join("\n");

  const maskedEnvVarsDisplay = [
    "ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED=true",
    `ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID=${appId || "<Microsoft App ID>"}`,
    `ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET=${appSecret ? "********" : "<Client Secret>"}`,
    `ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID=${tenantId || "<Tenant ID>"}`,
  ].join("\n");

  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "7fr 3fr" }}
    >
      <div className="flex flex-col justify-center gap-5 rounded-lg border bg-muted/30 p-6">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Set the following environment variables and restart Archestra to
          enable MS Teams integration.
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
          take effect. The MS Teams toggle will then appear on agents.
        </p>
      </div>

      <div className="flex flex-col gap-4 py-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            Step 6
          </Badge>
          <h3 className="text-lg font-semibold">Configure Archestra</h3>
        </div>
        <ol className="space-y-3">
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="pt-0.5">
              Set the environment variables shown on the left
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
              Edit an agent and enable the <strong>Microsoft Teams</strong>{" "}
              toggle
            </span>
          </li>
        </ol>
      </div>
    </div>
  );
}

function buildManifest(params: {
  botAppId: string;
  nameShort: string;
  nameFull: string;
}) {
  const { botAppId, nameShort, nameFull } = params;
  return {
    $schema:
      "https://developer.microsoft.com/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
    manifestVersion: "1.16",
    version: "1.0.0",
    id: botAppId || "{{BOT_MS_APP_ID}}",
    packageName: "com.archestra.bot",
    developer: {
      name: "Archestra",
      websiteUrl: "https://archestra.ai",
      privacyUrl: "https://archestra.ai/privacy",
      termsOfUseUrl: "https://archestra.ai/terms",
    },
    name: { short: nameShort, full: nameFull },
    description: { short: "Ask Archestra", full: "Chat with Archestra agents" },
    icons: { outline: "outline.png", color: "color.png" },
    accentColor: "#FFFFFF",
    bots: [
      {
        botId: botAppId || "{{BOT_MS_APP_ID}}",
        scopes: ["team", "groupchat"],
        supportsFiles: false,
        isNotificationOnly: false,
        commandLists: [
          {
            scopes: ["team", "groupchat"],
            commands: [
              {
                title: "/select-agent",
                description: "Change which agent handles this channel",
              },
              {
                title: "/status",
                description: "Show current agent for this channel",
              },
              { title: "/help", description: "Show available commands" },
            ],
          },
        ],
      },
    ],
    permissions: ["identity", "messageTeamMembers"],
    validDomains: [],
    webApplicationInfo: {
      id: botAppId || "{{BOT_MS_APP_ID}}",
      resource: "https://graph.microsoft.com",
    },
    authorization: {
      permissions: {
        resourceSpecific: [
          { name: "ChannelMessage.Read.Group", type: "Application" },
          { name: "ChatMessage.Read.Chat", type: "Application" },
          { name: "TeamMember.Read.Group", type: "Application" },
          { name: "ChatMember.Read.Chat", type: "Application" },
        ],
      },
    },
  };
}

function StepManifest({
  stepNumber,
  prefillAppId,
}: {
  stepNumber: number;
  prefillAppId?: string;
}) {
  const [botAppId, setBotAppId] = useState("");
  const [nameShort, setNameShort] = useState("Archestra");
  const [nameFull, setNameFull] = useState("Archestra Bot");
  const [downloading, setDownloading] = useState(false);

  const effectiveAppId = botAppId || prefillAppId || "";
  const manifest = buildManifest({
    botAppId: effectiveAppId,
    nameShort,
    nameFull,
  });
  const manifestJson = JSON.stringify(manifest, null, 2);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const zip = new JSZip();
      zip.file("manifest.json", manifestJson);

      const [colorRes, outlineRes] = await Promise.all([
        fetch("/ms-teams/color.png"),
        fetch("/ms-teams/outline.png"),
      ]);
      zip.file("color.png", await colorRes.blob());
      zip.file("outline.png", await outlineRes.blob());

      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "archestra-teams-app.zip";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "6fr 4fr" }}
    >
      <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4 min-h-0 overflow-x-auto">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            manifest.json
          </span>
          <CopyButton text={manifestJson} />
        </div>
        <pre className="flex-1 overflow-auto rounded bg-muted p-3 text-xs font-mono leading-relaxed min-h-0">
          {manifestJson}
        </pre>
      </div>

      <div className="flex flex-col gap-4 py-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            Step {stepNumber}
          </Badge>
          <h3 className="text-lg font-semibold">Create App Manifest</h3>
        </div>

        <div className="space-y-2">
          <Label htmlFor="manifest-bot-id">Microsoft App ID</Label>
          <Input
            id="manifest-bot-id"
            value={effectiveAppId}
            onChange={(e) => setBotAppId(e.target.value)}
            placeholder={
              prefillAppId
                ? `From Step 2: ${prefillAppId}`
                : "Paste your Microsoft App ID"
            }
          />
          <p className="text-xs text-muted-foreground">
            {effectiveAppId
              ? "App ID will be injected into the manifest automatically."
              : "The App ID from Step 2. It will be injected into the manifest automatically."}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="manifest-name-short">Name (short)</Label>
            <Input
              id="manifest-name-short"
              value={nameShort}
              onChange={(e) => setNameShort(e.target.value)}
              placeholder="Archestra"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="manifest-name-full">Name (full)</Label>
            <Input
              id="manifest-name-full"
              value={nameFull}
              onChange={(e) => setNameFull(e.target.value)}
              placeholder="Archestra Bot"
            />
          </div>
        </div>

        <Button
          onClick={handleDownload}
          disabled={!effectiveAppId || downloading}
          className="w-full"
        >
          {downloading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-2 h-4 w-4" />
          )}
          Download archestra-teams-app.zip
        </Button>

        {!effectiveAppId && (
          <span className="flex items-center gap-1 text-xs text-amber-500">
            <TriangleAlert className="h-3 w-3 shrink-0" />
            Enter your Microsoft App ID to generate the manifest
          </span>
        )}
      </div>
    </div>
  );
}

function WebhookUrlInstruction({ ngrokDomain }: { ngrokDomain: string }) {
  const [customDomain, setCustomDomain] = useState("");
  const hasKnownDomain = Boolean(ngrokDomain);
  const domain = hasKnownDomain ? ngrokDomain : customDomain || "your-domain";
  const webhookUrl = `https://${domain}/api/webhooks/chatops/ms-teams`;

  const canCopy = hasKnownDomain || Boolean(customDomain);

  return (
    <>
      Set <strong>Messaging endpoint</strong> to{" "}
      <span className="mt-1 flex items-center gap-1">
        <code className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
          {webhookUrl}
        </code>
        <span className="shrink-0">
          {canCopy && <CopyButton text={webhookUrl} />}
        </span>
      </span>
      {!hasKnownDomain && (
        <>
          <label
            htmlFor="webhook-custom-domain"
            className="mt-2 flex items-center gap-2 text-xs"
          >
            <span className="shrink-0 text-muted-foreground">Your domain:</span>
            <Input
              id="webhook-custom-domain"
              type="text"
              value={customDomain}
              onChange={(e) => setCustomDomain(e.target.value)}
              placeholder="e.g. myapp.example.com"
              className="h-6 rounded border bg-background px-2 text-xs font-mono w-48 placeholder:text-muted-foreground/50"
            />
          </label>
          {!customDomain && (
            <span className="mt-1 flex items-center gap-1 text-xs text-amber-500">
              <TriangleAlert className="h-3 w-3 shrink-0" />
              Enter your public Archestra domain above
            </span>
          )}
        </>
      )}
    </>
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
