"use client";

import {
  SUBSCRIPTION_CREDENTIALS,
  type SupportedProvider,
  subscriptionKindForProvider,
} from "@archestra/shared";
import { CircleDashed } from "lucide-react";
import { RowClickShield } from "@/components/agent-pages/row-click-shield";
import { ProviderIcon } from "@/components/provider-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function AgentProviderIndicator({
  provider,
  keyName,
  modelName,
  usesOrganizationDefault = false,
  personalSubscription = false,
}: {
  provider?: SupportedProvider | null;
  keyName?: string | null;
  modelName?: string | null;
  usesOrganizationDefault?: boolean;
  /**
   * The agent's runs use each person's own subscription of `provider`
   * unless they choose otherwise: there is no company key to name.
   */
  personalSubscription?: boolean;
}) {
  const subscription = personalSubscription
    ? subscriptionLabel(provider ?? null)
    : null;
  return (
    <RowClickShield className="inline-flex shrink-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard focus reveals the same tooltip as hover without implying a click action
            tabIndex={0}
            className="inline-flex size-8 cursor-help items-center justify-center rounded-md"
            aria-label="Provider and model details"
          >
            {provider ? (
              <ProviderIcon provider={provider} size={18} />
            ) : (
              <CircleDashed className="size-[18px] text-muted-foreground" />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-64 space-y-1.5 px-2.5 py-2 text-left text-xs leading-4"
        >
          {subscription ? (
            <>
              <div>
                <p className="text-muted-foreground">Account</p>
                <p className="break-words font-medium">
                  Each person&apos;s {subscription}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Model</p>
                <p className="break-words font-medium">
                  {modelName || "Each person picks"}
                </p>
              </div>
            </>
          ) : (
            <>
              <div>
                <p className="text-muted-foreground">Provider key</p>
                <p className="break-words font-medium">
                  {usesOrganizationDefault
                    ? "Organization default"
                    : keyName || "No key configured"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Model</p>
                <p className="break-words font-medium">
                  {usesOrganizationDefault
                    ? "Organization default"
                    : modelName || "No model pinned"}
                </p>
              </div>
            </>
          )}
        </TooltipContent>
      </Tooltip>
    </RowClickShield>
  );
}

// ===

/** What a person's own subscription of a provider is called. */
function subscriptionLabel(provider: SupportedProvider | null): string {
  if (provider === "anthropic") return "Claude subscription";
  const kind = provider ? subscriptionKindForProvider(provider) : null;
  return kind ? SUBSCRIPTION_CREDENTIALS[kind].label : "personal subscription";
}
