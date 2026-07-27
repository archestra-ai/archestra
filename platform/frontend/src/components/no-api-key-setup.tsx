"use client";

import {
  CHATGPT_SUBSCRIPTION_LABEL,
  E2eTestId,
  type SupportedProvider,
} from "@archestra/shared";
import { Plus } from "lucide-react";
import { useState } from "react";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import type { LlmProviderApiKeyFormValues } from "@/components/llm-provider-api-key-form";
import { Button } from "@/components/ui/button";

const DEFAULT_FORM_VALUES: Partial<LlmProviderApiKeyFormValues> = {
  isPrimary: true,
};

type SetupOption = {
  title: string;
  description: string;
  defaultValues: Partial<LlmProviderApiKeyFormValues>;
  allowedProviders?: SupportedProvider[];
  credentialMode: "api-key" | "subscription";
  showConsoleLink?: boolean;
};

/**
 * Empty state shown when the user has no usable LLM provider key — on the new
 * chat screen and the projects page. Lets them add a key inline; the create
 * mutation invalidates the keys query, so the calling screen reactively shows
 * its real content once a key exists.
 *
 * @param description subtitle under the heading; defaults to the chat copy so
 * each surface can phrase the "why" for its own context.
 * @param onKeyAdded extra work after a key is created (e.g. the chat screen
 * resets its URL). Optional — most callers just rely on the query refetch.
 */
export function NoApiKeySetup({
  description = "Connect an LLM provider to start chatting",
  onKeyAdded,
}: {
  description?: string;
  onKeyAdded?: () => void;
}) {
  const [setupOption, setSetupOption] = useState<SetupOption | null>(null);

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="w-full max-w-xl space-y-6 text-center">
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Connect an LLM provider</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-medium">Personal subscriptions</p>
          <div className="flex flex-wrap justify-center gap-2">
            {SUBSCRIPTION_SETUP_OPTIONS.map((option) => (
              <Button
                key={option.title}
                type="button"
                variant="outline"
                onClick={() => setSetupOption(option)}
              >
                {option.title}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <div className="h-px flex-1 bg-border" />
          <span>or use a provider API key</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <Button
          data-testid={E2eTestId.QuickstartAddApiKeyButton}
          onClick={() => setSetupOption(API_KEY_SETUP_OPTION)}
        >
          <Plus className="h-4 w-4" />
          Add API Key
        </Button>
      </div>
      <CreateLlmProviderApiKeyDialog
        open={setupOption !== null}
        onOpenChange={(open) => {
          if (!open) setSetupOption(null);
        }}
        title={setupOption?.title ?? API_KEY_SETUP_OPTION.title}
        description={
          setupOption?.description ?? API_KEY_SETUP_OPTION.description
        }
        defaultValues={
          setupOption?.defaultValues ?? API_KEY_SETUP_OPTION.defaultValues
        }
        allowedProviders={setupOption?.allowedProviders}
        credentialMode={setupOption?.credentialMode}
        showConsoleLink={setupOption?.showConsoleLink}
        onSuccess={onKeyAdded}
      />
    </div>
  );
}

const API_KEY_SETUP_OPTION: SetupOption = {
  title: "Add API Key",
  description: "Add an LLM provider API key to start chatting",
  defaultValues: DEFAULT_FORM_VALUES,
  credentialMode: "api-key",
  showConsoleLink: true,
};

const SUBSCRIPTION_SETUP_OPTIONS: SetupOption[] = [
  {
    title: "Sign in with ChatGPT",
    description: "Connect your ChatGPT account to use your subscription",
    credentialMode: "subscription",
    allowedProviders: ["openai"],
    defaultValues: {
      name: CHATGPT_SUBSCRIPTION_LABEL,
      provider: "openai",
      scope: "personal",
      openaiAuthMethod: "chatgpt-subscription",
    },
  },
  {
    title: "Sign in with GitHub Copilot",
    description: "Connect your GitHub Copilot subscription",
    credentialMode: "subscription",
    allowedProviders: ["github-copilot"],
    defaultValues: {
      name: "GitHub Copilot",
      provider: "github-copilot",
      scope: "personal",
    },
  },
  {
    title: "Sign in with Microsoft 365 Copilot",
    description: "Connect your Microsoft 365 Copilot subscription",
    credentialMode: "subscription",
    allowedProviders: ["microsoft-365-copilot"],
    defaultValues: {
      name: "Microsoft 365 Copilot",
      provider: "microsoft-365-copilot",
      scope: "personal",
    },
  },
];
