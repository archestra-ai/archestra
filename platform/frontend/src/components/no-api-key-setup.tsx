"use client";

import {
  E2eTestId,
  SUBSCRIPTION_CREDENTIAL_KINDS,
  SUBSCRIPTION_CREDENTIALS,
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

/**
 * One "Sign in with <vendor>" entry per subscription in the shared registry,
 * so a new subscription appears on this empty state without editing it.
 */
const SUBSCRIPTION_SETUP_OPTIONS: SetupOption[] =
  SUBSCRIPTION_CREDENTIAL_KINDS.map((kind) => {
    const { provider, label, marker, connect } = SUBSCRIPTION_CREDENTIALS[kind];
    return {
      title: connect.signInTitle,
      description: connect.signInDescription,
      credentialMode: "subscription" as const,
      allowedProviders: [provider],
      defaultValues: {
        name: label,
        provider,
        scope: "personal" as const,
        // Credential-level subscriptions share their provider with ordinary
        // API keys, so the form has to open on the subscription tab.
        // Provider-level ones have no tabs and ignore this.
        ...(marker !== null ? { authMethod: "subscription" as const } : {}),
      },
    };
  });
