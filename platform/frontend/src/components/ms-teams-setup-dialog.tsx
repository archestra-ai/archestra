"use client";

import JSZip from "jszip";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import { useEffect, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { SetupDialog } from "@/components/setup-dialog";
import { StepCard } from "@/components/step-card";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretInput } from "@/components/ui/secret-input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useChatOpsStatus } from "@/lib/chatops/chatops.query";
import {
  useMsTeamsChatOpsConfig,
  useUpdateChatOpsConfigInQuickstart,
} from "@/lib/chatops/chatops-config.query";
import { copyToClipboard } from "@/lib/clipboard";
import { usePublicBaseUrl } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  buildChannelFilesRequest,
  parseSharePointSites,
} from "@/lib/ms-teams/channel-files-request";
import { buildTeamsManifest } from "@/lib/ms-teams/teams-manifest";

interface MsTeamsSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MsTeamsSetupDialog({
  open,
  onOpenChange,
}: MsTeamsSetupDialogProps) {
  const docsUrl = getFrontendDocsUrl("agents/triggers-and-channels/ms-teams");
  const configuredAppName = useAppName();
  const mutation = useUpdateChatOpsConfigInQuickstart();
  const { data: chatOpsProviders } = useChatOpsStatus();
  const msTeams = chatOpsProviders?.find((p) => p.id === "ms-teams");
  const creds = msTeams?.credentials;
  const { data: msTeamsConfig } = useMsTeamsChatOpsConfig(open);

  const [saving, setSaving] = useState(false);

  // Shared credential state across steps (in-memory only)
  const [sharedAppId, setSharedAppId] = useState("");
  const [sharedAppSecret, setSharedAppSecret] = useState("");
  const [sharedTenantId, setSharedTenantId] = useState("");
  // null until the person flips it, so reopening shows the saved setting.
  const [groupChatFileSignIn, setGroupChatFileSignIn] = useState<
    boolean | null
  >(null);
  const groupChatFileSignInValue =
    groupChatFileSignIn ?? msTeamsConfig?.groupChatFileSignIn ?? false;

  // The status endpoint exposes the real App ID (it's not a secret) — prefill
  // it on reconfigure so it also flows into the manifest step. Secret and
  // tenant ID only come back masked, so those show a saved-value mask instead.
  const savedAppId = msTeams?.dmInfo?.appId ?? "";
  useEffect(() => {
    if (open && savedAppId) {
      setSharedAppId((prev) => prev || savedAppId);
    }
  }, [open, savedAppId]);

  const hasAppId = Boolean(sharedAppId || creds?.appId);
  const hasAppSecret = Boolean(sharedAppSecret || creds?.appSecret);
  const canSave = hasAppId && hasAppSecret;

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value);
    if (!value) {
      setSharedAppId("");
      setSharedAppSecret("");
      setSharedTenantId("");
      setGroupChatFileSignIn(null);
    }
  };

  const stepContents = React.useMemo(() => {
    const slides = buildSteps(configuredAppName);
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
            savedAppSecretMask={creds?.appSecret ?? ""}
            savedTenantIdMask={creds?.tenantId ?? ""}
            onAppIdChange={setSharedAppId}
            onAppSecretChange={setSharedAppSecret}
            onTenantIdChange={setSharedTenantId}
          />
        );
      }
      if (step.component === "channel-files") {
        return (
          <StepChannelFiles
            key={step.title}
            stepNumber={index + 1}
            appId={sharedAppId || savedAppId}
            appName={configuredAppName}
          />
        );
      }
      if (step.component === "group-chat-files") {
        return (
          <StepGroupChatFiles
            key={step.title}
            stepNumber={index + 1}
            redirectUri={msTeamsConfig?.signInRedirectUri ?? ""}
            enabled={groupChatFileSignInValue}
            onEnabledChange={setGroupChatFileSignIn}
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
  }, [
    sharedAppId,
    sharedAppSecret,
    sharedTenantId,
    configuredAppName,
    creds?.appSecret,
    creds?.tenantId,
    savedAppId,
    msTeamsConfig?.signInRedirectUri,
    groupChatFileSignInValue,
  ]);

  const lastStepAction = {
    label: saving ? "Connecting..." : "Connect",
    disabled: saving || !canSave,
    loading: saving,
    onClick: async () => {
      setSaving(true);
      try {
        const body: Parameters<typeof mutation.mutateAsync>[0] = {
          enabled: true,
        };
        if (sharedAppId) body.appId = sharedAppId;
        if (sharedAppSecret) body.appSecret = sharedAppSecret;
        if (sharedTenantId) body.tenantId = sharedTenantId;
        if (groupChatFileSignIn !== null)
          body.groupChatFileSignIn = groupChatFileSignIn;
        const updateResult = await mutation.mutateAsync(body);
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
          Follow these steps to connect your {configuredAppName} agents to
          Microsoft Teams.
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
      steps={stepContents}
      lastStepAction={lastStepAction}
    />
  );
}

function buildSteps(appName: string) {
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
      title: "Read Files in Channels (Optional)",
      component: "channel-files" as const,
    },
    {
      title: "Read Files in Group Chats (Optional)",
      component: "group-chat-files" as const,
    },
    {
      title: "Create App Manifest",
      component: "manifest" as const,
    },
    {
      title: `Install in MS Teams and connect ${appName}`,
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
      className="grid flex-1 gap-4"
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
  savedAppSecretMask,
  savedTenantIdMask,
  onAppIdChange,
  onAppSecretChange,
  onTenantIdChange,
}: {
  stepNumber: number;
  video?: string;
  appId: string;
  appSecret: string;
  tenantId: string;
  savedAppSecretMask: string;
  savedTenantIdMask: string;
  onAppIdChange: (v: string) => void;
  onAppSecretChange: (v: string) => void;
  onTenantIdChange: (v: string) => void;
}) {
  // Saved values come back from the API masked (e.g. "e6e••••••••"). Show the
  // mask as the field value while blurred and empty so a reconfigure reads as
  // prefilled; it can never be submitted because typing replaces it.
  const [tenantFocused, setTenantFocused] = useState(false);
  const [secretFocused, setSecretFocused] = useState(false);
  const showTenantMask = !!savedTenantIdMask && !tenantFocused && !tenantId;
  const showSecretMask = !!savedAppSecretMask && !secretFocused && !appSecret;

  return (
    <div
      className="grid flex-1 gap-4"
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
                aria-label="Microsoft App ID"
                value={appId}
                onChange={(e) => onAppIdChange(e.target.value)}
                placeholder="Paste your Microsoft App ID"
                className="mt-1.5"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
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
                aria-label="Microsoft Tenant ID"
                value={showTenantMask ? savedTenantIdMask : tenantId}
                onChange={(e) => onTenantIdChange(e.target.value)}
                onFocus={() => setTenantFocused(true)}
                onBlur={() => setTenantFocused(false)}
                placeholder={
                  savedTenantIdMask
                    ? "leave empty to keep the saved Tenant ID"
                    : "Paste your Tenant ID"
                }
                className="mt-1.5"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
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
              <SecretInput
                // masked={false}: the value swap below already renders the
                // saved-secret mask, and a newly typed secret stays visible
                // (this dialog's pre-SecretInput behavior)
                masked={false}
                value={showSecretMask ? savedAppSecretMask : appSecret}
                onChange={(e) => onAppSecretChange(e.target.value)}
                onFocus={() => setSecretFocused(true)}
                onBlur={() => setSecretFocused(false)}
                placeholder={
                  savedAppSecretMask
                    ? "leave empty to keep the saved secret"
                    : "Paste your client secret"
                }
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
  const configuredAppName = useAppName();
  return (
    <div
      className="grid flex-1 gap-4"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard
        stepNumber={stepNumber}
        title={`Install in MS Teams and connect ${configuredAppName}`}
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
              Select your{" "}
              <strong>{configuredAppName.toLowerCase()}-teams-app.zip</strong>{" "}
              file
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

function StepManifest({
  stepNumber,
  prefillAppId,
}: {
  stepNumber: number;
  prefillAppId?: string;
}) {
  const configuredAppName = useAppName();
  const [botAppId, setBotAppId] = useState("");
  const [nameShort, setNameShort] = useState(configuredAppName);
  const [nameFull, setNameFull] = useState(`${configuredAppName} Bot`);
  const [version, setVersion] = useState("1.0.0");
  const [downloading, setDownloading] = useState(false);

  const effectiveAppId = botAppId || prefillAppId || "";
  const manifest = buildTeamsManifest({
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
      a.download = `${configuredAppName.toLowerCase()}-teams-app.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      className="grid min-h-0 flex-1 gap-4"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard stepNumber={stepNumber} title="Create App Manifest">
        <div className="space-y-2">
          <Label htmlFor="manifest-bot-id">Microsoft App ID</Label>
          <FieldDescription>
            {effectiveAppId
              ? "App ID will be injected into the manifest automatically."
              : "The App ID from Step 2. It will be injected into the manifest automatically."}
          </FieldDescription>
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
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="manifest-name-short">Name (short)</Label>
            <Input
              id="manifest-name-short"
              value={nameShort}
              onChange={(e) => setNameShort(e.target.value)}
              placeholder={configuredAppName}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="manifest-name-full">Name (full)</Label>
            <Input
              id="manifest-name-full"
              value={nameFull}
              onChange={(e) => setNameFull(e.target.value)}
              placeholder={`${configuredAppName} Bot`}
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
          <span>Download {configuredAppName.toLowerCase()}-teams-app.zip</span>
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

/**
 * Optional: let the bot read files shared in channels. Teams stores them in
 * each team's SharePoint site and no Teams app permission reaches them, so the
 * bot's app needs Graph `Sites.Selected` plus a read grant on each site. Both
 * are Microsoft 365 admin tasks, usually owned by a different team than the
 * one running this wizard, so the step builds a request to hand over.
 */
function StepChannelFiles({
  stepNumber,
  appId,
  appName,
}: {
  stepNumber: number;
  appId: string;
  appName: string;
}) {
  const [sitesInput, setSitesInput] = useState("");
  const [copied, setCopied] = useState(false);
  const sites = parseSharePointSites(sitesInput);
  const request = buildChannelFilesRequest({
    appId: appId.trim() || "<Microsoft App ID>",
    botName: `${appName} Teams bot`,
    sites,
  });

  const handleCopy = async () => {
    await copyToClipboard(request);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="grid flex-1 gap-4"
      style={{ gridTemplateColumns: "1fr 1fr" }}
    >
      <StepCard
        stepNumber={stepNumber}
        title="Read Files in Channels (Optional)"
      >
        <p className="text-sm text-muted-foreground">
          Lets the bot read PDFs and other files shared in channels. Images and
          files in direct messages work without this. Your Microsoft 365 admin
          grants it: the bot gets read access to the teams you list, nothing
          else.
        </p>
        <ol className="space-y-3">
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="pt-0.5 flex-1 min-w-0">
              List the teams' SharePoint sites, one per line. In a channel, open{" "}
              <strong>Files</strong> → <strong>Open in SharePoint</strong> and
              copy the address.
              <Textarea
                aria-label="Team SharePoint sites"
                value={sitesInput}
                onChange={(e) => setSitesInput(e.target.value)}
                placeholder={
                  "https://contoso.sharepoint.com/sites/Engineering\nhttps://contoso.sharepoint.com/sites/Support"
                }
                className="mt-1.5 min-h-16 font-mono text-xs"
                rows={3}
              />
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              2
            </span>
            <span className="pt-0.5 flex-1 min-w-0">
              Send this request to your Microsoft 365 admin. It has every step
              and command, filled in.
              <span className="mt-1.5 flex flex-col gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="self-start"
                  onClick={handleCopy}
                >
                  {copied ? (
                    <Check className="mr-1.5 h-4 w-4" />
                  ) : (
                    <Copy className="mr-1.5 h-4 w-4" />
                  )}
                  <span>{copied ? "Copied" : "Copy request for IT"}</span>
                </Button>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2.5 text-xs font-mono leading-relaxed">
                  {request}
                </pre>
              </span>
            </span>
          </li>
        </ol>
        <p className="text-xs text-muted-foreground">
          Files in group chats are stored in each sender's OneDrive instead. The
          next step covers them.
        </p>
      </StepCard>

      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground">
          What your admin does in Microsoft Entra
        </span>
        <video
          src="/ms-teams/sites-selected.mp4"
          controls
          muted
          autoPlay
          loop
          playsInline
          className="rounded-md w-full"
        />
      </div>
    </div>
  );
}

/**
 * Optional: let the bot read files shared in group chats. Teams stores each
 * one in its sender's OneDrive, which no application permission reaches short
 * of every OneDrive in the tenant. Instead the bot asks the sender to sign in
 * once (delegated `Files.Read`) and reads only the files they share with it.
 * The app registration needs the sign-in redirect URI and that permission.
 */
function StepGroupChatFiles({
  stepNumber,
  redirectUri,
  enabled,
  onEnabledChange,
}: {
  stepNumber: number;
  redirectUri: string;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex flex-1 flex-col">
      <StepCard
        stepNumber={stepNumber}
        title="Read Files in Group Chats (Optional)"
      >
        <p className="text-sm text-muted-foreground">
          Files in group chats are stored in each sender's OneDrive. With this
          on, the bot asks a person to sign in with Microsoft the first time
          they share a file with it, then answers their message. It reads only
          the files that person shares with it.
        </p>
        <ol className="space-y-3">
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="pt-0.5 flex-1 min-w-0">
              In <strong>App registrations</strong>, open your bot's app, go to{" "}
              <strong>Authentication</strong> → <strong>Add a platform</strong>{" "}
              → <strong>Web</strong>, and add this redirect URI:
              <span className="mt-1 flex items-center gap-1">
                <code className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                  {redirectUri}
                </code>
                <span className="shrink-0">
                  <CopyButton text={redirectUri} />
                </span>
              </span>
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              2
            </span>
            <span className="pt-0.5 flex-1 min-w-0">
              In <strong>API permissions</strong>, add the{" "}
              <strong>Microsoft Graph</strong> delegated permissions{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                Files.Read
              </code>{" "}
              and{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                offline_access
              </code>
              . People can consent for themselves; grant admin consent to skip
              that prompt.
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              3
            </span>
            <span className="pt-0.5 flex flex-1 min-w-0 items-center gap-3">
              <Switch
                id="ms-teams-group-chat-file-sign-in"
                checked={enabled}
                onCheckedChange={onEnabledChange}
              />
              <Label htmlFor="ms-teams-group-chat-file-sign-in">
                Ask people to sign in to read their group-chat files
              </Label>
            </span>
          </li>
        </ol>
        <p className="text-xs text-muted-foreground">
          Anyone can type <code>/sign-out</code> to the bot to remove their
          sign-in.
        </p>
      </StepCard>
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
