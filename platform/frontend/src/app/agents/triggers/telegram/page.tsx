"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import Divider from "@/components/divider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useChatOpsStatus } from "@/lib/chatops/chatops.query";
import { usePublicBaseUrl } from "@/lib/config/config.query";
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
  webhookPath: "/api/webhooks/chatops/telegram",
  docsUrl: null,
  slashCommand: "",
  buildDeepLink: (binding) => `https://t.me/${binding.channelId}`,
  getDmDeepLink: () => null,
};

export default function TelegramPage() {
  const publicBaseUrl = usePublicBaseUrl();
  const configuredAppName = useAppName();
  const { data: chatOpsProviders, isLoading: statusLoading } = useChatOpsStatus();

  const [botToken, setBotToken] = useState("");
  const [secretToken, setSecretToken] = useState("");
  const [saving, setSaving] = useState(false);

  // Note: SDK types only include ms-teams and slack until
  // codegen is re-run. We cast to any to read telegram status.
  // biome-ignore lint/suspicious/noExplicitAny: pending codegen
  const telegram = (chatOpsProviders as any[])?.find((p) => p.id === "telegram");

  // biome-ignore lint/suspicious/noExplicitAny: telegram support pending in hook typing
  const { telegram: allStepsCompleted } = useTriggerStatuses() as any;

  async function handleSave() {
    if (!botToken.trim() || !secretToken.trim()) {
      toast.error("Both Bot Token and Secret Token are required");
      return;
    }
    setSaving(true);
    try {
      // Direct fetch  SDK regeneration pending for telegram
      // provider
      const res = await fetch("/api/chatops/config/telegram", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          botToken: botToken.trim(),
          secretToken: secretToken.trim(),
        }),
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      toast.success("Telegram configuration saved");
      setBotToken("");
      setSecretToken("");
    } catch (err) {
      toast.error("Failed to save Telegram configuration");
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <CollapsibleSetupSection
        allStepsCompleted={allStepsCompleted}
        isLoading={statusLoading}
        providerLabel="Telegram"
        docsUrl={null}
      >
        <LlmKeySetupStep />

        <Divider />

        <SetupStep
          title="Create a Telegram Bot"
          description="Get a bot token from @BotFather and configure the webhook"
          done={!!telegram?.configured}
          ctaLabel={telegram?.configured ? undefined : "Enter credentials below"}
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <div className="text-xs text-muted-foreground">
                Webhook URL (register this with @BotFather via setWebhook):
              </div>
              <div className="flex items-center gap-2">
                <code className="bg-muted px-1.5 py-1 rounded text-xs font-mono break-all flex-1">
                  {publicBaseUrl}/api/webhooks/chatops/telegram
                </code>
                <CopyButton
                  text={`${publicBaseUrl}/api/webhooks/chatops/telegram`}
                />
              </div>
            </div>

            {telegram?.configured ? (
              <div className="flex flex-col gap-1">
                <div className="text-xs text-muted-foreground">Credentials:</div>
                <CredentialField
                  label="Bot Token"
                  value={telegram?.credentials?.botToken}
                />
                <CredentialField
                  label="Secret Token"
                  value={telegram?.credentials?.secretToken}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="bot-token" className="text-xs">
                    Bot Token
                  </Label>
                  <Input
                    id="bot-token"
                    type="password"
                    placeholder="1234567890:ABCdef..."
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                  />
                  <span className="text-xs text-muted-foreground">
                    Get this from @BotFather with /newbot
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="secret-token" className="text-xs">
                    Secret Token
                  </Label>
                  <Input
                    id="secret-token"
                    type="password"
                    placeholder="any random string you choose"
                    value={secretToken}
                    onChange={(e) => setSecretToken(e.target.value)}
                  />
                  <span className="text-xs text-muted-foreground">
                    A random string you invent. Telegram will send it as a header
                    on every webhook call so the server can verify requests.
                  </span>
                </div>

                <Button
                  onClick={handleSave}
                  disabled={saving || !botToken || !secretToken}
                  size="sm"
                  className="self-start"
                >
                  {saving ? "Saving..." : "Save Configuration"}
                </Button>
              </div>
            )}
          </div>
        </SetupStep>

        <Divider />

        <SetupStep
          title="Assign Agents to Telegram Chats"
          description="Choose which agents respond in which chats"
          done={allStepsCompleted}
          ctaLabel="Assign agents in channels below"
        >
          <ChannelsSection providerConfig={telegramProviderConfig} />
        </SetupStep>
      </CollapsibleSetupSection>
    </div>
  );
}
