"use client";

import {
  E2eTestId,
  providerDisplayNames,
  type SupportedProvider,
} from "@shared";
import { Plus, Trash2 } from "lucide-react";
import Image from "next/image";
import { useMemo, useState } from "react";
import {
  type LlmProviderApiKeyResponse,
  PROVIDER_CONFIG,
} from "@/components/llm-provider-api-key-form";
import { LlmProviderApiKeyOptionLabel } from "@/components/llm-provider-options";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
  const [selectedProvider, setSelectedProvider] = useState<
    SupportedProvider | ""
  >("");
  const [selectedApiKeyId, setSelectedApiKeyId] = useState("");
  const providerGroups = useMemo(
    () => groupProviderApiKeys(providerApiKeys),
    [providerApiKeys],
  );
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
  const availableProviderGroups = providerGroups.filter(
    ([provider]) => !providerApiKeyIds[provider],
  );
  const selectedProviderKeys = selectedProvider
    ? (providerGroups.find(
        ([provider]) => provider === selectedProvider,
      )?.[1] ?? [])
    : [];

  const handleAddProviderKey = () => {
    if (!selectedProvider || !selectedApiKeyId) {
      return;
    }

    onProviderApiKeyIdsChange({
      ...providerApiKeyIds,
      [selectedProvider]: selectedApiKeyId,
    });
    setSelectedProvider("");
    setSelectedApiKeyId("");
  };

  const handleRemoveProviderKey = (provider: SupportedProvider) => {
    const nextMappings = { ...providerApiKeyIds };
    delete nextMappings[provider];
    onProviderApiKeyIdsChange(nextMappings);
  };

  return (
    <div className={className ?? "space-y-4"}>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
        <div className="space-y-2">
          <Label>Provider</Label>
          <Select
            value={selectedProvider}
            onValueChange={(value) => {
              setSelectedProvider(value as SupportedProvider);
              setSelectedApiKeyId("");
            }}
          >
            <SelectTrigger
              className="w-full"
              data-testid={E2eTestId.VirtualKeyProviderSelect}
            >
              <SelectValue placeholder="Select provider" />
            </SelectTrigger>
            <SelectContent>
              {availableProviderGroups.map(([provider]) => {
                const config = PROVIDER_CONFIG[provider];
                return (
                  <SelectItem key={provider} value={provider}>
                    <div className="flex items-center gap-2">
                      <Image
                        src={config.icon}
                        alt={config.name}
                        width={16}
                        height={16}
                        className="rounded dark:invert"
                      />
                      <span>{config.name}</span>
                    </div>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Provider API Key</Label>
          <Select
            value={selectedApiKeyId}
            onValueChange={setSelectedApiKeyId}
            disabled={!selectedProvider}
          >
            <SelectTrigger
              className="w-full"
              data-testid={E2eTestId.VirtualKeyParentKeySelect}
            >
              <SelectValue placeholder="Select key" />
            </SelectTrigger>
            <SelectContent>
              {selectedProviderKeys.map((key) => {
                const config = PROVIDER_CONFIG[key.provider];
                return (
                  <SelectItem key={key.id} value={key.id}>
                    <LlmProviderApiKeyOptionLabel
                      icon={config.icon}
                      providerName={config.name}
                      keyName={key.name}
                      secondaryLabel={config.name}
                    />
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className="invisible">Add provider key</Label>
          <Button
            type="button"
            variant="outline"
            onClick={handleAddProviderKey}
            disabled={!selectedProvider || !selectedApiKeyId}
            className="w-full md:w-auto"
          >
            <Plus className="mr-2 h-4 w-4" />
            Add
          </Button>
        </div>
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

function groupProviderApiKeys(providerApiKeys: LlmProviderApiKeyResponse[]) {
  const groups = new Map<SupportedProvider, LlmProviderApiKeyResponse[]>();
  for (const key of providerApiKeys) {
    const provider = key.provider as SupportedProvider;
    const existing = groups.get(provider) ?? [];
    existing.push(key);
    groups.set(provider, existing);
  }
  return Array.from(groups.entries()).sort(([a], [b]) =>
    getProviderName(a).localeCompare(getProviderName(b)),
  );
}

function getProviderName(provider: SupportedProvider): string {
  return providerDisplayNames[provider] ?? provider;
}
