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
import {
  CHATGPT_SUBSCRIPTION_LABEL,
  PROVIDER_CONFIG,
} from "@/components/llm-provider-api-key-form";
import { Microsoft365CopilotSignIn } from "@/components/microsoft-365-copilot-sign-in";
import { OpenaiCodexSignIn } from "@/components/openai-codex-sign-in";
import { DialogBody } from "@/components/ui/dialog";
import { useFeature } from "@/lib/config/config.query";
import {
  type LlmProviderApiKey,
  useCreateLlmProviderApiKey,
  useLlmProviderApiKeys,
} from "@/lib/llm-provider-api-keys.query";

/**
 * Providers wired via a personal subscription sign-in rather than a pasted API
 * key. ChatGPT reuses the `openai` provider (the stored credential is an OAuth
 * blob, not an `sk-` key); Copilot/M365 are their own per-user providers.
 */
type SubscriptionProvider =
  | "openai"
  | "github-copilot"
  | "microsoft-365-copilot";

interface SubscriptionOption {
  provider: SubscriptionProvider;
  title: string;
  subtitle: string;
  /** Default name for the created provider key. */
  keyName: string;
}

// Lead with the differentiators — Microsoft 365 Copilot (rare) and GitHub
// Copilot — then ChatGPT.
const SUBSCRIPTION_OPTIONS: SubscriptionOption[] = [
  {
    provider: "microsoft-365-copilot",
    title: "Microsoft 365 Copilot",
    subtitle: "Uses your Microsoft 365 Copilot license",
    keyName: "Microsoft 365 Copilot",
  },
  {
    provider: "github-copilot",
    title: "GitHub Copilot",
    subtitle: "Uses your GitHub Copilot seat",
    keyName: "GitHub Copilot",
  },
  {
    provider: "openai",
    title: CHATGPT_SUBSCRIPTION_LABEL,
    subtitle: "Usage counts against your ChatGPT plan",
    keyName: CHATGPT_SUBSCRIPTION_LABEL,
  },
];

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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired after each successful connection (e.g. to advance chat onboarding). */
  onConnected?: () => void;
}) {
  const { data: existingKeys = [] } = useLlmProviderApiKeys({ enabled: open });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="medium"
      title="Use a subscription"
      description="Connect a plan you already pay for — no API key to create. Each connection is per-user: you sign in with your own account."
    >
      <DialogBody
        data-testid={E2eTestId.UseSubscriptionDialog}
        className="flex flex-col gap-3"
      >
        {SUBSCRIPTION_OPTIONS.map((option) => (
          <SubscriptionRow
            key={option.provider}
            option={option}
            existingKeys={existingKeys}
            onConnected={onConnected}
          />
        ))}
      </DialogBody>
    </FormDialog>
  );
}

function SubscriptionRow({
  option,
  existingKeys,
  onConnected,
}: {
  option: SubscriptionOption;
  existingKeys: LlmProviderApiKey[];
  onConnected?: () => void;
}) {
  const createMutation = useCreateLlmProviderApiKey();
  const [connected, setConnected] = useState(false);
  const config = PROVIDER_CONFIG[option.provider];
  const m365Configured = useFeature("microsoft365CopilotSignInConfigured");
  // Microsoft 365 Copilot needs an operator-set Entra client id; without it the
  // device-flow start 400s. Show why instead of an enabled-but-dead button.
  const signInUnavailable =
    option.provider === "microsoft-365-copilot" && m365Configured === false;

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
      setConnected(true);
      onConnected?.();
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
}: {
  provider: SubscriptionProvider;
  onCredential: (credential: string) => void;
  disabled?: boolean;
}) {
  if (provider === "github-copilot") {
    return <GithubCopilotSignIn onToken={onCredential} disabled={disabled} />;
  }
  if (provider === "microsoft-365-copilot") {
    return (
      <Microsoft365CopilotSignIn onToken={onCredential} disabled={disabled} />
    );
  }
  return <OpenaiCodexSignIn onCredential={onCredential} disabled={disabled} />;
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
