"use client";

import { getSubscriptionPickerOptionTestId } from "@archestra/shared";
import { CheckCircle2, Pencil } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";
import { Button } from "@/components/ui/button";
import { UseSubscriptionDialog } from "@/components/use-subscription-dialog";
import type { LlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";
import {
  type SubscriptionEntry,
  type SubscriptionProvider,
  useSubscriptions,
} from "@/lib/subscriptions";

/**
 * The three subscriptions as first-class entities, above the API keys table.
 *
 * A subscription is not a credential the organization owns — it is one person's
 * plan. This panel therefore always shows the viewer's *own* connection state
 * for all three, connected or not, so "I have no model" and "I never signed in"
 * stop looking like the same problem.
 */
export function SubscriptionsPanel({
  keys,
  onDisconnect,
  onEdit,
}: {
  keys: LlmProviderApiKey[];
  /** Opens the existing delete confirmation for the backing key. */
  onDisconnect: (key: LlmProviderApiKey) => void;
  /** Opens the rename-only "Edit Subscription" dialog for the backing key. */
  onEdit?: (key: LlmProviderApiKey) => void;
}) {
  const subscriptions = useSubscriptions(keys);
  const [signInProvider, setSignInProvider] =
    useState<SubscriptionProvider | null>(null);

  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-medium">Subscriptions</h2>
        <p className="text-sm text-muted-foreground">
          Plans you already pay for. Each person signs in with their own account
          — a subscription is never shared across the organization.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {subscriptions.map((entry) => (
          <SubscriptionCard
            key={entry.provider}
            entry={entry}
            onSignIn={() => setSignInProvider(entry.provider)}
            onEdit={
              onEdit
                ? () => {
                    const backingKey = keys.find(
                      (key) => key.id === entry.apiKeyId,
                    );
                    if (backingKey) onEdit(backingKey);
                  }
                : undefined
            }
            onDisconnect={() => {
              const backingKey = keys.find((key) => key.id === entry.apiKeyId);
              if (backingKey) onDisconnect(backingKey);
            }}
          />
        ))}
      </div>
      {signInProvider && (
        <UseSubscriptionDialog
          open
          onOpenChange={(next) => {
            if (!next) setSignInProvider(null);
          }}
          providers={[signInProvider]}
          title="Sign in to your subscription"
          description="Connect your own account. Usage counts against your plan, not the organization's."
        />
      )}
    </section>
  );
}

function SubscriptionCard({
  entry,
  onSignIn,
  onEdit,
  onDisconnect,
}: {
  entry: SubscriptionEntry;
  onSignIn: () => void;
  /** Renaming is the only editable field — the credential itself is re-minted
      by signing in again, never edited in place. Omitted hides the affordance. */
  onEdit?: () => void;
  onDisconnect: () => void;
}) {
  const config = PROVIDER_CONFIG[entry.provider];

  return (
    <div
      data-testid={getSubscriptionPickerOptionTestId(entry.provider)}
      className="flex flex-col gap-3 rounded-lg border p-3"
    >
      <div className="flex items-start gap-2">
        <Image
          src={config.icon}
          alt={entry.title}
          width={20}
          height={20}
          className="mt-0.5 shrink-0 rounded dark:invert"
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{entry.title}</p>
          <p className="text-xs text-muted-foreground">{entry.subtitle}</p>
        </div>
      </div>
      <div className="mt-auto">
        {entry.connected ? (
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-green-600 dark:text-green-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Connected
            </span>
            <div className="flex items-center gap-1">
              {onEdit && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Rename ${entry.title}`}
                  onClick={onEdit}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={onDisconnect}>
                Disconnect
              </Button>
            </div>
          </div>
        ) : entry.signInUnavailable ? (
          <p className="text-xs text-muted-foreground">
            Not enabled by your administrator
          </p>
        ) : (
          <Button variant="outline" size="sm" onClick={onSignIn}>
            Sign in
          </Button>
        )}
      </div>
    </div>
  );
}
