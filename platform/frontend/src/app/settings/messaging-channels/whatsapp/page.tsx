"use client";

import { MESSAGING_CHANNEL_LABELS } from "@archestra/shared";
import { Info } from "lucide-react";
import { useState } from "react";
import { WhatsAppSetupDialog } from "@/components/whatsapp-setup-dialog";
import { useChatOpsStatus } from "@/lib/chatops/chatops.query";
import { useWhatsAppChatOpsConfig } from "@/lib/chatops/chatops-config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { CredentialField } from "../_parts/credential-field";
import { LlmKeySetupStep } from "../_parts/llm-key-setup-step";
import { ProviderChannels } from "../_parts/provider-channels";
import { SetupSection } from "../_parts/setup-section";
import { SetupStep } from "../_parts/setup-step";
import { useTriggerStatuses } from "../_parts/use-trigger-statuses";

export default function WhatsAppPage() {
  const appName = useAppName();
  const [setupOpen, setSetupOpen] = useState(false);

  const { data: chatOpsProviders, isLoading: statusLoading } =
    useChatOpsStatus();
  const { data: whatsappConfig } = useWhatsAppChatOpsConfig();
  const whatsapp = chatOpsProviders?.find((p) => p.id === "whatsapp");
  const {
    whatsapp: allStepsCompleted,
    whatsappAvailable,
    isLoading: statusesLoading,
  } = useTriggerStatuses();
  const channelLabel = MESSAGING_CHANNEL_LABELS.whatsapp;

  if (!statusesLoading && !whatsappAvailable) {
    return (
      <div className="flex items-start gap-3 rounded-lg border px-4 py-3">
        <Info className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
        <span className="text-sm text-muted-foreground">
          The WhatsApp integration is disabled on this deployment (
          <code className="bg-muted px-1 py-0.5 rounded text-xs">
            ARCHESTRA_CHATOPS_WHATSAPP_ENABLED=false
          </code>
          ). Remove the flag and restart to use it.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <SetupSection
        allStepsCompleted={allStepsCompleted}
        isLoading={statusLoading}
        providerLabel={channelLabel}
        docsUrl={getFrontendDocsUrl("agents/triggers-and-channels/whatsapp")}
      >
        <LlmKeySetupStep />
        <SetupStep
          title="Setup WhatsApp"
          description={`Connect your Meta WhatsApp Cloud API phone number and webhook to ${appName}.`}
          done={!!whatsapp?.configured}
          ctaLabel="Setup WhatsApp"
          onAction={() => setSetupOpen(true)}
          doneActionLabel="Reconfigure"
          onDoneAction={() => setSetupOpen(true)}
        >
          <div className="flex items-center flex-wrap gap-4">
            <CredentialField
              label="Phone Number ID"
              value={whatsapp?.credentials?.phoneNumberId}
            />
            <CredentialField
              label="Access Token"
              value={whatsapp?.credentials?.accessToken}
            />
            <CredentialField
              label="Verify Token"
              value={whatsapp?.credentials?.verifyToken}
            />
            <CredentialField
              label="App Secret"
              value={whatsapp?.credentials?.appSecret}
            />
          </div>
          {whatsappConfig?.webhookUrl && (
            <div className="mt-2 text-xs text-muted-foreground">
              Webhook URL:{" "}
              <code className="bg-muted px-1.5 py-0.5 rounded">
                {whatsappConfig.webhookUrl}
              </code>
            </div>
          )}
        </SetupStep>
      </SetupSection>

      {whatsapp?.configured && <ProviderChannels provider="whatsapp" />}

      <WhatsAppSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        webhookUrl={whatsappConfig?.webhookUrl}
      />
    </div>
  );
}
