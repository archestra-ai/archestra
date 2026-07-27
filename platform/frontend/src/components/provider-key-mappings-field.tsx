"use client";

import {
  E2eTestId,
  providerDisplayNames,
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

export type ProviderApiKeyMap = Partial<Record<SupportedProvider, string>>;

export function ProviderKeyMappingsField({
  providerApiKeyIds,
  onProviderApiKeyIdsChange,
  providerApiKeys,
  className,
}: {
  providerApiKeyIds: ProviderApiKeyMap;
  onProviderApiKeyIdsChange: (value: ProviderApiKeyMap) => void;
  providerApiKeys: LlmProviderApiKeyResponse[];
  className?: string;
}) {
  const [apiKeySelectorOpen, setApiKeySelectorOpen] = useState(false);
  const configuredMappings = useMemo(() => {
    return providerApiKeyMapToArray(providerApiKeyIds)
      .map(({ provider, providerApiKeyId }) => {
        const key = providerApiKeys.find(
          (apiKey) => apiKey.id === providerApiKeyId,
        );
        return { provider, providerApiKeyId, key };
      })
      .sort((a, b) =>
        getProviderName(a.provider).localeCompare(getProviderName(b.provider)),
      );
  }, [providerApiKeyIds, providerApiKeys]);
  const availableProviderApiKeys = useMemo(
    () =>
      providerApiKeys.filter((apiKey) => !providerApiKeyIds[apiKey.provider]),
    [providerApiKeyIds, providerApiKeys],
  );

  const handleSelectProviderKey = (providerApiKeyId: string) => {
    const selectedKey = providerApiKeys.find(
      (apiKey) => apiKey.id === providerApiKeyId,
    );
    if (!selectedKey || providerApiKeyIds[selectedKey.provider]) {
      return;
    }

    onProviderApiKeyIdsChange({
      ...providerApiKeyIds,
      [selectedKey.provider]: selectedKey.id,
    });
    setApiKeySelectorOpen(false);
  };

  const handleRemoveProviderKey = (provider: SupportedProvider) => {
    const nextMappings = { ...providerApiKeyIds };
    delete nextMappings[provider];
    onProviderApiKeyIdsChange(nextMappings);
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
              return (
                <div
                  key={provider}
                  className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Image
                      src={config.icon}
                      alt={config.name}
                      width={20}
                      height={20}
                      className="rounded dark:invert"
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {key?.name ?? providerApiKeyId}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {config.name}
                      </div>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => handleRemoveProviderKey(provider)}
                    aria-label={`Remove ${config.name} key`}
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

export function providerApiKeyMapToArray(providerApiKeyIds: ProviderApiKeyMap) {
  return Object.entries(providerApiKeyIds)
    .filter((entry): entry is [SupportedProvider, string] => Boolean(entry[1]))
    .map(([provider, providerApiKeyId]) => ({ provider, providerApiKeyId }));
}

export function providerApiKeyArrayToMap(
  providerApiKeys: Array<{
    provider: SupportedProvider;
    providerApiKeyId: string;
  }>,
): ProviderApiKeyMap {
  return Object.fromEntries(
    providerApiKeys.map((mapping) => [
      mapping.provider,
      mapping.providerApiKeyId,
    ]),
  );
}

export function formatProviderKeySummary(
  providerApiKeys: Array<{ provider: string }>,
): string {
  if (providerApiKeys.length === 0) {
    return "None";
  }

  return [
    ...new Set(
      providerApiKeys.map(
        (mapping) =>
          providerDisplayNames[
            mapping.provider as keyof typeof providerDisplayNames
          ] ?? mapping.provider,
      ),
    ),
  ].join(", ");
}

function getProviderName(provider: SupportedProvider): string {
  return providerDisplayNames[provider] ?? provider;
}
