"use client";

import {
  E2eTestId,
  SUBSCRIPTION_CREDENTIAL_KINDS,
  SUBSCRIPTION_CREDENTIALS,
  type SupportedProvider,
} from "@archestra/shared";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import type { LlmProviderApiKeyFormValues } from "@/components/llm-provider-api-key-form";
import { Button } from "@/components/ui/button";
import { useModelProviderCatalog } from "@/lib/integration-overrides";

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

/** A subscription entry, which always stands for exactly one provider. */
type SubscriptionSetupOption = SetupOption & { provider: SupportedProvider };

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
  // Nothing here may offer a provider the admins turned off: the create dialog
  // refuses one, so the button would only open a dead end.
  const providerCatalog = useModelProviderCatalog();
  const subscriptionOptions = useMemo(
    () =>
      SUBSCRIPTION_SETUP_OPTIONS.filter(
        (option) => !providerCatalog.isHidden(option.provider),
      ),
    [providerCatalog],
  );
  const hasVisibleProviders = providerCatalog.visibleIds.length > 0;

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="w-full max-w-xl space-y-6 text-center">
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Connect an LLM provider</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>

        {subscriptionOptions.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm font-medium">Personal subscriptions</p>
            <div className="flex flex-wrap justify-center gap-2">
              {subscriptionOptions.map((option) => (
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
        )}

        {hasVisibleProviders ? (
          <>
            {subscriptionOptions.length > 0 && (
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" />
                <span>or use a provider API key</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}

            <Button
              data-testid={E2eTestId.QuickstartAddApiKeyButton}
              onClick={() => setSetupOption(API_KEY_SETUP_OPTION)}
            >
              <Plus className="h-4 w-4" />
              <span>Add API Key</span>
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No model providers are available. An administrator can turn one back
            on under Settings → LLM.
          </p>
        )}
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
const SUBSCRIPTION_SETUP_OPTIONS: SubscriptionSetupOption[] =
  SUBSCRIPTION_CREDENTIAL_KINDS.map((kind) => {
    const { provider, label, marker, connect } = SUBSCRIPTION_CREDENTIALS[kind];
    return {
      title: connect.signInTitle,
      description: connect.signInDescription,
      credentialMode: "subscription" as const,
      provider,
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
