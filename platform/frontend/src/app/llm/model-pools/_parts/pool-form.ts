"use client";

import { isModelPoolProvider, type SupportedProvider } from "@archestra/shared";
import { useMemo } from "react";
import type { UseFormReturn } from "react-hook-form";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  type ModelPool,
  type ModelPoolInput,
  useModelPools,
} from "@/lib/model-pools.query";
import { isPoolableModel, poolModelName } from "./model-name";

/**
 * A pool's members in the order requests try them. A linked member shares the
 * order of the one above it, and the two split traffic by weight; any other
 * member starts the next order, a fallback for every member above it.
 */
export type PoolFormValues = {
  name: string;
  members: PoolFormMember[];
};

export type PoolFormMember = {
  providerApiKeyId: string;
  modelId: string;
  linked: boolean;
  weight: number;
  enabled: boolean;
};

export type PoolForm = UseFormReturn<PoolFormValues>;

/** The API's limit on a member's weight. */
export const MAX_WEIGHT = 1000;

export function isValidWeight(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_WEIGHT;
}

export function toFormValues(pool: ModelPool | null): PoolFormValues {
  const members = [...(pool?.members ?? [])].sort(
    (a, b) => a.priority - b.priority,
  );
  return {
    name: pool?.name ?? "",
    members: members.map((member, index) => ({
      providerApiKeyId: member.providerApiKeyId,
      modelId: member.modelId,
      linked: index > 0 && members[index - 1]?.priority === member.priority,
      weight: member.weight,
      enabled: member.enabled,
    })),
  };
}

export function toPoolInput(values: PoolFormValues): ModelPoolInput {
  const orders = memberOrders(values.members);
  return {
    name: values.name.trim(),
    members: values.members.map((member, index) => ({
      providerApiKeyId: member.providerApiKeyId,
      modelId: member.modelId.trim(),
      priority: orders[index] ?? 1,
      weight: member.weight,
      enabled: member.enabled,
    })),
  };
}

/** Each member's order, 1 for the first: linked members share one. */
export function memberOrders(members: { linked: boolean }[]): number[] {
  const orders: number[] = [];
  members.forEach((member, index) => {
    const above = orders[index - 1] ?? 0;
    orders.push(index > 0 && member.linked ? above : above + 1);
  });
  return orders;
}

/**
 * The members after one moves from `from` to `to`. Dropped between two linked
 * members, it joins their order; anywhere else it starts an order of its own.
 * A member that followed it in its old order now leads that order. Moved
 * within its own order, it only trades places.
 */
export function moveMember(
  members: PoolFormMember[],
  from: number,
  to: number,
): PoolFormMember[] {
  const orders = memberOrders(members);
  if (orders[from] === orders[to]) {
    // Within one order, the rows trade places and the order stays as it is.
    const next = [...members];
    const [moved] = next.splice(from, 1);
    if (!moved) return members;
    next.splice(to, 0, moved);
    return next.map((member, index) => ({
      ...member,
      linked: members[index]?.linked ?? false,
    }));
  }
  const next = unlinkFollower(members, from);
  const [moved] = next.splice(from, 1);
  if (!moved) return members;
  const insideOrder = to > 0 && next[to]?.linked === true;
  next.splice(to, 0, { ...moved, linked: insideOrder });
  return leadWithUnlinked(next);
}

/** The members after one is removed, keeping the others' orders. */
export function removeMember(
  members: PoolFormMember[],
  index: number,
): PoolFormMember[] {
  const next = unlinkFollower(members, index);
  next.splice(index, 1);
  return leadWithUnlinked(next);
}

/** A leading member leaving its order hands the lead to the one after it. */
function unlinkFollower(members: PoolFormMember[], index: number) {
  const next = [...members];
  const follower = next[index + 1];
  if (!next[index]?.linked && follower?.linked) {
    next[index + 1] = { ...follower, linked: false };
  }
  return next;
}

function leadWithUnlinked(members: PoolFormMember[]) {
  const [first, ...rest] = members;
  return first?.linked ? [{ ...first, linked: false }, ...rest] : members;
}

/**
 * The member's percent of its order's traffic, among members that are on.
 * Null when it is off or alone on its order, where it takes all of it.
 */
export function orderShare(
  members: PoolFormMember[],
  index: number,
): number | null {
  const orders = memberOrders(members);
  const member = members[index];
  const sameOrder = members.filter(
    (_, other) => orders[other] === orders[index],
  );
  if (!member?.enabled || sameOrder.length < 2) return null;
  const total = sameOrder
    .filter((other) => other.enabled)
    .reduce((sum, other) => sum + (other.weight || 0), 0);
  if (total <= 0) return null;
  return Math.round(((member.weight || 0) / total) * 100);
}

/**
 * The provider keys and models the pool fields choose from.
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
  // Every model id a provider's keys list, offered for a key that has synced
  // none of its own yet.
  const modelIdsByProvider = useMemo(() => {
    const byProvider = new Map<SupportedProvider, string[]>();
    for (const model of chatModels) {
      const ids = byProvider.get(model.provider) ?? [];
      if (!ids.includes(model.modelId)) {
        byProvider.set(model.provider, [...ids, model.modelId]);
      }
    }
    return byProvider;
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

  return {
    sharedKeys,
    keysById,
    modelIdsByKey,
    modelIdsByProvider,
    modelNames,
  };
}

export type PoolOptions = ReturnType<typeof usePoolOptions>;

/**
 * Why the form can't be saved yet, or null when it can. The name is what a
 * request asks for, so it takes one pool.
 */
export function usePoolProblem(
  form: PoolForm,
  poolId: string | null,
): "name" | "taken" | "members" | "numbers" | "repeated" | null {
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
  if (members.some((member) => !isValidWeight(member.weight))) return "numbers";
  if (hasRepeatedMember(members)) return "repeated";
  return null;
}

export function hasRepeatedMember(members: PoolFormMember[]) {
  const keys = members.map(
    (member) => `${member.providerApiKeyId}|${member.modelId.trim()}`,
  );
  return keys.some((key, index) => keys.indexOf(key) !== index);
}

/**
 * "3 members · tries 2, then 1": how many there are, and how many share each
 * order among the members that are on.
 */
export function memberSummary(pool: ModelPool): string {
  const count = `${pool.members.length} member${pool.members.length === 1 ? "" : "s"}`;
  const counts = new Map<number, number>();
  for (const member of pool.members) {
    if (!member.enabled) continue;
    counts.set(member.priority, (counts.get(member.priority) ?? 0) + 1);
  }
  if (counts.size < 2) return count;
  const tries = [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, size]) => size)
    .join(", then ");
  return `${count} · tries ${tries}`;
}
