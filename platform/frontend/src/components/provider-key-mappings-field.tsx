"use client";

import {
  E2eTestId,
  providerHasEndpointLocalModels,
  type SupportedProvider,
} from "@archestra/shared";
import { KeyRound, Trash2 } from "lucide-react";
import Image from "next/image";
import { useMemo, useState } from "react";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import {
  type LlmProviderApiKeyResponse,
  PROVIDER_CONFIG,
} from "@/components/llm-provider-api-key-form";
import { Button } from "@/components/ui/button";
import { useModelProviderCatalog } from "@/lib/integration-overrides";

/**
 * The provider API keys a credential routes to. One key per provider, except
 * for providers whose keys are separate servers with their own models (vLLM,
 * Ollama, …): there each key is another endpoint, and requests go to the one
 * that serves the model.
 */
export type ProviderApiKeyMappings = Array<{
  provider: SupportedProvider;
  providerApiKeyId: string;
}>;

export function ProviderKeyMappingsField({
  providerApiKeyIds,
  onProviderApiKeyIdsChange,
  providerApiKeys,
  className,
}: {
  providerApiKeyIds: ProviderApiKeyMappings;
  onProviderApiKeyIdsChange: (value: ProviderApiKeyMappings) => void;
  providerApiKeys: LlmProviderApiKeyResponse[];
  className?: string;
}) {
  const [apiKeySelectorOpen, setApiKeySelectorOpen] = useState(false);
  const providerCatalog = useModelProviderCatalog();
  const configuredMappings = useMemo(() => {
    return providerApiKeyIds
      .map(({ provider, providerApiKeyId }) => {
        const key = providerApiKeys.find(
          (apiKey) => apiKey.id === providerApiKeyId,
        );
        return { provider, providerApiKeyId, key };
      })
      .sort(
        (a, b) =>
          providerCatalog
            .label(a.provider)
            .localeCompare(providerCatalog.label(b.provider)) ||
          (a.key?.name ?? "").localeCompare(b.key?.name ?? ""),
      );
  }, [providerApiKeyIds, providerApiKeys, providerCatalog]);
  const availableProviderApiKeys = useMemo(
    () =>
      providerApiKeys.filter((apiKey) =>
        canAddProviderApiKey(providerApiKeyIds, apiKey),
      ),
    [providerApiKeyIds, providerApiKeys],
  );

  const handleSelectProviderKey = (providerApiKeyId: string) => {
    const selectedKey = providerApiKeys.find(
      (apiKey) => apiKey.id === providerApiKeyId,
    );
    if (!selectedKey || !canAddProviderApiKey(providerApiKeyIds, selectedKey)) {
      return;
    }

    onProviderApiKeyIdsChange([
      ...providerApiKeyIds,
      { provider: selectedKey.provider, providerApiKeyId: selectedKey.id },
    ]);
    setApiKeySelectorOpen(false);
  };

  const handleRemoveProviderKey = (providerApiKeyId: string) => {
    onProviderApiKeyIdsChange(
      providerApiKeyIds.filter(
        (mapping) => mapping.providerApiKeyId !== providerApiKeyId,
      ),
    );
  };

  return (
    <div className={className ?? "space-y-4"}>
      <LlmProviderApiKeyDropdown
        availableKeys={availableProviderApiKeys}
        selectedApiKeyId={null}
        disabled={availableProviderApiKeys.length === 0}
        open={apiKeySelectorOpen}
        onOpenChange={setApiKeySelectorOpen}
        onSelectKey={handleSelectProviderKey}
        triggerVariant="select"
        triggerClassName="w-full text-sm"
        popoverClassName="w-[var(--radix-popover-trigger-width)]"
        popoverPortal={false}
        searchPlaceholder="Search provider keys..."
        emptyTriggerLabel={
          availableProviderApiKeys.length > 0
            ? "Select a provider key"
            : configuredMappings.length > 0
              ? "All providers configured"
              : "No provider keys available"
        }
        triggerTestId={E2eTestId.VirtualKeyParentKeySelect}
      />

      <div>
        {configuredMappings.length === 0 ? (
          <div className="flex flex-col items-center rounded-md border border-dashed px-4 py-6 text-center">
            <div className="mb-2 rounded-full bg-muted p-2 text-muted-foreground">
              <KeyRound className="h-4 w-4" />
            </div>
            <p className="text-sm font-medium">
              {providerApiKeys.length > 0
                ? "No provider keys added"
                : "No provider keys available"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {providerApiKeys.length > 0
                ? "Map this virtual API key to a real provider API key."
                : "Create a provider API key first."}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {configuredMappings.map(({ provider, providerApiKeyId, key }) => {
              const config = PROVIDER_CONFIG[provider];
              const label = providerCatalog.label(provider);
              return (
                <div
                  key={providerApiKeyId}
                  className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Image
                      src={config.icon}
                      alt={label}
                      width={20}
                      height={20}
                      className="rounded dark:invert"
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {key?.name ?? providerApiKeyId}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {label}
                      </div>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => handleRemoveProviderKey(providerApiKeyId)}
                    aria-label={`Remove ${key?.name ?? label} key`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Whether `apiKey` can join `mappings`: not already mapped, and either the
 * first key of its provider or a further endpoint of a self-hosted provider.
 */
export function canAddProviderApiKey(
  mappings: ProviderApiKeyMappings,
  apiKey: { id: string; provider: SupportedProvider },
): boolean {
  if (mappings.some((mapping) => mapping.providerApiKeyId === apiKey.id)) {
    return false;
  }
  return (
    providerHasEndpointLocalModels(apiKey.provider) ||
    !mappings.some((mapping) => mapping.provider === apiKey.provider)
  );
}

export function formatProviderKeySummary(
  providerApiKeys: Array<{ provider: string }>,
  /** Resolves the organization's own name for a provider (see integration overrides). */
  labelFor: (provider: SupportedProvider) => string,
): string {
  if (providerApiKeys.length === 0) {
    return "None";
  }

  return [
    ...new Set(
      providerApiKeys.map((mapping) =>
        labelFor(mapping.provider as SupportedProvider),
      ),
    ),
  ].join(", ");
}
