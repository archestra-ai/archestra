import { poolModelName } from "@/components/model-pools/model-name";
import type { ModelPool } from "@/lib/model-pools.query";

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
