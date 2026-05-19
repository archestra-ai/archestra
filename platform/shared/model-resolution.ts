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

/**
 * A (model, key) selection is complete only when both ids are set or both are
 * empty. A half-configured selection — a model with no key, or a key with no
 * model — must never be persisted: the key cannot be inferred from the model
 * (see `resolveModelSelection`), so a half pair is an unresolvable state.
 */
export function isModelSelectionComplete(selection: ModelSelection): boolean {
  return Boolean(selection.modelId) === Boolean(selection.apiKeyId);
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
 * (conversation -> member -> agent -> organization). A level wins only when it
 * carries *both* a `modelId` and an `apiKeyId`: a model is meaningless without
 * the key it runs through, so a half-configured level (e.g. a model pinned
 * with no key) is skipped and the chain falls through to the next level. When
 * no level is complete, falls back to the "best available" model across every
 * key the actor can use.
 *
 * There is no key derivation: the key is never inferred from the model. The
 * same model can be reached through many keys, so a `(model, key)` pair is the
 * only unambiguous unit of selection.
 *
 * Returns null only when nothing is configured and no models are available.
 */
export function resolveModelSelection(params: {
  levels: ModelSelection[];
  availableModels: RankedModel[];
}): ModelSelection | null {
  const { levels, availableModels } = params;

  for (const level of levels) {
    if (level.modelId && level.apiKeyId) {
      return { modelId: level.modelId, apiKeyId: level.apiKeyId };
    }
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
