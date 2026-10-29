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
 * A pool's members, listed by order. Order 1 is tried first; members of one
 * order split its traffic by weight. Orders run 1, 2, 3 with no gaps.
 */
export type PoolFormValues = {
  name: string;
  members: PoolFormMember[];
} & Record<PoolTiming, string>;

/**
 * The pool's failover timing, in seconds as typed. Blank keeps the default.
 * The values are the API's limits.
 */
export const MAX_SECONDS = {
  streamTimeoutSeconds: 1800,
  timeoutSeconds: 1800,
  cooldownSeconds: 3600,
} as const;

export type PoolTiming = keyof typeof MAX_SECONDS;

const TIMINGS = Object.keys(MAX_SECONDS) as PoolTiming[];

export function isValidSeconds(timing: PoolTiming, value: string): boolean {
  if (value === "") return true;
  const seconds = Number(value);
  return (
    Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_SECONDS[timing]
  );
}

export type PoolFormMember = {
  providerApiKeyId: string;
  modelId: string;
  priority: number;
  weight: number;
  enabled: boolean;
};

export type PoolForm = UseFormReturn<PoolFormValues>;

export type SavedMember = ModelPool["members"][number];

/** A member's key and model id, which no two members may share. */
export function memberKey(member: {
  providerApiKeyId: string;
  modelId: string;
}): string {
  return `${member.providerApiKeyId}|${member.modelId.trim()}`;
}

/** The API's limit on a member's weight. */
export const MAX_WEIGHT = 1000;

export function isValidWeight(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_WEIGHT;
}

export function toFormValues(pool: ModelPool | null): PoolFormValues {
  const members = [...(pool?.members ?? [])].sort(
    (a, b) => a.priority - b.priority,
  );
  const priorities = denseOrders(members);
  return {
    name: pool?.name ?? "",
    streamTimeoutSeconds: String(pool?.streamTimeoutSeconds ?? ""),
    timeoutSeconds: String(pool?.timeoutSeconds ?? ""),
    cooldownSeconds: String(pool?.cooldownSeconds ?? ""),
    members: members.map((member, index) => ({
      providerApiKeyId: member.providerApiKeyId,
      modelId: member.modelId,
      priority: priorities[index] ?? 1,
      weight: member.weight,
      enabled: member.enabled,
    })),
  };
}

export function toPoolInput(values: PoolFormValues): ModelPoolInput {
  return {
    name: values.name.trim(),
    streamTimeoutSeconds: toSeconds(values.streamTimeoutSeconds),
    timeoutSeconds: toSeconds(values.timeoutSeconds),
    cooldownSeconds: toSeconds(values.cooldownSeconds),
    members: values.members.map((member) => ({
      providerApiKeyId: member.providerApiKeyId,
      modelId: member.modelId.trim(),
      priority: member.priority,
      weight: member.weight,
      enabled: member.enabled,
    })),
  };
}

function toSeconds(value: string): number | null {
  return value === "" ? null : Number(value);
}

/** Each member's order once the orders are renumbered 1, 2, 3. */
export function denseOrders(members: { priority: number }[]): number[] {
  const used = [...new Set(members.map((member) => member.priority))].sort(
    (a, b) => a - b,
  );
  return members.map((member) => used.indexOf(member.priority) + 1);
}

/**
 * The member's percent of its order's traffic, among members that are on.
 * Null when it is off or alone on its order, where it takes all of it.
 */
export function orderShare(
  members: PoolFormMember[],
  index: number,
): number | null {
  const member = members[index];
  const sameOrder = members.filter(
    (other) => other.priority === member?.priority,
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
): "name" | "taken" | "members" | "numbers" | "repeated" | "timing" | null {
  const name = form.watch("name").trim();
  const members = form.watch("members");
  const timing = form.watch(TIMINGS);
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
  if (TIMINGS.some((key, index) => !isValidSeconds(key, timing[index] ?? "")))
    return "timing";
  return null;
}

function hasRepeatedMember(members: PoolFormMember[]) {
  const keys = members.map(memberKey);
  return keys.some((key, index) => keys.indexOf(key) !== index);
}

/** "3 members": how many the pool has. */
export function memberSummary(pool: ModelPool): string {
  return `${pool.members.length} member${pool.members.length === 1 ? "" : "s"}`;
}
