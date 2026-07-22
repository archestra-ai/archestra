"use client";

import type { SupportedProvider } from "@archestra/shared";
import Image from "next/image";
import type { ReactNode } from "react";
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";
import { OverlappedIcons } from "@/components/ui/overlapped-icons";

/**
 * Two-door "connect a model provider" chooser: paste an API key, or use a
 * subscription. Shared by the Model Providers empty state and the chat/projects
 * first-run screen so both teach the same two paths, each fronted by the real
 * provider logos.
 */
export function ConnectProviderCards({
  onAddKey,
  onUseSubscription,
  addKeyTestId,
  useSubscriptionTestId,
  heading = "Connect a model provider",
  description = "Add a provider so Chat and the LLM Proxy have a model to use.",
}: {
  onAddKey: () => void;
  onUseSubscription: () => void;
  /** Test id for the "Paste an API key" card (varies per surface). */
  addKeyTestId?: string;
  /** Test id for the "Use a subscription" card (varies per surface). */
  useSubscriptionTestId?: string;
  heading?: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-6 py-12 text-center">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{heading}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="grid w-full max-w-2xl gap-4 sm:grid-cols-2">
        <ProviderCard
          icons={API_KEY_ICONS}
          title="Paste an API key"
          description="Bring your own key from OpenAI, Anthropic, Google, and more."
          onClick={onAddKey}
          testId={addKeyTestId}
        />
        <ProviderCard
          icons={SUBSCRIPTION_ICONS}
          title="Use a subscription"
          description="Connect a plan you already pay for — ChatGPT, Copilot, or Microsoft 365."
          onClick={onUseSubscription}
          testId={useSubscriptionTestId}
        />
      </div>
    </div>
  );
}

function ProviderCard({
  icons,
  title,
  description,
  onClick,
  testId,
}: {
  icons: Array<{ key: string; icon: ReactNode; tooltip?: string }>;
  title: string;
  description: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex flex-col items-start gap-3 rounded-lg border p-5 text-left transition-colors hover:border-primary hover:bg-muted/40"
    >
      <OverlappedIcons icons={icons} maxVisible={3} size="md" />
      <span className="font-medium">{title}</span>
      {/* Two-line min-height so a short description reserves the same space as a
          wrapped one, keeping both cards aligned top and bottom. */}
      <span className="min-h-[2.5rem] text-sm text-muted-foreground">
        {description}
      </span>
    </button>
  );
}

function providerIcons(
  providers: SupportedProvider[],
): Array<{ key: string; icon: ReactNode; tooltip: string }> {
  return providers.map((provider) => {
    const config = PROVIDER_CONFIG[provider];
    return {
      key: provider,
      tooltip: config.name,
      // dark:invert matches how provider marks render across the app (table,
      // combobox) so monochrome logos stay visible on a dark surface.
      icon: (
        <Image
          src={config.icon}
          alt=""
          width={12}
          height={12}
          className="dark:invert"
        />
      ),
    };
  });
}

const API_KEY_ICONS = providerIcons(["anthropic", "openai", "gemini"]);
const SUBSCRIPTION_ICONS = providerIcons([
  "openai",
  "github-copilot",
  "microsoft-365-copilot",
]);
