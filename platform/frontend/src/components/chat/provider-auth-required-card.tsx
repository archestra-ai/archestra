"use client";

import {
  SUBSCRIPTION_CREDENTIALS,
  type SupportedProvider,
  subscriptionKindForProvider,
} from "@archestra/shared";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { SubscriptionSignIn } from "@/components/subscription-sign-in";
import { Button } from "@/components/ui/button";
import { useFeature } from "@/lib/config/config.query";
import { useCreateLlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";
import { cn } from "@/lib/utils";

interface ProviderAuthRequiredCardProps {
  provider: SupportedProvider;
  providerLabel: string;
  agentName?: string;
  variant?: "error" | "preflight";
  /**
   * Called once the user has connected their account (the personal key was
   * created). The chat uses this to auto-resend the original prompt so the user
   * doesn't have to retype it.
   */
  onConnected?: () => void;
}

/**
 * Lets users connect a required personal subscription inline via that
 * subscription's device-flow sign-in, resolved from the shared subscription
 * registry. Used proactively above the composer and as the fallback for a
 * ProviderAuthRequired error in the message stream.
 */
export function ProviderAuthRequiredCard({
  provider,
  providerLabel,
  agentName,
  variant = "error",
  onConnected,
}: ProviderAuthRequiredCardProps) {
  const createKey = useCreateLlmProviderApiKey();
  const isPreflight = variant === "preflight";
  // An auth-required error only ever names a provider that carries a
  // subscription — `openai` reaches here solely through its credential-level
  // ChatGPT mode, since the provider itself is not per-user. Anything else
  // falls back to the Model Providers link.
  const subscriptionKind = subscriptionKindForProvider(provider);
  const byosEnabled = useFeature("byosEnabled") === true;

  return (
    <div
      className={cn(
        "rounded-lg border border-amber-500/30 bg-amber-500/5 p-4",
        !isPreflight && "my-2",
      )}
    >
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div className="space-y-2">
          <div>
            <p className="font-medium text-sm">
              Connect {providerLabel}
              {isPreflight && agentName ? ` to use ${agentName}` : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              {isPreflight
                ? `This agent uses a personal ${providerLabel} subscription. Connect your own account before sending a message; your account is never shared with other users.`
                : `${providerLabel} is per-user — connect your own account to use this model, then send your message again.`}
            </p>
          </div>

          {subscriptionKind && byosEnabled ? (
            <div
              role="alert"
              className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
            >
              Subscription sign-in is unavailable because this deployment uses a
              read-only external Vault. Ask an administrator to use managed
              secret storage
              {SUBSCRIPTION_CREDENTIALS[subscriptionKind].marker !== null
                ? ", or connect a provider API key from Vault instead."
                : "."}
            </div>
          ) : subscriptionKind ? (
            <SubscriptionSignIn
              kind={subscriptionKind}
              disabled={createKey.isPending}
              onSecret={async (secret) => {
                const { label } = SUBSCRIPTION_CREDENTIALS[subscriptionKind];
                try {
                  await createKey.mutateAsync({
                    name: label,
                    provider,
                    apiKey: secret,
                    scope: "personal",
                  });
                  toast.success(
                    isPreflight
                      ? `${label} connected`
                      : `${label} connected — retrying…`,
                  );
                  // Re-run the original prompt now that the key exists; the
                  // create mutation already invalidated the model/key caches.
                  onConnected?.();
                } catch {
                  // handleApiError already surfaced the failure (e.g. no seat,
                  // no license, no active subscription)
                }
              }}
            />
          ) : (
            <Button asChild type="button" variant="outline" size="sm">
              <a href="/llm/model-providers">Connect in Model Providers</a>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
