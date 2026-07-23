"use client";

import {
  DocsPage,
  E2eTestId,
  getDocsUrl,
  getSubscriptionSignInRowTestId,
  type SupportedProvider,
} from "@archestra/shared";
import { CheckCircle2 } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { GithubCopilotSignIn } from "@/components/github-copilot-sign-in";
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";
import { Microsoft365CopilotSignIn } from "@/components/microsoft-365-copilot-sign-in";
import { OpenaiCodexSignIn } from "@/components/openai-codex-sign-in";
import { DialogBody } from "@/components/ui/dialog";
import {
  type LlmProviderApiKey,
  useCreateLlmProviderApiKey,
  useLlmProviderApiKeys,
} from "@/lib/llm-provider-api-keys.query";
import {
  type SubscriptionEntry,
  type SubscriptionProvider,
  useSubscriptions,
} from "@/lib/subscriptions";

/**
 * "Use a subscription" dialog — connect a plan you already pay for instead of
 * pasting an API key. Surfaces the three per-user subscription sign-ins that
 * were previously buried inside the provider=OpenAI key form as three flat
 * rows. Reuses the existing device-flow sign-in components and the standard
 * create-key mutation; no new backend.
 */
export function UseSubscriptionDialog({
  open,
  onOpenChange,
  onConnected,
  providers,
  title = "Use a subscription",
  description = "Connect a plan you already pay for — no API key to create. Each connection is per-user: you sign in with your own account.",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired after each successful connection (e.g. to advance chat onboarding). */
  onConnected?: (apiKeyId: string) => void;
  /** Narrows the dialog to specific subscriptions, for an in-place sign-in CTA. */
  providers?: SubscriptionProvider[];
  title?: string;
  description?: string;
}) {
  const { data: existingKeys = [] } = useLlmProviderApiKeys({ enabled: open });
  const subscriptions = useSubscriptions(existingKeys);
  const visible = providers
    ? subscriptions.filter((entry) => providers.includes(entry.provider))
    : subscriptions;
  // Single-provider dialogs (opened from a subscription card, the key dropdown,
  // the model selector, or chat) show one row, so fetch and display its code +
  // instructions immediately. Multi-provider dialogs keep per-row buttons and
  // must never auto-fetch — showing every provider's code at once is noise.
  const autoStart = visible.length === 1;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="medium"
      title={title}
      description={description}
    >
      <DialogBody
        data-testid={E2eTestId.UseSubscriptionDialog}
        className="flex flex-col gap-3"
      >
        {visible.map((entry) => (
          <SubscriptionRow
            key={entry.provider}
            entry={entry}
            existingKeys={existingKeys}
            onConnected={onConnected}
            autoStart={autoStart}
          />
        ))}
      </DialogBody>
    </FormDialog>
  );
}

function SubscriptionRow({
  entry,
  existingKeys,
  onConnected,
  autoStart,
}: {
  entry: SubscriptionEntry;
  existingKeys: LlmProviderApiKey[];
  onConnected?: (apiKeyId: string) => void;
  /** Auto-run the leaf's fetch step on mount (single-provider dialogs only). */
  autoStart?: boolean;
}) {
  const option = entry;
  const createMutation = useCreateLlmProviderApiKey();
  const [justConnected, setJustConnected] = useState(false);
  const config = PROVIDER_CONFIG[option.provider];
  const signInUnavailable = entry.signInUnavailable;
  // Reopening the dialog must still read as connected, so trust the key list
  // first and fall back to this mount's own successful sign-in.
  const connected = entry.connected || justConnected;

  const handleCredential = async (credential: string) => {
    const hasProviderKey = existingKeys.some(
      (key) => key.provider === option.provider,
    );
    const created = await createMutation
      .mutateAsync({
        provider: option.provider,
        apiKey: credential,
        name: uniqueKeyName(option.keyName, option.provider, existingKeys),
        scope: "personal",
        // First key for this provider becomes primary so a model resolves
        // without extra setup; don't steal primary from an existing key.
        isPrimary: !hasProviderKey,
      })
      .catch(() => null);
    if (created) {
      setJustConnected(true);
      onConnected?.(created.id);
    }
  };

  return (
    <div
      data-testid={getSubscriptionSignInRowTestId(option.provider)}
      className="rounded-lg border p-4"
    >
      <div className="flex items-start gap-3">
        <Image
          src={config.icon}
          alt={option.title}
          width={28}
          height={28}
          className="mt-0.5 rounded dark:invert"
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{option.title}</p>
          <p className="text-sm text-muted-foreground">{option.subtitle}</p>
          <div className="mt-3">
            {connected ? (
              <p className="flex items-center gap-2 text-sm font-medium text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4" />
                Connected — added to Model Providers
              </p>
            ) : signInUnavailable ? (
              <p className="text-sm text-muted-foreground">
                Your administrator hasn't enabled {option.title} sign-in yet.{" "}
                <a
                  href={getDocsUrl(DocsPage.PlatformSupportedLlmProviders)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium underline underline-offset-2 hover:text-foreground"
                >
                  Learn more
                </a>
              </p>
            ) : (
              <SubscriptionSignIn
                provider={option.provider}
                onCredential={handleCredential}
                disabled={createMutation.isPending}
                autoStart={autoStart}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SubscriptionSignIn({
  provider,
  onCredential,
  disabled,
  autoStart,
}: {
  provider: SubscriptionProvider;
  onCredential: (credential: string) => void;
  disabled?: boolean;
  autoStart?: boolean;
}) {
  if (provider === "github-copilot") {
    return (
      <GithubCopilotSignIn
        onToken={onCredential}
        disabled={disabled}
        autoStart={autoStart}
      />
    );
  }
  if (provider === "microsoft-365-copilot") {
    return (
      <Microsoft365CopilotSignIn
        onToken={onCredential}
        disabled={disabled}
        autoStart={autoStart}
      />
    );
  }
  return (
    <OpenaiCodexSignIn
      onCredential={onCredential}
      disabled={disabled}
      autoStart={autoStart}
    />
  );
}

/**
 * Sign-in providers can mint identically-named keys on every reconnect; suffix
 * the default name with a counter when a same-provider key already owns it.
 */
function uniqueKeyName(
  base: string,
  provider: SupportedProvider,
  existingKeys: LlmProviderApiKey[],
): string {
  const taken = new Set(
    existingKeys
      .filter((key) => key.provider === provider)
      .map((key) => key.name),
  );
  let name = base;
  for (let suffix = 2; taken.has(name); suffix++) {
    name = `${base} (${suffix})`;
  }
  return name;
}
