"use client";
import { Info } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import Divider from "@/components/divider";
import { TelegramSetupDialog } from "@/components/telegram-setup-dialog";
import { Button } from "@/components/ui/button";
import {
  useChatOpsBindings,
  useChatOpsStatus,
} from "@/lib/chatops/chatops.query";
import { useGenerateTelegramLinkCode } from "@/lib/chatops/chatops-config.query";
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
  // The DM binding is created by the account-linking step, not by assigning
  // an agent to a placeholder row.
  showVirtualDmRow: false,
  // Telegram has no universal web link for private groups.
  buildDeepLink: () => null,
  getDmDeepLink: (providerStatus) => {
    const botUsername = providerStatus.dmInfo?.botUsername;
    return botUsername ? `https://t.me/${botUsername}` : null;
  },
};

/**
 * The one interactive step that makes Telegram usable: tie this Telegram
 * account to the signed-in user. Minting a code here and carrying it to the
 * bot in a t.me ?start= deep link means one tap in Telegram finishes the job.
 */
function LinkTelegramAccountStep({ botUsername }: { botUsername?: string }) {
  const generateCode = useGenerateTelegramLinkCode();
  const [link, setLink] = useState<string | null>(null);

  // The user's own DM binding; a non-pending channelId means it's linked.
  const { data: bindingsResponse } = useChatOpsBindings({
    provider: "telegram",
    limit: 50,
    offset: 0,
  });
  const dmBinding = bindingsResponse?.data.find((b) => b.isDm);
  const linked = !!dmBinding && !dmBinding.channelId.startsWith("dm:pending:");

  const handleGenerate = () => {
    generateCode.mutate(undefined, {
      onSuccess: (data) => {
        if (!data) return;
        const url = `https://t.me/${data.botUsername}?start=${data.code}`;
        setLink(url);
        window.open(url, "_blank", "noopener,noreferrer");
      },
    });
  };

  return (
    <SetupStep
      title="Link your Telegram account"
      description={
        linked && dmBinding
          ? `Linked as ${dmBinding.dmOwnerEmail ?? "you"} — message the bot to talk to your agent.`
          : "Telegram doesn't share who you are, so connect your Telegram to your account once. One click here, one tap on Start in Telegram."
      }
      done={linked}
      ctaLabel={generateCode.isPending ? "Preparing…" : "Link Telegram account"}
      onAction={handleGenerate}
      doneActionLabel="Relink"
      onDoneAction={handleGenerate}
    >
      <div className="flex flex-col gap-2">
        {link && !linked && (
          <Button variant="outline" size="sm" className="w-fit" asChild>
            <a href={link} target="_blank" rel="noopener noreferrer">
              <Image
                src="/icons/telegram.png"
                alt="Telegram"
                width={14}
                height={14}
              />
              Open Telegram and press Start
            </a>
          </Button>
        )}
        <span className="text-muted-foreground text-xs">
          Team members without access to this page link themselves: they send
          /start to {botUsername ? `@${botUsername}` : "the bot"} and follow the
          sign-in link it replies with.
        </span>
      </div>
    </SetupStep>
  );
}

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
          (or the beta master switch{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-xs">
            ARCHESTRA_BETA=true
          </code>
          ) and restart to use it.
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
        {telegram?.configured && (
          <LinkTelegramAccountStep
            botUsername={telegram?.dmInfo?.botUsername}
          />
        )}
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
