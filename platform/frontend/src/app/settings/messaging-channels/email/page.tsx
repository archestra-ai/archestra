"use client";

import { DocsPage, MESSAGING_CHANNEL_LABELS } from "@archestra/shared";
import { AlertTriangle, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  useDeleteIncomingEmailSubscription,
  useIncomingEmailStatus,
  useRenewIncomingEmailSubscription,
} from "@/lib/chatops/incoming-email.query";
import config from "@/lib/config/config";
import { useConfig, usePublicBaseUrl } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { CredentialField } from "../_components/credential-field";
import { ExternalDocsLink } from "../_components/external-docs-link";
import { SetupSection } from "../_components/setup-section";
import { SetupStep } from "../_components/setup-step";
import { useTriggerStatuses } from "../_components/use-trigger-statuses";
import { EmailSetupDialog } from "./email-setup-dialog";
import {
  formatIncomingEmailExpiry,
  getIncomingEmailTimeUntilExpiry,
} from "./email-trigger.utils";

export default function EmailPage() {
  const appName = useAppName();
  const docsUrl = getFrontendDocsUrl(DocsPage.PlatformAgentTriggersEmail);
  const publicBaseUrl = usePublicBaseUrl();
  const { data: configData, isLoading: featuresLoading } = useConfig();
  const { data: status, isLoading: statusLoading } = useIncomingEmailStatus();
  const renewMutation = useRenewIncomingEmailSubscription();
  const deleteMutation = useDeleteIncomingEmailSubscription();
  const { email: allStepsCompleted } = useTriggerStatuses();
  const channelLabel = MESSAGING_CHANNEL_LABELS.email;

  const [setupOpen, setSetupOpen] = useState(false);

  const isLoading = featuresLoading || statusLoading;
  const emailInfo = configData?.features.incomingEmail;
  const providerEnabled = !!emailInfo?.enabled;
  const isLocalDev =
    configData?.features.isQuickstart || config.environment === "development";

  return (
    <div className="flex flex-col gap-6">
      <SetupSection
        allStepsCompleted={allStepsCompleted}
        isLoading={isLoading}
        providerLabel={channelLabel}
        docsUrl={docsUrl}
      >
        <SetupStep
          title="Configure an incoming mailbox"
          description={`Connect ${appName} to a shared mailbox and provider credentials`}
          done={providerEnabled}
        >
          {providerEnabled ? (
            <div className="flex items-center flex-wrap gap-4">
              <CredentialField
                label="Provider"
                value={emailInfo?.displayName ?? "Configured"}
              />
              <CredentialField
                label="Email domain"
                value={
                  emailInfo?.emailDomain
                    ? `@${emailInfo.emailDomain}`
                    : undefined
                }
              />
            </div>
          ) : (
            <div className="space-y-2">
              <p>
                Incoming email is configured at deployment time. Add the mailbox
                and provider credentials first, then return here to activate the
                webhook subscription and agent email addresses.
              </p>
              <ExternalDocsLink href={docsUrl}>
                Review the email setup guide
              </ExternalDocsLink>
            </div>
          )}
        </SetupStep>

        <SetupStep
          title="Activate the webhook subscription"
          description={`Create or reconfigure the Microsoft Graph subscription that sends new mail events to ${appName}`}
          done={!!status?.isActive}
          ctaLabel={providerEnabled ? "Setup Email" : undefined}
          onAction={providerEnabled ? () => setSetupOpen(true) : undefined}
          doneActionLabel="Reconfigure"
          onDoneAction={providerEnabled ? () => setSetupOpen(true) : undefined}
        >
          {status?.subscription ? (
            <div className="space-y-4">
              <div className="flex items-center flex-wrap gap-4">
                <CredentialField
                  label="Subscription"
                  value={status.subscription.subscriptionId}
                />
                <CredentialField
                  label="Webhook URL"
                  value={status.subscription.webhookUrl}
                />
                <CredentialField
                  label="Expires"
                  value={`${formatIncomingEmailExpiry(status.subscription.expiresAt)} (${getIncomingEmailTimeUntilExpiry(status.subscription.expiresAt)})`}
                />
              </div>

              {!status.isActive && (
                <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
                  <span className="text-xs text-muted-foreground">
                    This subscription has expired. Reconfigure it or renew it to
                    resume email delivery.
                  </span>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <PermissionButton
                  permissions={{ agentTrigger: ["update"] }}
                  variant="outline"
                  onClick={() => renewMutation.mutate()}
                  disabled={renewMutation.isPending}
                >
                  {renewMutation.isPending && (
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  <span>Renew subscription</span>
                </PermissionButton>
                <PermissionButton
                  permissions={{ agentTrigger: ["delete"] }}
                  variant="destructive"
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                >
                  {deleteMutation.isPending && (
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete subscription
                </PermissionButton>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p>
                No active subscription exists yet. Open the setup wizard to add
                the public webhook URL that Microsoft Graph should call when new
                mail arrives.
              </p>
              {isLocalDev && (
                <p className="text-xs">
                  Local development needs a public tunnel such as ngrok so the
                  webhook can be reached from Microsoft Graph.
                </p>
              )}
            </div>
          )}
        </SetupStep>
      </SetupSection>

      <EmailSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        emailDomain={emailInfo?.emailDomain}
        providerLabel={emailInfo?.displayName}
        publicBaseUrl={publicBaseUrl}
      />
    </div>
  );
}
