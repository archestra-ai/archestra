"use client";

import {
  E2eTestId,
  providerDisplayNames,
  type SupportedProvider,
} from "@archestra/shared";
import { Trash2 } from "lucide-react";
import Image from "next/image";
import { useMemo, useState } from "react";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import {
  type LlmProviderApiKeyResponse,
  PROVIDER_CONFIG,
} from "@/components/llm-provider-api-key-form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

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
  const handleSelectProviderKey = (providerApiKeyId: string) => {
    const selectedKey = providerApiKeys.find(
      (apiKey) => apiKey.id === providerApiKeyId,
    );
    if (!selectedKey) {
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
      <div className="space-y-2">
        <Label>Add provider key</Label>
        <LlmProviderApiKeyDropdown
          availableKeys={providerApiKeys}
          selectedApiKeyId={null}
          disabled={providerApiKeys.length === 0}
          open={apiKeySelectorOpen}
          onOpenChange={setApiKeySelectorOpen}
          onSelectKey={handleSelectProviderKey}
          triggerVariant="select"
          triggerClassName="w-full text-sm"
          popoverClassName="w-[var(--radix-popover-trigger-width)]"
          popoverPortal={false}
          searchPlaceholder="Search provider keys..."
          emptyTriggerLabel="Select a provider key"
          triggerTestId={E2eTestId.VirtualKeyParentKeySelect}
        />
      </div>

      <div className="space-y-2">
        <Label>Configured Provider Keys</Label>
        {configuredMappings.length === 0 ? (
          <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
            No provider keys configured.
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
