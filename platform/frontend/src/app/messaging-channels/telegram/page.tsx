"use client";
import { Info } from "lucide-react";
import { useState } from "react";
import Divider from "@/components/divider";
import { TelegramSetupDialog } from "@/components/telegram-setup-dialog";
import { useChatOpsStatus } from "@/lib/chatops/chatops.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { ChannelsSection } from "../_components/channels-section";
import { CollapsibleSetupSection } from "../_components/collapsible-setup-section";
import { CredentialField } from "../_components/credential-field";
import { LlmKeySetupStep } from "../_components/llm-key-setup-step";
import { SetupStep } from "../_components/setup-step";
import type { ProviderConfig } from "../_components/types";
import { useTriggerStatuses } from "../_components/use-trigger-statuses";

const telegramProviderConfig: ProviderConfig = {
  provider: "telegram",
  providerLabel: "Telegram",
  providerIcon: "/icons/telegram.png",
  docsUrl: getFrontendDocsUrl("platform-telegram"),
  slashCommand: "/select-agent",
  // Telegram has no universal web link for private groups.
  buildDeepLink: () => null,
  getDmDeepLink: (providerStatus, binding) => {
    const botUsername = providerStatus.dmInfo?.botUsername;
    if (!botUsername || !binding) return null;
    // A pending binding's UUID doubles as the one-time account-linking code:
    // opening the link sends "/start <bindingId>" to the bot, which ties this
    // Telegram account to the user's email.
    if (binding.channelId.startsWith("dm:pending:")) {
      return `https://t.me/${botUsername}?start=${binding.id}`;
    }
    return `https://t.me/${botUsername}`;
  },
};

export default function TelegramPage() {
  const appName = useAppName();
  const [setupOpen, setSetupOpen] = useState(false);

  const { data: chatOpsProviders, isLoading: statusLoading } =
    useChatOpsStatus();
  const telegram = chatOpsProviders?.find((p) => p.id === "telegram");
  const {
    telegram: allStepsCompleted,
    telegramAvailable,
    isLoading: statusesLoading,
  } = useTriggerStatuses();

  // Feature-flagged: hidden from the nav, and a direct visit explains why
  if (!statusesLoading && !telegramAvailable) {
    return (
      <div className="flex items-start gap-3 rounded-lg border px-4 py-3">
        <Info className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
        <span className="text-sm text-muted-foreground">
          The Telegram integration is not enabled on this deployment. Set{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-xs">
            ARCHESTRA_CHATOPS_TELEGRAM_ENABLED=true
          </code>{" "}
          and restart to use it.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <CollapsibleSetupSection
        allStepsCompleted={allStepsCompleted}
        isLoading={statusLoading}
        providerLabel="Telegram"
        docsUrl={getFrontendDocsUrl("platform-telegram")}
      >
        <LlmKeySetupStep />
        <SetupStep
          title="Setup Telegram"
          description={`Create a bot with @BotFather and connect it to ${appName}. ${appName} polls Telegram — no public URL needed.`}
          done={!!telegram?.configured}
          ctaLabel="Setup Telegram"
          onAction={() => setSetupOpen(true)}
          doneActionLabel="Reconfigure"
          onDoneAction={() => setSetupOpen(true)}
        >
          <div className="flex items-center flex-wrap gap-4">
            <CredentialField
              label="Bot Token"
              value={telegram?.credentials?.botToken}
            />
          </div>
        </SetupStep>
        <div className="flex items-start gap-3 rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-3">
          <Info className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1">
            <span className="font-medium text-sm">
              Telegram accounts must be linked
            </span>
            <span className="text-muted-foreground text-xs">
              Telegram doesn't share email addresses, so each user links their
              account once: assign an agent to your Direct Message row below,
              then open the generated t.me link and tap Start. Group members
              must link their own DM the same way before the bot answers them.
            </span>
          </div>
        </div>
      </CollapsibleSetupSection>

      {allStepsCompleted && (
        <>
          <Divider />
          <ChannelsSection providerConfig={telegramProviderConfig} />
        </>
      )}

      <TelegramSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
    </div>
  );
}
