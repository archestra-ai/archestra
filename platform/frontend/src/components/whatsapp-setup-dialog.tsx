"use client";

import * as React from "react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { SetupDialog } from "@/components/setup-dialog";
import { StepCard } from "@/components/step-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useChatOpsStatus } from "@/lib/chatops/chatops.query";
import {
  type UpdateWhatsAppChatOpsConfigBody,
  useUpdateWhatsAppChatOpsConfig,
} from "@/lib/chatops/chatops-config.query";
import { usePublicBaseUrl } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";

interface WhatsAppSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type PhoneUserMapping = {
  phoneNumber: string;
  email: string;
};

export function WhatsAppSetupDialog({
  open,
  onOpenChange,
}: WhatsAppSetupDialogProps) {
  const appName = useAppName();
  const publicBaseUrl = usePublicBaseUrl();
  const docsUrl = getFrontendDocsUrl("platform-whatsapp");
  const mutation = useUpdateWhatsAppChatOpsConfig();
  const { data: chatOpsProviders } = useChatOpsStatus();
  const whatsApp = chatOpsProviders?.find((p) => String(p.id) === "whatsapp");
  const creds = whatsApp?.credentials as
    | {
        accessToken?: string;
        appSecret?: string;
        graphApiVersion?: string;
        phoneNumberId?: string;
        phoneUserMappings?: unknown[];
        verifyToken?: string;
      }
    | undefined;

  const [saving, setSaving] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [graphApiVersion, setGraphApiVersion] = useState("v21.0");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [mappingRows, setMappingRows] = useState("");

  React.useEffect(() => {
    if (!open) return;
    setGraphApiVersion(creds?.graphApiVersion || "v21.0");
    setMappingRows(formatMappings(creds?.phoneUserMappings));
  }, [creds?.graphApiVersion, creds?.phoneUserMappings, open]);

  const parsedMappings = React.useMemo(
    () => parseMappingRows(mappingRows),
    [mappingRows],
  );
  const canSave =
    Boolean(accessToken || creds?.accessToken) &&
    Boolean(appSecret || creds?.appSecret) &&
    Boolean(phoneNumberId || creds?.phoneNumberId) &&
    Boolean(verifyToken || creds?.verifyToken) &&
    parsedMappings.length > 0;

  const webhookUrl = `${publicBaseUrl}/api/webhooks/chatops/whatsapp`;

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value);
    if (!value) {
      setAccessToken("");
      setAppSecret("");
      setBusinessAccountId("");
      setGraphApiVersion("v21.0");
      setPhoneNumberId("");
      setVerifyToken("");
      setMappingRows("");
    }
  };

  const steps = [
    <StepMetaApp
      key="meta-app"
      stepNumber={1}
      webhookUrl={webhookUrl}
      verifyToken={verifyToken}
      onVerifyTokenChange={setVerifyToken}
    />,
    <StepCredentials
      key="credentials"
      stepNumber={2}
      accessToken={accessToken}
      appSecret={appSecret}
      businessAccountId={businessAccountId}
      graphApiVersion={graphApiVersion}
      phoneNumberId={phoneNumberId}
      onAccessTokenChange={setAccessToken}
      onAppSecretChange={setAppSecret}
      onBusinessAccountIdChange={setBusinessAccountId}
      onGraphApiVersionChange={setGraphApiVersion}
      onPhoneNumberIdChange={setPhoneNumberId}
    />,
    <StepUserMappings
      key="user-mappings"
      stepNumber={3}
      mappingRows={mappingRows}
      parsedCount={parsedMappings.length}
      onMappingRowsChange={setMappingRows}
    />,
  ];

  const lastStepAction = {
    label: saving ? "Connecting..." : "Connect",
    disabled: saving || !canSave,
    loading: saving,
    onClick: async () => {
      setSaving(true);
      try {
        const body: UpdateWhatsAppChatOpsConfigBody = {
          enabled: true,
          graphApiVersion: graphApiVersion || "v21.0",
          phoneUserMappings: parsedMappings,
          ...(accessToken && { accessToken }),
          ...(appSecret && { appSecret }),
          ...(businessAccountId && { businessAccountId }),
          ...(phoneNumberId && { phoneNumberId }),
          ...(verifyToken && { verifyToken }),
        };
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
      title="Setup WhatsApp"
      description={
        <>
          Connect your {appName} agents to the WhatsApp Cloud API.
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

function StepMetaApp({
  stepNumber,
  webhookUrl,
  verifyToken,
  onVerifyTokenChange,
}: {
  stepNumber: number;
  webhookUrl: string;
  verifyToken: string;
  onVerifyTokenChange: (value: string) => void;
}) {
  return (
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_1.1fr]">
      <StepCard stepNumber={stepNumber} title="Configure Webhook">
        <ol className="space-y-3">
          <li className="flex gap-3 text-sm leading-relaxed">
            <StepNumber>1</StepNumber>
            <span className="pt-0.5">
              Open your Meta app WhatsApp configuration and add this callback
              URL.
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <StepNumber>2</StepNumber>
            <span className="pt-0.5 flex-1">
              Set a verify token and paste the same value here.
              <Input
                type="password"
                value={verifyToken}
                onChange={(event) => onVerifyTokenChange(event.target.value)}
                placeholder="Paste your verify token"
                className="mt-1.5"
              />
            </span>
          </li>
          <li className="flex gap-3 text-sm leading-relaxed">
            <StepNumber>3</StepNumber>
            <span className="pt-0.5">
              Subscribe to the <strong>messages</strong> webhook field.
            </span>
          </li>
        </ol>
      </StepCard>
      <div className="rounded-md border bg-muted/30 p-4">
        <Label className="text-xs text-muted-foreground">Callback URL</Label>
        <div className="mt-2 flex items-center gap-2 rounded-md bg-background p-2">
          <code className="min-w-0 flex-1 break-all text-xs">{webhookUrl}</code>
          <CopyButton text={webhookUrl} />
        </div>
      </div>
    </div>
  );
}

function StepCredentials({
  stepNumber,
  accessToken,
  appSecret,
  businessAccountId,
  graphApiVersion,
  phoneNumberId,
  onAccessTokenChange,
  onAppSecretChange,
  onBusinessAccountIdChange,
  onGraphApiVersionChange,
  onPhoneNumberIdChange,
}: {
  stepNumber: number;
  accessToken: string;
  appSecret: string;
  businessAccountId: string;
  graphApiVersion: string;
  phoneNumberId: string;
  onAccessTokenChange: (value: string) => void;
  onAppSecretChange: (value: string) => void;
  onBusinessAccountIdChange: (value: string) => void;
  onGraphApiVersionChange: (value: string) => void;
  onPhoneNumberIdChange: (value: string) => void;
}) {
  return (
    <StepCard stepNumber={stepNumber} title="Add Cloud API Credentials">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="System User Access Token">
          <Input
            type="password"
            value={accessToken}
            onChange={(event) => onAccessTokenChange(event.target.value)}
            placeholder="Paste your access token"
          />
        </Field>
        <Field label="App Secret">
          <Input
            type="password"
            value={appSecret}
            onChange={(event) => onAppSecretChange(event.target.value)}
            placeholder="Paste your app secret"
          />
        </Field>
        <Field label="Phone Number ID">
          <Input
            value={phoneNumberId}
            onChange={(event) => onPhoneNumberIdChange(event.target.value)}
            placeholder="Meta phone number ID"
          />
        </Field>
        <Field label="Business Account ID">
          <Input
            value={businessAccountId}
            onChange={(event) => onBusinessAccountIdChange(event.target.value)}
            placeholder="Optional WABA ID"
          />
        </Field>
        <Field label="Graph API Version">
          <Input
            value={graphApiVersion}
            onChange={(event) => onGraphApiVersionChange(event.target.value)}
            placeholder="v21.0"
          />
        </Field>
      </div>
    </StepCard>
  );
}

function StepUserMappings({
  stepNumber,
  mappingRows,
  parsedCount,
  onMappingRowsChange,
}: {
  stepNumber: number;
  mappingRows: string;
  parsedCount: number;
  onMappingRowsChange: (value: string) => void;
}) {
  return (
    <StepCard stepNumber={stepNumber} title="Map WhatsApp Users">
      <div className="space-y-2">
        <Label htmlFor="whatsapp-phone-user-mappings">
          Phone to Archestra email
        </Label>
        <Textarea
          id="whatsapp-phone-user-mappings"
          value={mappingRows}
          onChange={(event) => onMappingRowsChange(event.target.value)}
          placeholder="+15551234567=user@example.com"
          className="min-h-40 font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          One mapping per line. WhatsApp sender phones are matched using digits
          only.
        </p>
        <p className="text-xs text-muted-foreground">
          {parsedCount} valid mapping{parsedCount === 1 ? "" : "s"} ready.
        </p>
      </div>
    </StepCard>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {React.isValidElement(children)
        ? React.cloneElement(children, { id } as { id: string })
        : children}
    </div>
  );
}

function StepNumber({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
      {children}
    </span>
  );
}

function parseMappingRows(raw: string): PhoneUserMapping[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const separatorIndex = line.search(/[=,]/);
      if (separatorIndex === -1) return [];
      const phoneNumber = line.slice(0, separatorIndex).trim();
      const email = line
        .slice(separatorIndex + 1)
        .trim()
        .toLowerCase();
      if (!phoneNumber || !email.includes("@")) return [];
      return [{ phoneNumber, email }];
    });
}

function formatMappings(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        !("phoneNumber" in item) ||
        !("email" in item)
      ) {
        return [];
      }
      return `${String(item.phoneNumber)}=${String(item.email)}`;
    })
    .join("\n");
}
