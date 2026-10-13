"use client";

import {
  providerHasEndpointLocalModels,
  type SupportedProvider,
} from "@archestra/shared";
import { useMemo } from "react";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import type { ProviderApiKeyMappings } from "@/components/provider-key-mappings-field";
import { useSession } from "@/lib/auth/auth.query";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";

/** Model ids each provider key serves, for the key pickers' counts. */
export function useModelIdsByKey(enabled = true) {
  const { data: models = [] } = useModelsWithApiKeys({
    enabled,
    toastOnError: false,
  });
  return useMemo(() => {
    const byKey = new Map<string, string[]>();
    for (const model of models) {
      if (model.ignored) continue;
      for (const apiKey of model.apiKeys) {
        const list = byKey.get(apiKey.id) ?? [];
        list.push(model.modelId);
        byKey.set(apiKey.id, list);
      }
    }
    for (const list of byKey.values()) list.sort();
    return byKey;
  }, [models]);
}

/** Who a provider key belongs to, in a few words: "Yours", "Team: Platform". */
export function useKeyOwnerLabel() {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  return (key: LlmProviderApiKeyResponse): string => {
    if (key.isSystem) return "System";
    if (key.scope === "org") return "Organization";
    if (key.scope === "team") return `Team: ${key.teamName ?? "Unknown"}`;
    if (key.userId && key.userId === userId) return "Yours";
    return key.userName ?? "Personal";
  };
}

/**
 * Whether a provider takes several keys. Self-hosted providers (vLLM, Ollama,
 * …) treat each key as another endpoint, and requests go to the one that
 * serves the model. Every other provider takes one key.
 */
export function takesSeveralKeys(provider: SupportedProvider): boolean {
  return providerHasEndpointLocalModels(provider);
}

/**
 * Pick a key for a provider: replaces the provider's key, or, for a provider
 * that takes several, adds the key or removes it again.
 */
export function pickProviderKey(
  mappings: ProviderApiKeyMappings,
  provider: SupportedProvider,
  providerApiKeyId: string,
): ProviderApiKeyMappings {
  if (takesSeveralKeys(provider)) {
    return mappings.some((m) => m.providerApiKeyId === providerApiKeyId)
      ? mappings.filter((m) => m.providerApiKeyId !== providerApiKeyId)
      : [...mappings, { provider, providerApiKeyId }];
  }
  return [
    ...mappings.filter((m) => m.provider !== provider),
    { provider, providerApiKeyId },
  ];
}

/**
 * One mapping per provider, to its primary key (or its first key by name when
 * none is primary): what a new virtual key starts with.
 */
export function primaryKeyMappings(
  keys: LlmProviderApiKeyResponse[],
): ProviderApiKeyMappings {
  return [...keysByProvider(keys)].flatMap(([provider, list]) =>
    list[0] ? [{ provider, providerApiKeyId: list[0].id }] : [],
  );
}

/** Subscription keys bill $0 in Costs and skip spend caps and team limits. */
export function isSubscriptionKey(key: LlmProviderApiKeyResponse): boolean {
  return !!key.subscriptionKind;
}

export function keysByProvider(
  keys: LlmProviderApiKeyResponse[],
): Map<SupportedProvider, LlmProviderApiKeyResponse[]> {
  const grouped = new Map<SupportedProvider, LlmProviderApiKeyResponse[]>();
  for (const key of keys) {
    const list = grouped.get(key.provider) ?? [];
    list.push(key);
    grouped.set(key.provider, list);
  }
  // The primary key first, then by name, matching how requests prefer keys.
  for (const list of grouped.values()) {
    list.sort(
      (a, b) =>
        Number(b.isPrimary) - Number(a.isPrimary) ||
        a.name.localeCompare(b.name),
    );
  }
  return grouped;
}
