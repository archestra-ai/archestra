/**
 * Pure model-resolution core.
 *
 * No React, no fetch, no database — imported by both the frontend and the
 * backend so the client and the server resolve the effective model
 * identically. Every function here is pure and total.
 *
 * Resolution is a plain priority chain over foreign-key columns:
 *
 *   conversation -> member -> agent -> organization -> best available model
 *
 * Because each level stores a real FK (`ON DELETE SET NULL`), a deleted model
 * simply becomes NULL and the chain falls through — there is no orphaned-string
 * handling to do here.
 */

/** A (model, key) pair stored at one level of the resolution chain. */
export interface ModelSelection {
  modelId: string | null | undefined;
  apiKeyId: string | null | undefined;
}

/** A model the actor can currently use, with the provider's "best" marker. */
export interface RankedModel {
  modelId: string;
  /** The API key that makes this model available. */
  apiKeyId: string;
  isBest?: boolean;
}

/** Where the selected model came from, relative to the configured defaults. */
export type ModelSource = "agent" | "organization" | "user";

/**
 * Resolve the effective model from the priority chain.
 *
 * `levels` must already be ordered most- to least-specific
 * (conversation -> member -> agent -> organization). The first level with a
 * non-null `modelId` wins; if that level has no `apiKeyId`, the key is derived
 * from `availableModels`. When no level has a model, falls back to the "best
 * available" model across every key the actor can use.
 *
 * Returns null only when nothing is configured and no models are available.
 */
export function resolveModelSelection(params: {
  levels: ModelSelection[];
  availableModels: RankedModel[];
}): ModelSelection | null {
  const { levels, availableModels } = params;

  for (const level of levels) {
    if (!level.modelId) {
      continue;
    }
    const apiKeyId =
      level.apiKeyId ??
      availableModels.find((m) => m.modelId === level.modelId)?.apiKeyId ??
      null;
    return { modelId: level.modelId, apiKeyId };
  }

  const best = pickBestModel(availableModels);
  return best ? { modelId: best.modelId, apiKeyId: best.apiKeyId } : null;
}

/**
 * Pick the "best" model from a list: the one the provider marked best, else
 * the first. Shared so every fallback honors the marker instead of whatever
 * happens to sort first.
 */
export function pickBestModel<T extends { isBest?: boolean }>(
  models: T[],
): T | undefined {
  return models.find((m) => m.isBest) ?? models[0];
}

/**
 * Determine where the selected model came from, purely by comparison with the
 * configured defaults — no stored state.
 *
 * Returns null when there is nothing to compare against (no model, or no
 * agent/organization default) — there is no default to "override", so no
 * badge is shown.
 */
export function deriveModelSource(params: {
  selectedModelId: string | null | undefined;
  agentModelId: string | null | undefined;
  orgModelId: string | null | undefined;
}): ModelSource | null {
  const { selectedModelId, agentModelId, orgModelId } = params;
  if (!selectedModelId) {
    return null;
  }
  if (agentModelId && selectedModelId === agentModelId) {
    return "agent";
  }
  if (orgModelId && selectedModelId === orgModelId) {
    return "organization";
  }
  // No configured default anywhere — nothing to override.
  if (!agentModelId && !orgModelId) {
    return null;
  }
  return "user";
}
