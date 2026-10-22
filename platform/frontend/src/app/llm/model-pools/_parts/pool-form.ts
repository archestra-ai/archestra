"use client";

import { isModelPoolProvider } from "@archestra/shared";
import { useMemo } from "react";
import type { UseFormReturn } from "react-hook-form";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  type ModelPool,
  type ModelPoolInput,
  useModelPools,
} from "@/lib/model-pools.query";
import { useAllVirtualApiKeys } from "@/lib/virtual-api-keys.query";
import { isPoolableModel, poolModelName } from "./model-name";

export type PoolFormValues = {
  name: string;
  members: {
    providerApiKeyId: string;
    modelId: string;
    priority: number;
    weight: number;
    enabled: boolean;
  }[];
  virtualApiKeyIds: string[];
};

export type PoolForm = UseFormReturn<PoolFormValues>;

export function toFormValues(pool: ModelPool | null): PoolFormValues {
  return {
    name: pool?.name ?? "",
    members:
      pool?.members.map((member) => ({
        providerApiKeyId: member.providerApiKeyId,
        modelId: member.modelId,
        priority: member.priority,
        weight: member.weight,
        enabled: member.enabled,
      })) ?? [],
    virtualApiKeyIds: pool?.virtualApiKeyIds ?? [],
  };
}

export function toPoolInput(values: PoolFormValues): ModelPoolInput {
  return {
    name: values.name.trim(),
    members: values.members.map((member) => ({
      ...member,
      modelId: member.modelId.trim(),
    })),
    virtualApiKeyIds: values.virtualApiKeyIds,
  };
}

/**
 * The provider keys, model ids and virtual keys the pool fields choose from.
 */
export function usePoolOptions() {
  const { data: allKeys = [] } = useLlmProviderApiKeys();
  // Personal keys belong to one user, so only shared keys on providers a pool
  // can send to can be members.
  const sharedKeys = useMemo(
    () =>
      allKeys
        .filter(
          (key) => key.userId === null && isModelPoolProvider(key.provider),
        )
        .sort(
          (a, b) =>
            a.provider.localeCompare(b.provider) ||
            a.name.localeCompare(b.name),
        ),
    [allKeys],
  );
  const keysById = useMemo(
    () => new Map(sharedKeys.map((key) => [key.id, key])),
    [sharedKeys],
  );

  const { data: models = [] } = useModelsWithApiKeys({
    includeAssignments: false,
  });
  const chatModels = useMemo(() => models.filter(isPoolableModel), [models]);
  // The model ids each key lists, to suggest and check a member's model id.
  const modelIdsByKey = useMemo(() => {
    const byKey = new Map<string, string[]>();
    for (const model of chatModels) {
      for (const key of model.apiKeys) {
        byKey.set(key.id, [...(byKey.get(key.id) ?? []), model.modelId]);
      }
    }
    return byKey;
  }, [chatModels]);
  // Names, not provider ids: Bedrock's `us.zai.glm-5.3` is offered as `glm-5.3`.
  const modelNames = useMemo(
    () =>
      [
        ...new Set(
          chatModels.map((model) =>
            poolModelName(model.provider, model.modelId),
          ),
        ),
      ].sort(),
    [chatModels],
  );

  // Pass-through keys carry the caller's own provider key, so they can't
  // spend a pool's keys.
  const { data: virtualKeyPage } = useAllVirtualApiKeys({
    limit: 100,
    keyType: "standard",
    toastOnError: false,
  });
  const virtualKeys = virtualKeyPage?.data ?? [];

  return { sharedKeys, keysById, modelIdsByKey, modelNames, virtualKeys };
}

export type PoolOptions = ReturnType<typeof usePoolOptions>;

/**
 * Why the form can't be saved yet, or null when it can. The name is what a
 * request asks for, so it takes one pool.
 */
export function usePoolProblem(
  form: PoolForm,
  poolId: string | null,
): "name" | "taken" | "members" | "repeated" | null {
  const name = form.watch("name").trim();
  const members = form.watch("members");
  const { data: pools = [] } = useModelPools({ toastOnError: false });
  if (!name) return "name";
  if (pools.some((other) => other.id !== poolId && other.name === name))
    return "taken";
  if (
    members.length === 0 ||
    members.some((member) => !member.providerApiKeyId || !member.modelId.trim())
  )
    return "members";
  if (hasRepeatedMember(members)) return "repeated";
  return null;
}

export function hasRepeatedMember(members: PoolFormValues["members"]) {
  const keys = members.map(
    (member) => `${member.providerApiKeyId}|${member.modelId.trim()}`,
  );
  return keys.some((key, index) => keys.indexOf(key) !== index);
}

/** A new member goes one priority below the last, as a standby. */
export function nextPriority(members: PoolFormValues["members"]): number {
  if (members.length === 0) return 1;
  return Math.min(100, Math.max(...members.map((m) => m.priority || 1)) + 1);
}

/** The member's share of its priority tier, among members that are on. */
export function tierShare(
  members: PoolFormValues["members"],
  index: number,
): string {
  const member = members[index];
  if (!member?.enabled) return "";
  const tier = members.filter(
    (other) => other.enabled && other.priority === member.priority,
  );
  if (tier.length < 2) return "";
  const total = tier.reduce((sum, other) => sum + (other.weight || 0), 0);
  if (total <= 0) return "";
  return `${Math.round(((member.weight || 0) / total) * 100)}%`;
}

/** "3 members, 2 on priority 1": how many there are and how many lead. */
export function memberSummary(pool: ModelPool): string {
  const on = pool.members.filter((member) => member.enabled);
  const count = `${pool.members.length} member${pool.members.length === 1 ? "" : "s"}`;
  if (on.length === 0) return count;
  const first = Math.min(...on.map((member) => member.priority));
  const leading = on.filter((member) => member.priority === first).length;
  return leading === pool.members.length
    ? count
    : `${count}, ${leading} on priority ${first}`;
}

export function accessSummary(count: number): string {
  if (count === 0) return "No virtual keys";
  return `${count} virtual key${count === 1 ? "" : "s"}`;
}
