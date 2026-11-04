import { poolModelName } from "@/app/llm/model-pools/_parts/model-name";
import { primaryKeyMappings } from "@/components/credential-billing/provider-key-data";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import type { ProviderApiKeyMappings } from "@/components/provider-key-mappings-field";
import type { ModelPool } from "@/lib/model-pools.query";

/**
 * The provider keys a credential answers with: its mappings, plus, when it
 * follows current and future providers, the primary key of every provider it
 * doesn't map. A pool with a member on one of these keys is already included.
 */
export function resolvedProviderKeyIds({
  mappings,
  includeFutureProviders,
  providerApiKeys,
}: {
  mappings: ProviderApiKeyMappings;
  includeFutureProviders: boolean;
  providerApiKeys: LlmProviderApiKeyResponse[];
}): Set<string> {
  const ids = new Set(mappings.map((mapping) => mapping.providerApiKeyId));
  if (!includeFutureProviders) return ids;
  const mapped = new Set(mappings.map((mapping) => mapping.provider));
  for (const primary of primaryKeyMappings(providerApiKeys)) {
    if (!mapped.has(primary.provider)) ids.add(primary.providerApiKeyId);
  }
  return ids;
}

/**
 * How a credential reaches a pool: added to it by name, included through a
 * member on one of its provider keys, or not at all. Either way the pool
 * answers with its own members' keys.
 */
export type PoolAccess =
  | { kind: "added" }
  | { kind: "included"; member: ModelPool["members"][number] }
  | { kind: "none" };

export function poolAccess(
  pool: ModelPool,
  keyIds: Set<string>,
  added: boolean,
): PoolAccess {
  if (added) return { kind: "added" };
  const member = pool.members.find((m) => keyIds.has(m.providerApiKeyId));
  return member ? { kind: "included", member } : { kind: "none" };
}

/** A pool with every member off answers nothing, whoever calls it. */
export function poolAnswers(pool: ModelPool): boolean {
  return pool.members.some((member) => member.enabled);
}

/**
 * What the pool serves first, and how many other models its members serve.
 * The same model under a provider's own id (`us.zai.glm-5.3`) counts once.
 */
export function poolServes(pool: ModelPool): {
  first: string | null;
  otherModels: number;
} {
  const ordered = [...pool.members].sort((a, b) => a.priority - b.priority);
  const first = ordered.find((member) => member.enabled) ?? ordered[0];
  const names = new Set(
    pool.members.map((member) =>
      poolModelName(member.provider, member.modelId),
    ),
  );
  return {
    first: first ? poolModelName(first.provider, first.modelId) : null,
    otherModels: Math.max(0, names.size - 1),
  };
}

/** The pools a virtual key was added to by name. */
export function addedPoolIds(pools: ModelPool[], virtualKeyId: string) {
  return pools
    .filter((pool) => pool.virtualApiKeyIds.includes(virtualKeyId))
    .map((pool) => pool.id);
}
