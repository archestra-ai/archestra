"use client";

import JSZip from "jszip";
import { Download, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { SetupDialog } from "@/components/setup-dialog";
import { StepCard } from "@/components/step-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useChatOpsStatus } from "@/lib/chatops.query";
import { useUpdateChatOpsConfigInQuickstart } from "@/lib/chatops-config.query";
import { usePublicBaseUrl } from "@/lib/features.hook";

interface MsTeamsSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MsTeamsSetupDialog({
  open,
  onOpenChange,
}: MsTeamsSetupDialogProps) {
  const mutation = useUpdateChatOpsConfigInQuickstart();
  const { data: chatOpsProviders } = useChatOpsStatus();
  const msTeams = chatOpsProviders?.find((p) => p.id === "ms-teams");
  const creds = msTeams?.credentials;

  const [saving, setSaving] = useState(false);

  // Shared credential state across steps (in-memory only)
  const [sharedAppId, setSharedAppId] = useState("");
  const [sharedAppSecret, setSharedAppSecret] = useState("");
  const [sharedTenantId, setSharedTenantId] = useState("");

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
      if (step.component === "install-and-connect") {
        return (
          <StepInstallAndConnect
            key={step.title}
            stepNumber={index + 1}
            video={step.video}
          />
        );
      }
      return (
        <StepSlide
          key={step.title}
          title={step.title}
          stepNumber={index + 1}
          video={step.video}
          instructions={step.instructions}
        />
      );
    });
  }, [sharedAppId, sharedAppSecret, sharedTenantId]);

  const lastStepAction = {
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
  };

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
          MS Teams
        </>,
      ],
    },
    {
      title: "Create App Manifest",
      component: "manifest" as const,
    },
    {
      title: "Install in MS Teams and connect Archestra",
      component: "install-and-connect" as const,
      video: "/ms-teams/ms-teams-upload-app.mp4",
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

      {video && (
        <video
          ref={videoRef}
          src={video}
          controls
          muted
          autoPlay
          loop
          playsInline
          className="rounded-md w-full"
        />
      )}
    </div>
  );
}

function StepBotSettings({
  stepNumber,
  video,
  appId,
  appSecret,
  tenantId,
  onAppIdChange,
  onAppSecretChange,
  onTenantIdChange,
}: {
  stepNumber: number;
  video?: string;
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
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard stepNumber={stepNumber} title="Configure Bot Settings">
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
              <WebhookUrlInstruction />
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              3
            </span>
            <span className="pt-0.5 flex-1">
              Copy the <strong>Microsoft App ID</strong>
              <Input
                value={appId}
                onChange={(e) => onAppIdChange(e.target.value)}
                placeholder="Paste your Microsoft App ID"
                className="mt-1.5"
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
                className="mt-1.5"
              />
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              5
            </span>
            <span className="pt-0.5 flex-1">
              Click <strong>Manage Password</strong> →{" "}
              <strong>New client secret</strong> → copy the secret value
              <Input
                type="password"
                value={appSecret}
                onChange={(e) => onAppSecretChange(e.target.value)}
                placeholder="Paste your client secret"
                className="mt-1.5"
              />
            </span>
          </li>
        </ol>
      </StepCard>

      {video && (
        <video
          src={video}
          controls
          muted
          autoPlay
          loop
          playsInline
          className="rounded-md w-full"
        />
      )}
    </div>
  );
}

function StepInstallAndConnect({
  stepNumber,
  video,
}: {
  stepNumber: number;
  video?: string;
}) {
  return (
    <div
      className="grid flex-1 gap-6"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard
        stepNumber={stepNumber}
        title="Install in MS Teams and connect Archestra"
      >
        <ol className="space-y-3">
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="pt-0.5">
              In Teams, go to <strong>Apps</strong> →{" "}
              <strong>Manage your apps</strong> → <strong>Upload an app</strong>
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              2
            </span>
            <span className="pt-0.5">
              Select your <strong>archestra-teams-app.zip</strong> file
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              3
            </span>
            <span className="pt-0.5">
              <strong>Add the app</strong> to a team or channel
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

      {video && (
        <video
          src={video}
          controls
          muted
          autoPlay
          loop
          playsInline
          className="rounded-md w-full"
        />
      )}
    </div>
  );
}

function buildManifest(params: {
  botAppId: string;
  nameShort: string;
  nameFull: string;
  version: string;
}) {
  const { botAppId, nameShort, nameFull, version } = params;
  return {
    $schema:
      "https://developer.microsoft.com/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
    manifestVersion: "1.16",
    version: version || "1.0.0",
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
        scopes: ["team", "groupchat", "personal"],
        supportsFiles: false,
        isNotificationOnly: false,
        commandLists: [
          {
            scopes: ["team", "groupchat", "personal"],
            commands: [
              {
                title: "/select-agent",
                description: "Change which agent handles this conversation",
              },
              {
                title: "/status",
                description: "Show current agent for this conversation",
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
  const [version, setVersion] = useState("1.0.0");
  const [downloading, setDownloading] = useState(false);

  const effectiveAppId = botAppId || prefillAppId || "";
  const manifest = buildManifest({
    botAppId: effectiveAppId,
    nameShort,
    nameFull,
    version,
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
      className="grid min-h-0 flex-1 gap-6"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard stepNumber={stepNumber} title="Create App Manifest">
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

        <div className="space-y-1">
          <Label htmlFor="manifest-version">Version</Label>
          <Input
            id="manifest-version"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="1.0.0"
          />
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
      </StepCard>

      <div className="flex min-h-0 flex-col gap-3 overflow-hidden rounded-lg border bg-muted/30 p-4">
        <div className="shrink-0 flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            manifest.json
          </span>
          <CopyButton text={manifestJson} />
        </div>
        <pre className="min-h-0 flex-1 overflow-auto rounded bg-muted p-3 text-xs font-mono leading-relaxed">
          {manifestJson}
        </pre>
      </div>
    </div>
  );
}

function WebhookUrlInstruction() {
  const publicBaseUrl = usePublicBaseUrl();
  const webhookUrl = `${publicBaseUrl}/api/webhooks/chatops/ms-teams`;

  return (
    <>
      Set <strong>Messaging endpoint</strong> to{" "}
      <span className="mt-1 flex items-center gap-1">
        <code className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
          {webhookUrl}
        </code>
        <span className="shrink-0">
          <CopyButton text={webhookUrl} />
        </span>
      </span>
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
