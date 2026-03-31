"use client";

import { DocsPage } from "@shared";
import { Mail, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { SetupDialog } from "@/components/setup-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useIncomingEmailStatus,
  useSetupIncomingEmailWebhook,
} from "@/lib/chatops/incoming-email.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { ExternalDocsLink } from "../_components/external-docs-link";
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
  const docsUrl = getFrontendDocsUrl(DocsPage.PlatformAgentTriggersEmail);
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
              <ExternalDocsLink
                href={docsUrl}
                className="underline hover:no-underline"
              >
                documentation
              </ExternalDocsLink>
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
          key="setup"
          className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]"
        >
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-4">
              <div className="flex items-center gap-2 text-base font-semibold">
                <Mail className="h-4 w-4" />
                Incoming email flow
              </div>
              <ol className="mt-4 space-y-3">
                <li className="flex gap-3 text-sm leading-relaxed">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background text-xs font-medium">
                    1
                  </span>
                  <span className="pt-0.5">
                    {appName} watches a shared mailbox and maps each alias to a
                    specific agent.
                  </span>
                </li>
                <li className="flex gap-3 text-sm leading-relaxed">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background text-xs font-medium">
                    2
                  </span>
                  <span className="pt-0.5">
                    Microsoft Graph sends webhook notifications whenever new
                    mail arrives.
                  </span>
                </li>
                <li className="flex gap-3 text-sm leading-relaxed">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background text-xs font-medium">
                    3
                  </span>
                  <span className="pt-0.5">
                    {appName} extracts the agent alias, runs the agent, and can
                    optionally reply by email.
                  </span>
                </li>
              </ol>
            </div>

            <div className="rounded-lg border bg-background p-4">
              <div className="space-y-2">
                <Label htmlFor="incoming-email-webhook-url">Webhook URL</Label>
                <Input
                  id="incoming-email-webhook-url"
                  value={webhookUrl}
                  onChange={(event) => setWebhookUrl(event.target.value)}
                  placeholder={defaultWebhookUrl}
                />
              </div>
              <div className="mt-4 space-y-3 text-sm text-muted-foreground">
                <p>
                  Microsoft Graph must be able to reach this endpoint from the
                  public Internet. For local development, use a tunnel such as
                  ngrok.
                </p>
                <div className="relative rounded-lg border bg-muted/30 p-3 pr-12">
                  <code className="break-all">{defaultWebhookUrl}</code>
                  <div className="absolute right-3 top-3">
                    <CopyButton text={defaultWebhookUrl} />
                  </div>
                </div>
                <p>
                  If your external URL differs from the current app URL, paste
                  that public endpoint above before continuing.
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-4">
              <div className="flex items-center gap-2 text-base font-semibold">
                <ShieldCheck className="h-4 w-4" />
                Current configuration
              </div>
              <div className="mt-4 space-y-3 text-sm">
                <div className="rounded-lg border bg-background px-3 py-3">
                  <div className="font-medium">Provider</div>
                  <p className="mt-1 text-muted-foreground">{providerName}</p>
                </div>
                <div className="rounded-lg border bg-background px-3 py-3">
                  <div className="font-medium">Mailbox domain</div>
                  <p className="mt-1 text-muted-foreground">
                    {emailDomain
                      ? `@${emailDomain}`
                      : "Configured in deployment"}
                  </p>
                </div>
                <div className="rounded-lg border bg-background px-3 py-3">
                  <div className="font-medium">Subscription lifecycle</div>
                  <p className="mt-1 text-muted-foreground">
                    Microsoft Graph subscriptions expire every 3 days. {appName}{" "}
                    renews them automatically before expiration.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-lg border bg-background p-4">
              <div className="text-base font-semibold">
                {isConfigured ? "Current status" : "Before you activate"}
              </div>
              {status?.subscription ? (
                <div className="mt-4 space-y-3 text-sm">
                  <div className="rounded-lg border bg-muted/30 px-3 py-3">
                    <div className="font-medium">Subscription ID</div>
                    <p className="mt-1 break-all text-muted-foreground">
                      {status.subscription.subscriptionId}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/30 px-3 py-3">
                    <div className="font-medium">Webhook target</div>
                    <p className="mt-1 break-all text-muted-foreground">
                      {webhookUrl.trim() || defaultWebhookUrl}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/30 px-3 py-3">
                    <div className="font-medium">Expiry</div>
                    <p className="mt-1 text-muted-foreground">
                      {formatIncomingEmailExpiry(status.subscription.expiresAt)}{" "}
                      (
                      {getIncomingEmailTimeUntilExpiry(
                        status.subscription.expiresAt,
                      )}
                      )
                    </p>
                  </div>
                </div>
              ) : (
                <div className="mt-4 space-y-3 text-sm text-muted-foreground">
                  <p>
                    No webhook subscription exists yet. Activating this setup
                    will create one immediately.
                  </p>
                  <ExternalDocsLink
                    href={docsUrl}
                    className="text-sm underline hover:no-underline"
                  >
                    Review the email trigger documentation
                  </ExternalDocsLink>
                </div>
              )}
              {setupMutation.isPending && (
                <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  Saving subscription details...
                </div>
              )}
            </div>
          </div>
        </div>,
      ]}
    />
  );
}
