"use client";

import {
  SUBSCRIPTION_CREDENTIALS,
  type SupportedProvider,
  subscriptionKindForProvider,
  subscriptionKindFromKeyMetadata,
} from "@archestra/shared";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { SubscriptionSignIn } from "@/components/subscription-sign-in";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  useAvailableLlmProviderApiKeys,
  useCreateLlmProviderApiKey,
  useReconnectLlmProviderApiKey,
} from "@/lib/llm-provider-api-keys.query";
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
  const reconnectKey = useReconnectLlmProviderApiKey();
  // Read defensively: suites that render this card mock the auth query module
  // wholesale, and the card should fall back to the create path rather than
  // crash (same convention as `model-providers/page.tsx`).
  const currentUserId = useSession()?.data?.user?.id;
  const isPreflight = variant === "preflight";
  // An auth-required error only ever names a provider that carries a
  // subscription — `openai` reaches here solely through its credential-level
  // ChatGPT mode, since the provider itself is not per-user. Anything else
  // falls back to the Model Providers link.
  const subscriptionKind = subscriptionKindForProvider(provider);
  const byosEnabled = useFeature("byosEnabled") === true;
  // The user's existing personal key for this subscription, if any. A sign-in
  // then RECONNECTS that key in place instead of minting a duplicate row: the
  // card most often appears because an existing key's sign-in expired, and a
  // second row would leave conversations pinned to the dead one still failing.
  const { data: availableKeys = [] } = useAvailableLlmProviderApiKeys({
    provider,
    enabled: subscriptionKind !== null,
    toastOnError: false,
  });
  const existingSubscriptionKey = subscriptionKind
    ? availableKeys
        .filter(
          (key) =>
            key.scope === "personal" &&
            currentUserId !== undefined &&
            key.userId === currentUserId &&
            key.provider === provider &&
            (SUBSCRIPTION_CREDENTIALS[subscriptionKind].marker === null ||
              subscriptionKindFromKeyMetadata(key) === subscriptionKind),
        )
        // Mirror backend key resolution (isPrimary first, then oldest) so the
        // row that gets reconnected is the one resolution will actually pick.
        .sort(
          (a, b) =>
            Number(b.isPrimary) - Number(a.isPrimary) ||
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        )[0]
    : undefined;

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
              secret storage, or choose an agent/model that does not require
              this exact personal subscription.
            </div>
          ) : subscriptionKind ? (
            <SubscriptionSignIn
              kind={subscriptionKind}
              disabled={createKey.isPending || reconnectKey.isPending}
              onSecret={async (secret) => {
                const { label } = SUBSCRIPTION_CREDENTIALS[subscriptionKind];
                // The mutation hooks surface provider/validation failures. Let
                // a rejected promise reach the device-flow component so it
                // resets to a retryable state instead of claiming success.
                if (existingSubscriptionKey) {
                  await reconnectKey.mutateAsync({
                    id: existingSubscriptionKey.id,
                    apiKey: secret,
                  });
                } else {
                  await createKey.mutateAsync({
                    name: label,
                    provider,
                    apiKey: secret,
                    scope: "personal",
                  });
                }
                toast.success(
                  isPreflight
                    ? `${label} connected`
                    : `${label} connected — retrying…`,
                );
                // Re-run the original prompt now that the key works; both
                // mutations already invalidated the model/key caches.
                onConnected?.();
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
