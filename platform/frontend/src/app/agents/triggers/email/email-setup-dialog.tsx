"use client";

import { ExternalLink, Mail, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { SetupDialog } from "@/components/setup-dialog";
import { StepCard } from "@/components/step-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useIncomingEmailStatus,
  useSetupIncomingEmailWebhook,
} from "@/lib/chatops/incoming-email.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  formatIncomingEmailExpiry,
  getIncomingEmailTimeUntilExpiry,
  getIncomingEmailWebhookUrl,
} from "./email-trigger.utils";

interface EmailSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  emailDomain?: string;
  publicBaseUrl: string;
  providerLabel?: string;
}

export function EmailSetupDialog({
  open,
  onOpenChange,
  emailDomain,
  publicBaseUrl,
  providerLabel,
}: EmailSetupDialogProps) {
  const appName = useAppName();
  const docsUrl = getFrontendDocsUrl("platform-agent-triggers-email");
  const { data: status } = useIncomingEmailStatus();
  const setupMutation = useSetupIncomingEmailWebhook();
  const [webhookUrl, setWebhookUrl] = useState("");

  const defaultWebhookUrl = useMemo(
    () => getIncomingEmailWebhookUrl(publicBaseUrl),
    [publicBaseUrl],
  );

  useEffect(() => {
    if (!open) return;
    setWebhookUrl(status?.subscription?.webhookUrl ?? defaultWebhookUrl);
  }, [defaultWebhookUrl, open, status?.subscription?.webhookUrl]);

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setWebhookUrl(status?.subscription?.webhookUrl ?? defaultWebhookUrl);
    }
  };

  const providerName = providerLabel ?? "Microsoft Outlook";
  const hasWebhookUrl = webhookUrl.trim().length > 0;
  const isConfigured = !!status?.subscription;

  return (
    <SetupDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={isConfigured ? "Reconfigure Email" : "Setup Email"}
      description={
        <>
          Follow these steps to route incoming email through {appName}.
          {docsUrl && (
            <>
              {" "}
              Find out more in our{" "}
              <a
                href={docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline hover:no-underline"
              >
                documentation
              </a>
              .
            </>
          )}
        </>
      }
      canProceed={(step) => (step === 1 ? hasWebhookUrl : true)}
      lastStepAction={{
        label: setupMutation.isPending
          ? isConfigured
            ? "Updating..."
            : "Activating..."
          : isConfigured
            ? "Update subscription"
            : "Activate subscription",
        disabled: setupMutation.isPending || !hasWebhookUrl,
        loading: setupMutation.isPending,
        onClick: async () => {
          const result = await setupMutation.mutateAsync(webhookUrl.trim());
          if (result?.success) {
            handleOpenChange(false);
          }
        },
      }}
      steps={[
        <div
          key="overview"
          className="grid flex-1 gap-4"
          style={{ gridTemplateColumns: "1fr 1fr" }}
        >
          <StepCard
            stepNumber={1}
            title={`Review your ${providerName} mailbox setup`}
          >
            <ol className="space-y-3">
              <li className="flex gap-3 text-sm leading-relaxed">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  1
                </span>
                <span className="pt-0.5">
                  Archestra watches a shared mailbox and maps each alias to a
                  specific agent.
                </span>
              </li>
              <li className="flex gap-3 text-sm leading-relaxed">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  2
                </span>
                <span className="pt-0.5">
                  Microsoft Graph sends webhook notifications whenever new mail
                  arrives.
                </span>
              </li>
              <li className="flex gap-3 text-sm leading-relaxed">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  3
                </span>
                <span className="pt-0.5">
                  Archestra extracts the agent alias, runs the agent, and can
                  optionally reply by email.
                </span>
              </li>
            </ol>
          </StepCard>
          <StepCard stepNumber={1} title="What this page configures">
            <div className="space-y-3 text-sm text-muted-foreground">
              <div className="rounded-lg border bg-background px-3 py-3">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  <Mail className="h-4 w-4" />
                  Mailbox domain
                </div>
                <p className="mt-1">
                  {emailDomain ? `@${emailDomain}` : "Configured in deployment"}
                </p>
              </div>
              <div className="rounded-lg border bg-background px-3 py-3">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  <ShieldCheck className="h-4 w-4" />
                  Subscription lifecycle
                </div>
                <p className="mt-1">
                  Microsoft Graph subscriptions expire every 3 days. Archestra
                  renews them automatically before expiration.
                </p>
              </div>
            </div>
          </StepCard>
        </div>,
        <div
          key="webhook"
          className="grid flex-1 gap-4"
          style={{ gridTemplateColumns: "1fr 1fr" }}
        >
          <StepCard stepNumber={2} title="Enter your public webhook URL">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="incoming-email-webhook-url">Webhook URL</Label>
                <Input
                  id="incoming-email-webhook-url"
                  value={webhookUrl}
                  onChange={(event) => setWebhookUrl(event.target.value)}
                  placeholder={defaultWebhookUrl}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Microsoft Graph must be able to reach this endpoint from the
                public Internet. For local development, use a tunnel such as
                ngrok.
              </p>
            </div>
          </StepCard>
          <StepCard stepNumber={2} title="Use this exact endpoint">
            <div className="space-y-3">
              <div className="relative rounded-lg border bg-background p-3 pr-12 text-sm">
                <code className="break-all">{defaultWebhookUrl}</code>
                <div className="absolute right-3 top-3">
                  <CopyButton text={defaultWebhookUrl} />
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                If your external URL differs from the current app URL, paste
                that public endpoint on the left before continuing.
              </p>
            </div>
          </StepCard>
        </div>,
        <div
          key="confirm"
          className="grid flex-1 gap-4"
          style={{ gridTemplateColumns: "1fr 1fr" }}
        >
          <StepCard
            stepNumber={3}
            title={
              isConfigured
                ? "Review the current subscription"
                : "Confirm and activate"
            }
          >
            <div className="space-y-3 text-sm">
              <div className="rounded-lg border bg-background px-3 py-3">
                <div className="font-medium">Webhook target</div>
                <p className="mt-1 break-all text-muted-foreground">
                  {webhookUrl.trim() || defaultWebhookUrl}
                </p>
              </div>
              <div className="rounded-lg border bg-background px-3 py-3">
                <div className="font-medium">Provider</div>
                <p className="mt-1 text-muted-foreground">{providerName}</p>
              </div>
              <div className="rounded-lg border bg-background px-3 py-3">
                <div className="font-medium">Mailbox domain</div>
                <p className="mt-1 text-muted-foreground">
                  {emailDomain ? `@${emailDomain}` : "Configured in deployment"}
                </p>
              </div>
            </div>
          </StepCard>
          <StepCard stepNumber={3} title="Current status">
            {status?.subscription ? (
              <div className="space-y-3 text-sm">
                <div className="rounded-lg border bg-background px-3 py-3">
                  <div className="font-medium">Subscription ID</div>
                  <p className="mt-1 break-all text-muted-foreground">
                    {status.subscription.subscriptionId}
                  </p>
                </div>
                <div className="rounded-lg border bg-background px-3 py-3">
                  <div className="font-medium">Expiry</div>
                  <p className="mt-1 text-muted-foreground">
                    {formatIncomingEmailExpiry(status.subscription.expiresAt)} (
                    {getIncomingEmailTimeUntilExpiry(
                      status.subscription.expiresAt,
                    )}
                    )
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>
                  No webhook subscription exists yet. Activating this setup will
                  create one immediately.
                </p>
                <a
                  href={docsUrl ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline hover:no-underline"
                >
                  Review the email trigger documentation
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
            {setupMutation.isPending && (
              <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Saving subscription details...
              </div>
            )}
          </StepCard>
        </div>,
      ]}
    />
  );
}
