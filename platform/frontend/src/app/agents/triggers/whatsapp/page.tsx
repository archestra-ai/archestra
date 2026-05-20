"use client";

import { Info } from "lucide-react";
import { useState } from "react";
import Divider from "@/components/divider";
import { WhatsAppSetupDialog } from "@/components/whatsapp-setup-dialog";
import { useChatOpsStatus } from "@/lib/chatops/chatops.query";
import config from "@/lib/config/config";
import { useConfig, usePublicBaseUrl } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { ChannelsSection } from "../_components/channels-section";
import { CollapsibleSetupSection } from "../_components/collapsible-setup-section";
import { CredentialField } from "../_components/credential-field";
import { LlmKeySetupStep } from "../_components/llm-key-setup-step";
import { SetupStep } from "../_components/setup-step";
import type { ProviderConfig } from "../_components/types";
import { useTriggerStatuses } from "../_components/use-trigger-statuses";

const whatsAppProviderConfig: ProviderConfig = {
  provider: "whatsapp",
  providerLabel: "WhatsApp",
  providerIcon: "/icons/whatsapp.svg",
  resourceLabelPlural: "Conversations",
  resourceLabelSingular: "Conversation",
  resourceSetupText:
    "WhatsApp conversations appear after a mapped user sends the first message to the connected business phone number.",
  webhookPath: "/api/webhooks/chatops/whatsapp",
  docsUrl: getFrontendDocsUrl("platform-whatsapp"),
  buildDeepLink: (binding) => {
    const phone = binding.channelId.replace(/\D/g, "");
    return phone ? `https://wa.me/${phone}` : "https://web.whatsapp.com";
  },
};

export default function WhatsAppPage() {
  const appName = useAppName();
  const publicBaseUrl = usePublicBaseUrl();
  const [setupOpen, setSetupOpen] = useState(false);
  const { data: configData, isLoading: featuresLoading } = useConfig();
  const { data: chatOpsProviders, isLoading: statusLoading } =
    useChatOpsStatus();
  const { whatsapp: allStepsCompleted } = useTriggerStatuses();

  const ngrokDomain = configData?.features.ngrokDomain;
  const isLocalDev =
    configData?.features.isQuickstart || config.environment === "development";
  const whatsApp = chatOpsProviders?.find((p) => String(p.id) === "whatsapp");
  const whatsAppCreds = whatsApp?.credentials as
    | {
        accessToken?: string;
        appSecret?: string;
        businessAccountId?: string;
        graphApiVersion?: string;
        phoneNumberId?: string;
        phoneUserMappings?: unknown[];
        verifyToken?: string;
      }
    | undefined;
  const mappingCount = whatsAppCreds?.phoneUserMappings?.length ?? 0;
  const setupDataLoading = featuresLoading || statusLoading;

  return (
    <div className="flex flex-col gap-4">
      <CollapsibleSetupSection
        allStepsCompleted={allStepsCompleted}
        isLoading={setupDataLoading}
        providerLabel="WhatsApp"
        docsUrl={getFrontendDocsUrl("platform-whatsapp")}
      >
        <div className="flex items-start gap-3 rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-3">
          <Info className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1">
            <span className="font-medium text-sm">
              {appName}'s webhook must be reachable from Meta
            </span>
            <span className="text-muted-foreground text-xs">
              Configure Meta with{" "}
              <code className="bg-muted px-1 py-0.5 rounded text-xs">
                GET/POST {`${publicBaseUrl}/api/webhooks/chatops/whatsapp`}
              </code>
              {isLocalDev && !ngrokDomain
                ? " and expose this instance with ngrok or a public URL."
                : "."}
            </span>
            {isLocalDev && ngrokDomain ? (
              <span className="text-muted-foreground text-xs">
                Ngrok domain{" "}
                <code className="bg-muted px-1 py-0.5 rounded">
                  {ngrokDomain}
                </code>{" "}
                is configured.
              </span>
            ) : null}
          </div>
        </div>
        <LlmKeySetupStep />
        <SetupStep
          title="Setup WhatsApp"
          description={`Connect a WhatsApp Cloud API phone number to ${appName}`}
          done={!!whatsApp?.configured && mappingCount > 0}
          ctaLabel="Setup WhatsApp"
          onAction={() => setSetupOpen(true)}
          doneActionLabel="Reconfigure"
          onDoneAction={() => setSetupOpen(true)}
        >
          <div className="flex items-center flex-wrap gap-4">
            <CredentialField
              label="Access Token"
              value={whatsAppCreds?.accessToken}
            />
            <CredentialField
              label="App Secret"
              value={whatsAppCreds?.appSecret}
            />
            <CredentialField
              label="Phone Number ID"
              value={whatsAppCreds?.phoneNumberId}
            />
            <CredentialField
              label="Business Account ID"
              value={whatsAppCreds?.businessAccountId}
              optional
            />
            <CredentialField
              label="Graph API"
              value={whatsAppCreds?.graphApiVersion}
            />
            <CredentialField
              label="Verify Token"
              value={whatsAppCreds?.verifyToken}
            />
            <CredentialField
              label="User Mappings"
              value={mappingCount ? `${mappingCount}` : ""}
            />
          </div>
        </SetupStep>
      </CollapsibleSetupSection>

      {allStepsCompleted && (
        <>
          <Divider />
          <ChannelsSection providerConfig={whatsAppProviderConfig} />
        </>
      )}

      <WhatsAppSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
    </div>
  );
}
